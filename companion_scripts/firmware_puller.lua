--[[
   ArduPilot Lua applet: Firmware Puller (OTA via HTTP GET) — DEBUG BUILD
   Adds GCS messages at every stage for troubleshooting.
   Import firmware_puller.param generated from the companion .env before enabling.
   FC Lua cannot read the Pi filesystem; existing saved FWPULL parameters persist.
--]]

---@diagnostic disable: param-type-mismatch
---@diagnostic disable: undefined-field
---@diagnostic disable: need-check-nil

local MAV_SEVERITY = {EMERGENCY=0, ALERT=1, CRITICAL=2, ERROR=3, WARNING=4, NOTICE=5, INFO=6, DEBUG=7}

PARAM_TABLE_KEY = 48
PARAM_TABLE_PREFIX = "FWPULL_"

function bind_add_param(name, idx, default_value)
    assert(param:add_param(PARAM_TABLE_KEY, idx, name, default_value),
           string.format('could not add param %s', name))
    return Parameter(PARAM_TABLE_PREFIX .. name)
end

assert(param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 6),
       'firmware_puller: could not add param table')

local FWPULL_ENABLE = bind_add_param("ENABLE", 1, 0)
-- No network address is baked into this applet. Configure via generated params.
local FWPULL_PI_IP0 = bind_add_param("PI_IP0", 2, 0)
local FWPULL_PI_IP1 = bind_add_param("PI_IP1", 3, 0)
local FWPULL_PI_IP2 = bind_add_param("PI_IP2", 4, 0)
local FWPULL_PI_IP3 = bind_add_param("PI_IP3", 5, 0)
local FWPULL_PORT   = bind_add_param("PORT",   6, 8070)

local POLL_INTERVAL_MS = 5000
local DOWNLOAD_CHUNK = 4096
local MAX_FIRMWARE_SIZE = 16 * 1024 * 1024
local WRITE_DEST = "/APM/ardupilot.abin"
local WRITE_STAGE = "/APM/.ardupilot.abin.part"

-- ArduPilot's documented scripting sandbox exposes io and a global remove()
-- binding, but not the os library or a documented atomic rename binding.  Do
-- not truncate WRITE_DEST unless a target-specific ArduPilot API has first
-- been verified to provide atomic staged-file promotion.  The shipped applet
-- therefore disables transfers fail-closed rather than risking a partial
-- bootloader-consumed file.  A qualified platform port may set this true only
-- together with the guarded os.rename implementation below.
local RENAME_SUPPORTED = false

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
local last_data_time = 0
local STALL_TIMEOUT_MS = 30000
local STATUS_TIMEOUT_MS = 10000
local status_started_time = 0
local poll_count = 0

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

local function remove_stage()
    pcall(function()
        if type(remove) == "function" then
            remove(WRITE_STAGE)
        end
    end)
end

local function cleanup()
    if sock then sock:close(); sock = nil end
    if fw_file then fw_file:close(); fw_file = nil end
    http_buf = ""
    header_done = false
    fw_bytes_received = 0
    fw_size_expected = 0
    last_progress_kb = 0
    last_data_time = 0
    status_started_time = 0
end

local function abort(msg)
    gcs:send_text(MAV_SEVERITY.ERROR, "FWPull: ABORT: " .. msg)
    cleanup()
    -- Never delete or truncate an existing bootloader candidate on an abort.
    remove_stage()
    state = STATE_IDLE
end

local function freshly_disarmed()
    local ok, armed = pcall(function() return arming:is_armed() end)
    if not ok or armed == nil then
        return false, "arming state unavailable"
    end
    if armed then
        return false, "vehicle is armed"
    end
    return true, nil
end

local function promote_stage()
    if not RENAME_SUPPORTED then
        return false, "atomic rename unavailable in this ArduPilot Lua sandbox"
    end
    if type(os) ~= "table" or type(os.rename) ~= "function" then
        return false, "verified atomic rename API unavailable"
    end
    local ok, err = os.rename(WRITE_STAGE, WRITE_DEST)
    if not ok then
        return false, "staged rename failed: " .. tostring(err)
    end
    return true, nil
end

local function build_http_get(host, port, path)
    return string.format(
        "GET %s HTTP/1.0\r\nHost: %s:%d\r\nConnection: close\r\n\r\n",
        path, host, port)
end

local function connect_to_pi(path)
    local ip = get_pi_ip()
    local port = get_pi_port()

    gcs:send_text(MAV_SEVERITY.DEBUG, string.format("FWPull: connecting %s:%d%s", ip, port, path))

    local s = Socket(0)
    if not s then
        gcs:send_text(MAV_SEVERITY.ERROR, "FWPull: Socket() returned nil")
        return nil, "failed to create socket"
    end

    if not s:connect(ip, port) then
        gcs:send_text(MAV_SEVERITY.WARNING, string.format("FWPull: connect failed %s:%d", ip, port))
        s:close()
        return nil, string.format("connect failed to %s:%d", ip, port)
    end

    gcs:send_text(MAV_SEVERITY.DEBUG, string.format("FWPull: connected, sending GET %s", path))

    local req = build_http_get(ip, port, path)
    local sent = s:send(req, #req)
    if sent ~= #req then
        gcs:send_text(MAV_SEVERITY.ERROR, "FWPull: send() failed")
        s:close()
        return nil, "failed to send HTTP request"
    end

    return s, nil
end

local function parse_http_response(buf)
    local header_end = string.find(buf, "\r\n\r\n")
    if not header_end then
        return nil, nil, nil
    end
    local status_line = string.match(buf, "^(.-)\r\n")
    if not status_line then
        return nil, nil, nil
    end
    local status_code = tonumber(string.match(status_line, "HTTP/%d%.%d (%d+)"))
    local content_length = tonumber(string.match(buf, "[Cc]ontent%-[Ll]ength:%s*(%d+)"))
    return status_code, header_end + 4, content_length
end

local function poll_status()
    if FWPULL_ENABLE:get() < 1 then
        return
    end

    -- An enabled applet with unset/invalid target parameters must stay idle.
    local octets = {FWPULL_PI_IP0:get(), FWPULL_PI_IP1:get(),
                    FWPULL_PI_IP2:get(), FWPULL_PI_IP3:get()}
    for index, octet in ipairs(octets) do
        if octet < 0 or octet > 255 or octet ~= math.floor(octet)
                or (index == 1 and (octet == 0 or octet >= 224)) then
            gcs:send_text(MAV_SEVERITY.WARNING, "FWPull: configure target from firmware_puller.param")
            return
        end
    end
    if get_pi_port() < 1 or get_pi_port() > 65535 then
        gcs:send_text(MAV_SEVERITY.WARNING, "FWPull: configure FWPULL_PORT from companion .env")
        return
    end

    poll_count = poll_count + 1
    -- Log every 12th poll (~60s) so we know the script is alive
    if poll_count % 12 == 1 then
        gcs:send_text(MAV_SEVERITY.INFO, string.format("FWPull: polling %s:%d (cycle %d)",
            get_pi_ip(), get_pi_port(), poll_count))
    end

    local s, err = connect_to_pi("/firmware/status")
    if not s then
        -- Only log every 12th failure to avoid spam
        if poll_count % 12 == 1 then
            gcs:send_text(MAV_SEVERITY.WARNING, string.format("FWPull: Pi unreachable (%s)", err or "unknown"))
        end
        return
    end

    gcs:send_text(MAV_SEVERITY.INFO, "FWPull: status request sent, waiting for response")
    sock = s
    state = STATE_CHECKING
    http_buf = ""
    header_done = false
    status_started_time = millis()
end

local function check_status()
    if not sock then
        state = STATE_IDLE
        return
    end

    if status_started_time > 0 and (millis() - status_started_time) > STATUS_TIMEOUT_MS then
        gcs:send_text(MAV_SEVERITY.WARNING, "FWPull: status request timed out")
        cleanup()
        state = STATE_IDLE
        return
    end

    local data = sock:recv(1024)
    if data then
        http_buf = http_buf .. data
    elseif not sock:is_connected() then
        gcs:send_text(MAV_SEVERITY.WARNING, "FWPull: status connection closed")
        cleanup()
        state = STATE_IDLE
        return
    end

    local status_code, body_start, _ = parse_http_response(http_buf)
    if not status_code then
        if #http_buf > 4096 then
            abort("status response too large")
        end
        return
    end

    gcs:send_text(MAV_SEVERITY.INFO, string.format("FWPull: status HTTP %d, body %d bytes",
        status_code, #http_buf - body_start + 1))

    if status_code ~= 200 then
        gcs:send_text(MAV_SEVERITY.WARNING, string.format("FWPull: status returned %d, not 200", status_code))
        cleanup()
        state = STATE_IDLE
        return
    end

    local body = string.sub(http_buf, body_start)
    cleanup()

    gcs:send_text(MAV_SEVERITY.DEBUG, string.format("FWPull: status body: %s", string.sub(body, 1, 80)))

    local ready = string.match(body, '"ready"%s*:%s*(true)')
    if not ready then
        gcs:send_text(MAV_SEVERITY.INFO, "FWPull: not ready (ready!=true)")
        state = STATE_IDLE
        return
    end

    local size_str = string.match(body, '"size"%s*:%s*(%d+)')
    fw_size_expected = tonumber(size_str) or 0

    if fw_size_expected <= 0 or fw_size_expected > MAX_FIRMWARE_SIZE then
        gcs:send_text(MAV_SEVERITY.WARNING,
            string.format("FWPull: invalid size %d", fw_size_expected))
        state = STATE_IDLE
        return
    end

    local safe, arm_err = freshly_disarmed()
    if not safe then
        gcs:send_text(MAV_SEVERITY.WARNING, "FWPull: upload denied: " .. arm_err)
        state = STATE_IDLE
        return
    end

    if not RENAME_SUPPORTED then
        -- Do not fall back to opening WRITE_DEST: a reset would leave a
        -- bootloader-visible partial firmware file.  Promotion is intentionally
        -- disabled until this FC's Lua API has an audited atomic rename path.
        gcs:send_text(MAV_SEVERITY.ERROR,
            "FWPull: upload disabled; atomic staged rename not available")
        state = STATE_IDLE
        return
    end

    gcs:send_text(MAV_SEVERITY.INFO,
        string.format("FWPull: firmware ready (%d KB), starting download",
                       math.floor(fw_size_expected / 1024)))

    remove_stage()
    fw_file = io.open(WRITE_STAGE, "wb")
    if not fw_file then
        abort("cannot open staging file " .. WRITE_STAGE)
        return
    end

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
    last_data_time = millis()
    gcs:send_text(MAV_SEVERITY.INFO, "FWPull: download connection open, receiving...")
end

local function write_firmware_chunk(data)
    if #data == 0 then
        return true
    end
    if fw_bytes_received + #data > fw_size_expected then
        abort(string.format("body exceeds expected size: %d + %d > %d",
            fw_bytes_received, #data, fw_size_expected))
        return false
    end
    local ok, err = fw_file:write(data)
    if not ok then
        abort("staging write failed: " .. tostring(err))
        return false
    end
    fw_bytes_received = fw_bytes_received + #data
    return true
end

local function finish_download()
    if fw_bytes_received ~= fw_size_expected then
        abort(string.format("incomplete: %d / %d bytes", fw_bytes_received, fw_size_expected))
        return
    end
    local flush_ok, flush_err = fw_file:flush()
    if not flush_ok then
        abort("staging flush failed: " .. tostring(flush_err))
        return
    end
    local close_ok, close_err = fw_file:close()
    fw_file = nil
    if not close_ok then
        abort("staging close failed: " .. tostring(close_err))
        return
    end
    if sock then sock:close(); sock = nil end

    -- Re-sample immediately before making the staged firmware bootloader-visible.
    local safe, arm_err = freshly_disarmed()
    if not safe then
        abort("promotion denied: " .. arm_err)
        return
    end
    local promoted, promote_err = promote_stage()
    if not promoted then
        abort(promote_err)
        return
    end

    gcs:send_text(MAV_SEVERITY.INFO,
        string.format("FWPull: DONE — %d KB → %s", math.floor(fw_bytes_received / 1024), WRITE_DEST))
    gcs:send_text(MAV_SEVERITY.NOTICE, "FWPull: reboot to flash firmware")
    local ack_sock, ack_err = connect_to_pi("/firmware/ack")
    if not ack_sock then
        -- Durable local promotion completed, but never claim delivery to the
        -- companion without the close-after-completion ACK request.
        gcs:send_text(MAV_SEVERITY.ERROR, "FWPull: ACK send failed: " .. tostring(ack_err))
        state = STATE_IDLE
        return
    end
    ack_sock:close()
    state = STATE_DONE
end

local function download_firmware()
    if not sock or not fw_file then
        abort("invalid download state")
        return
    end

    if last_data_time > 0 and (millis() - last_data_time) > STALL_TIMEOUT_MS then
        abort(string.format("stalled %ds at %d/%d bytes",
            STALL_TIMEOUT_MS / 1000, fw_bytes_received, fw_size_expected))
        return
    end

    local reads_this_cycle = 0
    local max_reads = 32

    while reads_this_cycle < max_reads do
        local data = sock:recv(DOWNLOAD_CHUNK)
        if not data or #data == 0 then
            if not sock:is_connected() then
                abort(string.format("connection closed at %d / %d bytes",
                    fw_bytes_received, fw_size_expected))
                return
            end
            break
        end
        reads_this_cycle = reads_this_cycle + 1

        if not header_done then
            http_buf = http_buf .. data
            local status_code, body_start, content_length = parse_http_response(http_buf)
            if status_code then
                if status_code ~= 200 then
                    abort(string.format("download HTTP %d", status_code))
                    return
                end
                if not content_length or content_length ~= fw_size_expected or
                        content_length <= 0 or content_length > MAX_FIRMWARE_SIZE then
                    abort(string.format("Content-Length mismatch: status=%d download=%s",
                        fw_size_expected, tostring(content_length)))
                    return
                end
                header_done = true
                gcs:send_text(MAV_SEVERITY.INFO, string.format("FWPull: download headers OK, CL=%d",
                    content_length))
                local body_data = string.sub(http_buf, body_start)
                http_buf = ""
                if not write_firmware_chunk(body_data) then
                    return
                end
            elseif #http_buf > 8192 then
                abort("download headers too large")
                return
            end
        else
            if not write_firmware_chunk(data) then
                return
            end
        end

        if header_done and fw_bytes_received == fw_size_expected then
            finish_download()
            return
        end
    end

    if reads_this_cycle > 0 then
        last_data_time = millis()
    end

    if fw_file and fw_bytes_received > 0 then
        local flush_ok, flush_err = fw_file:flush()
        if not flush_ok then
            abort("staging flush failed: " .. tostring(flush_err))
            return
        end
    end

    -- Progress every 100KB
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
                          current_kb, math.floor(fw_size_expected / 1024), pct))
    end

end

local function update()
    if FWPULL_ENABLE:get() < 1 then
        if state ~= STATE_IDLE then
            cleanup()
            state = STATE_IDLE
        end
        return update, 1000
    end

    if state == STATE_IDLE then
        poll_status()
    elseif state == STATE_CHECKING then
        check_status()
    elseif state == STATE_DOWNLOADING then
        download_firmware()
    elseif state == STATE_DONE then
        return update, 30000
    end

    if state == STATE_DOWNLOADING then
        return update, 5
    else
        return update, POLL_INTERVAL_MS
    end
end

gcs:send_text(MAV_SEVERITY.NOTICE,
    string.format("FWPull: LOADED OK — target %s:%d enable=%d",
                   get_pi_ip(), get_pi_port(), math.floor(FWPULL_ENABLE:get())))

return update, 2000
