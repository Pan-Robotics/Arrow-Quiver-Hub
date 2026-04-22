--[[
   ArduPilot Lua applet: Firmware Puller (OTA via HTTP GET)

   Polls a companion computer's HTTP endpoint for new firmware, downloads it
   via HTTP GET, and writes it to /APM/ardupilot.abin on the SD card. The
   ArduPilot bootloader then picks it up on next reboot.

   This avoids slow MAVFTP uploads (~5 KB/s) by using the FC's Ethernet
   connection at full speed (~650 KB/s).

   ARCHITECTURE:
     Companion Pi runs a lightweight HTTP server on port 8070:
       GET /firmware/status  → {"ready": true, "filename": "ardupilot.abin", "size": 1656690}
       GET /firmware/download → streams the firmware binary
       GET  /firmware/ack    → companion Pi marks download complete and cleans up

     This Lua script polls /firmware/status every FWPULL_POLL_SEC seconds.
     When ready=true, it downloads the file and writes it to the SD card.

   DEPLOYMENT:
     1. Copy this file to FC SD card: APM/scripts/firmware_puller.lua
     2. Set SCR_ENABLE=1, reboot FC
     3. Set FWPULL_ENABLE=1 (parameter added by this script)
     4. Set FWPULL_PI_IP to the companion Pi's IP (default: 192.168.144.20)

   PARAMETERS:
     FWPULL_ENABLE  - Enable/disable the firmware puller (0=off, 1=on)
     FWPULL_PI_IP   - Companion Pi IP address (stored as 4 octets packed into uint32)
     FWPULL_PORT    - Companion Pi firmware server port (default: 8070)
     FWPULL_POLL    - Poll interval in seconds (default: 5)

   FLOW:
     1. Poll GET http://<pi_ip>:<port>/firmware/status
     2. If {"ready": true}, proceed to download
     3. GET http://<pi_ip>:<port>/firmware/download
     4. Write response body to /APM/ardupilot.abin in 4KB chunks
     5. GET http://<pi_ip>:<port>/firmware/ack to signal completion
     6. Send GCS message: "FWPull: downloaded <size> bytes, reboot to flash"
--]]

---@diagnostic disable: param-type-mismatch
---@diagnostic disable: undefined-field
---@diagnostic disable: need-check-nil

local MAV_SEVERITY = {EMERGENCY=0, ALERT=1, CRITICAL=2, ERROR=3, WARNING=4, NOTICE=5, INFO=6, DEBUG=7}

-- ── Parameter Table ──
-- Use a unique table key that doesn't conflict with net_webserver (47)
PARAM_TABLE_KEY = 48
PARAM_TABLE_PREFIX = "FWPULL_"

function bind_add_param(name, idx, default_value)
    assert(param:add_param(PARAM_TABLE_KEY, idx, name, default_value),
           string.format('could not add param %s', name))
    return Parameter(PARAM_TABLE_PREFIX .. name)
end

assert(param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 6),
       'firmware_puller: could not add param table')

--[[
  // @Param: FWPULL_ENABLE
  // @DisplayName: Enable firmware puller
  // @Description: Enable polling companion Pi for firmware updates
  // @Values: 0:Disabled, 1:Enabled
  // @User: Standard
--]]
local FWPULL_ENABLE = bind_add_param("ENABLE", 1, 0)

--[[
  // @Param: FWPULL_PI_IP0
  // @DisplayName: Companion Pi IP octet 1
  // @Description: First octet of companion Pi IP (e.g., 192 for 192.168.144.20)
  // @Range: 0 255
  // @User: Standard
--]]
local FWPULL_PI_IP0 = bind_add_param("PI_IP0", 2, 192)

--[[
  // @Param: FWPULL_PI_IP1
  // @DisplayName: Companion Pi IP octet 2
  // @Range: 0 255
--]]
local FWPULL_PI_IP1 = bind_add_param("PI_IP1", 3, 168)

--[[
  // @Param: FWPULL_PI_IP2
  // @DisplayName: Companion Pi IP octet 3
  // @Range: 0 255
--]]
local FWPULL_PI_IP2 = bind_add_param("PI_IP2", 4, 144)

--[[
  // @Param: FWPULL_PI_IP3
  // @DisplayName: Companion Pi IP octet 4
  // @Range: 0 255
--]]
local FWPULL_PI_IP3 = bind_add_param("PI_IP3", 5, 20)

--[[
  // @Param: FWPULL_PORT
  // @DisplayName: Companion Pi firmware server port
  // @Description: TCP port where companion Pi serves firmware
  // @Range: 1024 65535
  // @User: Standard
--]]
local FWPULL_PORT = bind_add_param("PORT", 6, 8070)

-- ── Constants ──
local POLL_INTERVAL_MS = 5000     -- 5 seconds between status polls
local DOWNLOAD_CHUNK = 4096       -- 4KB read chunks during download
local MAX_FIRMWARE_SIZE = 16 * 1024 * 1024  -- 16MB safety limit
local WRITE_DEST = "/APM/ardupilot.abin"

-- ── State ──
local STATE_IDLE = 0
local STATE_CHECKING = 1
local STATE_DOWNLOADING = 2
local STATE_DONE = 3

local state = STATE_IDLE
local sock = nil
local fw_file = nil
local fw_size_expected = 0
local fw_bytes_received = 0
local last_progress_kb = 0
local http_buf = ""
local header_done = false
local pi_url_base = ""
local last_data_time = 0
local STALL_TIMEOUT_MS = 30000  -- abort download if no data for 30s

-- ── Helpers ──

local function get_pi_ip()
    return string.format("%d.%d.%d.%d",
        math.floor(FWPULL_PI_IP0:get()),
        math.floor(FWPULL_PI_IP1:get()),
        math.floor(FWPULL_PI_IP2:get()),
        math.floor(FWPULL_PI_IP3:get()))
end

local function get_pi_port()
    return math.floor(FWPULL_PORT:get())
end

local function cleanup()
    if sock then
        sock:close()
        sock = nil
    end
    if fw_file then
        fw_file:close()
        fw_file = nil
    end
    http_buf = ""
    header_done = false
    fw_bytes_received = 0
    fw_size_expected = 0
    last_progress_kb = 0
end

local function abort(msg)
    gcs:send_text(MAV_SEVERITY.ERROR, "FWPull: " .. msg)
    cleanup()
    -- Remove partial file
    os.remove(WRITE_DEST)
    state = STATE_IDLE
end

-- Simple HTTP GET request builder
local function build_http_get(host, port, path)
    return string.format(
        "GET %s HTTP/1.0\r\nHost: %s:%d\r\nConnection: close\r\n\r\n",
        path, host, port)
end

-- Connect a TCP socket to the companion Pi
local function connect_to_pi(path)
    local ip = get_pi_ip()
    local port = get_pi_port()

    local s = Socket(0)  -- TCP
    if not s then
        return nil, "failed to create socket"
    end

    if not s:connect(ip, port) then
        s:close()
        return nil, string.format("connect failed to %s:%d", ip, port)
    end

    -- Send HTTP GET request
    local req = build_http_get(ip, port, path)
    if not s:send(req, #req) then
        s:close()
        return nil, "failed to send HTTP request"
    end

    return s, nil
end

-- Parse HTTP response status line from buffer
-- Returns: status_code (number), header_end_pos (number) or nil
local function parse_http_response(buf)
    local header_end = string.find(buf, "\r\n\r\n")
    if not header_end then
        return nil, nil, nil  -- headers not complete yet
    end

    local status_line = string.match(buf, "^(.-)\r\n")
    if not status_line then
        return nil, nil, nil
    end

    local status_code = tonumber(string.match(status_line, "HTTP/%d%.%d (%d+)"))
    
    -- Extract Content-Length if present
    local content_length = tonumber(string.match(buf, "[Cc]ontent%-[Ll]ength:%s*(%d+)"))

    return status_code, header_end + 4, content_length  -- +4 for \r\n\r\n
end

-- ── State: IDLE → check if firmware is available ──
local function poll_status()
    if FWPULL_ENABLE:get() < 1 then
        return  -- disabled
    end

    local s, err = connect_to_pi("/firmware/status")
    if not s then
        -- Companion Pi not reachable, silently retry next cycle
        return
    end

    sock = s
    state = STATE_CHECKING
    http_buf = ""
    header_done = false
end

-- ── State: CHECKING → read status response ──
local function check_status()
    if not sock then
        state = STATE_IDLE
        return
    end

    local data = sock:recv(1024)
    if data then
        http_buf = http_buf .. data
    end

    -- Try to parse the full response
    local status_code, body_start, _ = parse_http_response(http_buf)
    if not status_code then
        -- Headers not complete yet, wait for more data
        if #http_buf > 4096 then
            abort("status response too large")
        end
        return
    end

    if status_code ~= 200 then
        cleanup()
        state = STATE_IDLE
        return
    end

    -- Extract body
    local body = string.sub(http_buf, body_start)
    cleanup()

    -- Parse JSON-like response: look for "ready": true and "size": <number>
    -- ArduPilot Lua doesn't have a JSON parser, so we use pattern matching
    local ready = string.match(body, '"ready"%s*:%s*(true)')
    if not ready then
        state = STATE_IDLE
        return
    end

    local size_str = string.match(body, '"size"%s*:%s*(%d+)')
    fw_size_expected = tonumber(size_str) or 0

    if fw_size_expected <= 0 or fw_size_expected > MAX_FIRMWARE_SIZE then
        gcs:send_text(MAV_SEVERITY.WARNING,
            string.format("FWPull: invalid firmware size %d", fw_size_expected))
        state = STATE_IDLE
        return
    end

    -- Firmware is ready — start download
    gcs:send_text(MAV_SEVERITY.INFO,
        string.format("FWPull: firmware available (%d KB), downloading...",
                       math.floor(fw_size_expected / 1024)))

    -- Open destination file
    fw_file = io.open(WRITE_DEST, "wb")
    if not fw_file then
        abort("cannot open " .. WRITE_DEST .. " for writing")
        return
    end

    -- Connect to download endpoint
    local s, err = connect_to_pi("/firmware/download")
    if not s then
        abort("download connect failed: " .. (err or "unknown"))
        return
    end

    sock = s
    state = STATE_DOWNLOADING
    http_buf = ""
    header_done = false
    fw_bytes_received = 0
    last_progress_kb = 0
    last_data_time = millis()  -- initialize stall timer
end

-- ── State: DOWNLOADING → receive firmware data and write to SD ──
local function download_firmware()
    if not sock or not fw_file then
        abort("invalid download state")
        return
    end

    -- Stall detection: abort if no data received for 30 seconds
    if last_data_time > 0 and (millis() - last_data_time) > STALL_TIMEOUT_MS then
        abort(string.format("download stalled for %ds at %d/%d bytes",
            STALL_TIMEOUT_MS / 1000, fw_bytes_received, fw_size_expected))
        return
    end

    -- Read multiple chunks per cycle for speed
    local reads_this_cycle = 0
    local max_reads = 32  -- up to 128KB per 5ms cycle

    while reads_this_cycle < max_reads do
        local data = sock:recv(DOWNLOAD_CHUNK)
        if not data or #data == 0 then
            break
        end
        reads_this_cycle = reads_this_cycle + 1

        if not header_done then
            -- Accumulate until we have full headers
            http_buf = http_buf .. data

            local status_code, body_start, content_length = parse_http_response(http_buf)
            if status_code then
                if status_code ~= 200 then
                    abort(string.format("download returned HTTP %d", status_code))
                    return
                end

                header_done = true

                -- Use Content-Length from download response if available
                if content_length and content_length > 0 then
                    fw_size_expected = content_length
                end

                -- Write any body data that came with the headers
                local body_data = string.sub(http_buf, body_start)
                if #body_data > 0 then
                    fw_file:write(body_data)
                    fw_bytes_received = fw_bytes_received + #body_data
                end
                http_buf = ""  -- free memory
            elseif #http_buf > 8192 then
                abort("download headers too large")
                return
            end
        else
            -- Body data — write directly to file
            fw_file:write(data)
            fw_bytes_received = fw_bytes_received + #data
        end
    end

    -- Track last data receipt time for stall detection
    if reads_this_cycle > 0 then
        last_data_time = millis()
    end

    -- Flush to SD card once per cycle (not per chunk)
    if fw_file and fw_bytes_received > 0 then
        fw_file:flush()
    end

    -- Progress logging every 100KB
    local current_kb = math.floor(fw_bytes_received / 1024)
    local progress_step = math.floor(current_kb / 100)
    if progress_step > last_progress_kb then
        last_progress_kb = progress_step
        local pct = 0
        if fw_size_expected > 0 then
            pct = math.floor(fw_bytes_received * 100 / fw_size_expected)
        end
        gcs:send_text(MAV_SEVERITY.INFO,
            string.format("FWPull: %dKB / %dKB (%d%%)",
                          current_kb,
                          math.floor(fw_size_expected / 1024),
                          pct))
    end

    -- Check if download is complete
    if fw_size_expected > 0 and fw_bytes_received >= fw_size_expected then
        -- Download complete
        fw_file:close()
        fw_file = nil
        sock:close()
        sock = nil

        gcs:send_text(MAV_SEVERITY.INFO,
            string.format("FWPull: download complete — %d KB written to %s",
                          math.floor(fw_bytes_received / 1024), WRITE_DEST))
        gcs:send_text(MAV_SEVERITY.NOTICE,
            "FWPull: reboot to flash firmware")

        -- Acknowledge to companion Pi (best-effort, non-blocking)
        local ack_sock, _ = connect_to_pi("/firmware/ack")
        if ack_sock then
            -- Fire and forget — the GET request is sent in connect_to_pi
            ack_sock:close()
        end

        state = STATE_DONE
        return
    end

    -- Check for connection closed before expected size
    if reads_this_cycle == 0 and fw_bytes_received > 0 then
        -- Socket returned no data — connection may be closed
        if fw_size_expected > 0 and fw_bytes_received < fw_size_expected then
            abort(string.format("download incomplete: %d / %d bytes",
                                fw_bytes_received, fw_size_expected))
        else
            -- No expected size or got enough data — treat as complete
            fw_file:close()
            fw_file = nil
            sock:close()
            sock = nil
            gcs:send_text(MAV_SEVERITY.INFO,
                string.format("FWPull: download complete — %d KB",
                              math.floor(fw_bytes_received / 1024)))
            state = STATE_DONE
        end
    end
end

-- ── Main update loop ──
local function update()
    if FWPULL_ENABLE:get() < 1 then
        if state ~= STATE_IDLE then
            cleanup()
            state = STATE_IDLE
        end
        return update, 1000  -- check enable flag every 1s
    end

    if state == STATE_IDLE then
        poll_status()
    elseif state == STATE_CHECKING then
        check_status()
    elseif state == STATE_DOWNLOADING then
        download_firmware()
    elseif state == STATE_DONE then
        -- Wait before polling again (firmware is on SD, waiting for reboot)
        -- Don't poll again until re-enabled or rebooted
        return update, 30000  -- check every 30s after completion
    end

    -- Fast cycle during active download, slower otherwise
    if state == STATE_DOWNLOADING then
        return update, 5  -- 5ms for fast download
    else
        return update, POLL_INTERVAL_MS
    end
end

-- ── Entry point ──
gcs:send_text(MAV_SEVERITY.INFO,
    string.format("FWPull: ready (poll %s:%d every %ds)",
                   get_pi_ip(), get_pi_port(),
                   math.floor(POLL_INTERVAL_MS / 1000)))

return update, 2000
