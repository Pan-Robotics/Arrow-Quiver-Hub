# Firmware Flash Flow — Audit Report (Updated)

**Date:** 2026-04-22 (updated after external field work)
**Scope:** `logs_ota_service.py` (companion Pi), `firmware_puller.lua` (FC Lua applet), `net_webserver_put.lua` (FC HTTP server)

---

## Executive Summary

The firmware flash pipeline has been simplified from a 3-tier architecture (Approach C → HTTP PUT → MAVFTP) to a **single-method architecture** using only **Approach C** (FC HTTP pull via `firmware_puller.lua`). This eliminates the complexity and failure modes of the MAVFTP and HTTP PUT fallback paths.

**Architecture (current):**

1. **Step 1:** Download firmware from Hub to Pi temp file
2. **Step 2:** HTTP-only pre-upload check (no MAVFTP cleanup)
3. **Step 3:** Start aiohttp server on port 8070, FC's `firmware_puller.lua` pulls the file
4. **Step 4:** Send MAVLink reboot command to trigger bootloader flash
5. **Step 5:** Poll FC webserver for up to 120s to confirm reboot + flash completion

**Key changes from previous 3-tier architecture:**
- Tier 2 (HTTP PUT via `net_webserver_put.lua`) and Tier 3 (MAVFTP upload) are no longer used in the flash path
- `_start_firmware_server()` now uses `Response` instead of `StreamResponse` (fixes `ClientConnectionResetError` with slow Lua readers)
- `_wait_for_fc_pull()` early-exit threshold is 30s (was 20s in previous audit fix)
- Step 4/5 replaced old bootloader stage file monitoring with MAVLink reboot + webserver polling
- Hard failures instead of fallthrough — each failure path returns `(False, error_msg)` immediately

---

## Previously Identified Issues — Status

### Issue #1 — `requests.get()` blocks the async event loop (HIGH) — FIXED
All blocking `requests` calls in the flash path now use `asyncio.to_thread()`.

### Issue #2 — Long wait when FC doesn't have `firmware_puller.lua` (HIGH) — FIXED
`_wait_for_fc_pull()` exits after 30s if no bytes served. Returns `False` with clear error message mentioning `firmware_puller.lua` and `FWPULL_ENABLE`.

### Issue #3 — `_check_file_exists()` MAVFTP fallback during monitoring (MEDIUM) — RESOLVED
Step 4/5 no longer use `_check_file_exists()`. The new architecture sends a MAVLink reboot command and polls the FC webserver directly.

### Issue #4 — `firmware_puller.lua` has no download timeout (MEDIUM) — FIXED
Added `STALL_TIMEOUT_MS = 30000` (30s stall timeout). Tracks `last_data_time` and aborts if no data received within the timeout.

### Issue #5 — `net_webserver_put.lua` PUT timeout too generous (MEDIUM) — FIXED
Reduced stall timeout to 30s. Partial file is deleted on timeout via `os.remove(put_path)`.

### Issue #6 — No download integrity verification (MEDIUM) — ACCEPTED
Content-Length check + bootloader CRC verification is sufficient. Documented as known limitation.

### Issue #7 — `net_webserver_put.lua` client slot leak (MEDIUM) — FIXED
Added `break` after client insertion in `check_new_clients()`.

### Issue #8 — `_http_fc_reachable()` downloads full HTML (LOW) — ACCEPTED
Minor overhead (~50ms). Not worth changing.

### Issue #9 — `MavFtpClient.connect()` hangs without heartbeat (LOW) — FIXED
Added `asyncio.timeout(15)` for heartbeat wait. Returns `False` on timeout.

### Issue #10 — Step 4 consumed-check threshold (LOW) — RESOLVED
Old Step 4 bootloader stage monitoring has been replaced entirely by MAVLink reboot + webserver polling.

### Issue #11 — Tier 1 server try/finally cleanup (LOW) — FIXED
`_wait_for_fc_pull()` is wrapped in `try/finally` to ensure `_stop_firmware_server()` is always called.

### Issue #12 — `firmware_puller.lua` docstring correction (LOW) — FIXED
Docstring updated.

---

## New Architecture Notes

### `_start_firmware_server()` — Response vs StreamResponse

The firmware server now uses `aiohttp.web.Response(body=data)` instead of `StreamResponse` with chunked writes. This fixes `ClientConnectionResetError` that occurred because ArduPilot's Lua TCP reader is slow (~4KB/s reads with 5ms sleep between cycles). With `StreamResponse`, the server would write chunks faster than the Lua reader could consume them, causing the connection to reset. With `Response`, the full body is buffered and sent at the reader's pace.

### Step 4/5 — MAVLink Reboot + Webserver Polling

The old Step 4 monitored bootloader stage files (`ardupilot-verify.abin`, `ardupilot-flash.abin`) via HTTP and MAVFTP. This was unreliable because:
- Stage files are transient and may not be visible via HTTP during reboot
- MAVFTP is unavailable during reboot
- The FC webserver is down during the flash process

The new approach:
1. **Step 4:** Send `system.action.reboot()` via MAVSDK. If the reboot command fails, prompt for manual reboot.
2. **Step 5:** Wait 5s for FC to go offline, then poll `_http_fc_reachable()` every 5s for up to 120s. When the FC webserver responds, the flash is complete.

### `firmware_puller.lua` — FC-Side Pull Architecture

The FC runs `firmware_puller.lua` as an ArduPilot Lua applet. It:
1. Polls `GET /firmware/status` on the companion Pi every 5s
2. When status is `ready`, opens `GET /firmware/download` to stream the firmware
3. Writes to `/APM/ardupilot.abin` in 4KB chunks
4. Sends `GET /firmware/ack` on completion
5. Has a 30s stall timeout (`STALL_TIMEOUT_MS`)

Configuration is via ArduPilot parameters:
- `FWPULL_ENABLE`: 0=disabled, 1=enabled
- `FWPULL_PI_IP0-3`: Companion Pi IP address octets
- `FWPULL_PORT`: HTTP server port (default 8070)

### `net_webserver_put.lua` — Still Available but Not Used for Flash

`net_webserver_put.lua` extends ArduPilot's stock `net_webserver.lua` with HTTP PUT support. It's still deployed on the FC for general file management but is no longer used in the firmware flash path. The stall timeout and client slot fixes remain in place for reliability.

---

## Remaining Risks

1. **Single point of failure:** With only Approach C available, if `firmware_puller.lua` is not installed or `FWPULL_ENABLE=0`, the flash fails immediately with no fallback. The error message is clear, but field operators must ensure the Lua script is deployed.

2. **No automatic retry:** If the flash fails (e.g., network hiccup during pull), the user must manually re-trigger from the dashboard. Consider adding automatic retry with exponential backoff.

3. **Manual reboot fallback:** If the MAVLink reboot command fails (e.g., MAVSDK connection lost), the user must manually reboot the FC. Step 5 will still detect the reboot via webserver polling.

4. **120s polling timeout:** If the FC takes longer than 120s to flash and reboot (e.g., very large firmware, slow SD card), Step 5 reports "completed" at 95% with a "check manually" message. This is acceptable but could be extended for known-slow hardware.
