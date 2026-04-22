# Firmware Flash Flow — Full Audit Report

**Date:** 2026-04-22
**Scope:** `logs_ota_service.py` (companion Pi), `firmware_puller.lua` (FC Lua applet), `net_webserver_put.lua` (FC HTTP server)

---

## Executive Summary

The 3-tier firmware flash pipeline is architecturally sound. The recent fixes (HTTP-safe cleanup, `ensure_ready()`, tier logging) addressed the most critical production failures. This audit identifies **12 remaining issues** — 3 high-severity, 5 medium, and 4 low — that could cause blocking, silent failures, or unnecessary delays in the field.

---

## Issue #1 — `requests.get()` blocks the async event loop (HIGH)

**File:** `logs_ota_service.py`, `handle_flash_firmware()` line ~1862
**Also affects:** `_http_upload_firmware()`, `_http_file_exists()`, `_http_fc_reachable()`

**Problem:** The `requests` library is synchronous. Every call to `requests.get()`, `requests.put()`, etc. blocks the entire asyncio event loop for the duration of the HTTP call. During Step 1 (firmware download from Hub, up to 120s timeout) and Tier 2 (HTTP PUT upload, up to 600s timeout), **all other async tasks are frozen** — including the job poll loop, diagnostics reporting, Socket.IO heartbeats, and log sync.

**Impact:**
- Socket.IO disconnects during long uploads (server-side heartbeat timeout is typically 25s)
- Hub thinks the companion is dead and may re-queue the job
- Diagnostics stop reporting, dashboard shows stale data
- If a second job arrives, it can't be acknowledged until the blocking call returns

**Fix:** Replace `requests` with `aiohttp.ClientSession` for all HTTP calls inside async methods, or use `asyncio.to_thread()` to offload blocking `requests` calls to a thread pool.

```python
# Option A: asyncio.to_thread (minimal change)
resp = await asyncio.to_thread(requests.get, firmware_url, timeout=120)

# Option B: aiohttp (better, already a dependency for Tier 1)
async with aiohttp.ClientSession() as session:
    async with session.get(firmware_url, timeout=aiohttp.ClientTimeout(total=120)) as resp:
        content = await resp.read()
```

**Recommendation:** Use `asyncio.to_thread()` for the quick fix (3 lines changed per call site). Migrate to `aiohttp.ClientSession` later for connection pooling and streaming.

---

## Issue #2 — Tier 1 waits 300s even when FC doesn't have `firmware_puller.lua` (HIGH)

**File:** `logs_ota_service.py`, `handle_flash_firmware()` line ~1964–1967

**Problem:** If `aiohttp_web` is installed on the Pi but `firmware_puller.lua` is **not** deployed on the FC (or `FWPULL_ENABLE=0`), Tier 1 starts the HTTP server successfully, then calls `_wait_for_fc_pull()` which blocks for up to **300 seconds** (5 minutes!) waiting for a pull that will never come. Only then does it fall through to Tier 2.

**Impact:** Every flash attempt wastes 5 minutes before trying the fast HTTP PUT path. On a drone in the field, this is unacceptable.

**Fix:** Add an early-exit heuristic to `_wait_for_fc_pull()`. If no bytes have been served after 15–20 seconds, the FC likely doesn't have the puller script. Abort early and fall through.

```python
# In _wait_for_fc_pull(), after the first few polls:
if elapsed >= 20 and self._fw_serve_bytes_sent == 0:
    logger.info("No FC pull activity after 20s — firmware_puller.lua "
                "may not be installed. Falling through to Tier 2.")
    return False
```

**Also consider:** Before starting the server, do a quick HTTP check to see if the FC has scripting enabled (check for `/APM/scripts/` directory listing via HTTP). If no scripts directory or no `firmware_puller.lua`, skip Tier 1 entirely.

---

## Issue #3 — `_check_file_exists()` falls back to MAVFTP during Step 4 monitoring (MEDIUM)

**File:** `logs_ota_service.py`, `_check_file_exists()` line ~1505–1512

**Problem:** During Step 4 (flash stage monitoring), `_check_file_exists()` is called every 2 seconds in a tight loop. If HTTP becomes unavailable (e.g., FC reboots mid-flash), it falls back to `self.ftp.file_exists()` which does a full MAVFTP `list_directory("/APM/")`. This is:
1. **Slow** (~1-2s per call over serial, eating into the 2s poll interval)
2. **Likely to fail** because the FC is rebooting (MAVFTP will throw exceptions)
3. **Unnecessary** because if the FC is rebooting, the flash is probably completing

**Fix:** During Step 4, if HTTP was available at the start but becomes unavailable, treat it as "FC is rebooting" rather than falling back to MAVFTP. Only use MAVFTP fallback if HTTP was never available.

```python
# In the Step 4 monitoring loop:
if using_http:
    http_result = self._http_file_exists(stage_file)
    if http_result is not None:
        exists = http_result
    else:
        # HTTP was available but now isn't — FC likely rebooting
        logger.info("FC HTTP unreachable during monitoring — FC may be rebooting")
        if current_stage_idx >= 1:  # Past verify stage
            # Treat as success
            ...
        continue  # Don't fall back to MAVFTP
else:
    exists = await self.ftp.file_exists(f"/APM/{stage_file}")
```

---

## Issue #4 — `firmware_puller.lua` has no download timeout (MEDIUM)

**File:** `firmware_puller.lua`, `download_firmware()` line ~318

**Problem:** The download state has no overall timeout. If the companion Pi's HTTP server stalls mid-transfer (e.g., Pi crashes, network drops), the Lua script will sit in `STATE_DOWNLOADING` indefinitely, checking `sock:recv()` every 5ms forever. The only exit is `reads_this_cycle == 0 and fw_bytes_received > 0` (connection closed), but if the TCP connection hangs without closing, this never triggers.

**Impact:** FC Lua VM has one script slot occupied by a stuck download. No retry possible until FC reboot.

**Fix:** Add a stall timer. If no new data arrives for 30 seconds, abort the download.

```lua
-- Add to download_firmware():
local STALL_TIMEOUT_MS = 30000
-- Track last data receipt time
if reads_this_cycle > 0 then
    last_data_time = millis()
end
if millis() - last_data_time > STALL_TIMEOUT_MS then
    abort(string.format("download stalled for %ds at %d/%d bytes",
        STALL_TIMEOUT_MS/1000, fw_bytes_received, fw_size_expected))
    return
end
```

---

## Issue #5 — `net_webserver_put.lua` PUT timeout is only 120s (MEDIUM)

**File:** `net_webserver_put.lua`, `receive_file()` line ~688

**Problem:** The PUT handler has a 120-second timeout (`now - start_time > 120000`). However, `start_time` is reset on every data receipt (line 705), so this is actually a **stall timeout**, not a total timeout. This is correct behavior, but 120s is very generous for a stall — if the companion Pi crashes mid-upload, the FC holds the file handle open for 2 minutes before cleaning up.

**Impact:** During those 2 minutes, the partially-written `ardupilot.abin` file exists on the SD card. If the FC reboots during this window, the bootloader may try to flash a corrupt partial file.

**Fix:** Reduce stall timeout to 30s (still generous for network hiccups). Also, on timeout, explicitly delete the partial file.

```lua
-- In receive_file(), change timeout and add cleanup:
if not sock:is_connected() or now - start_time > 30000 then
    gcs:send_text(MAV_SEVERITY.ERROR, ...)
    if put_file then
        put_file:close()
        put_file = nil
    end
    -- Delete partial file to prevent corrupt flash
    os.remove(path)  -- need to capture path from handle_put
    run = nil
    self.remove()
end
```

---

## Issue #6 — `firmware_puller.lua` doesn't verify downloaded file integrity (MEDIUM)

**File:** `firmware_puller.lua`, `download_firmware()` line ~393–414

**Problem:** After download completes, the script writes the file and sends an ack, but never verifies the file integrity. If a network glitch corrupts data mid-transfer, the FC will attempt to flash a corrupt firmware image. The bootloader's CRC check (`ardupilot-verify.abin` stage) should catch this, but if the CRC check itself has edge cases, the FC could be bricked.

**Impact:** Low probability but catastrophic outcome — bricked FC in the field.

**Fix:** The companion Pi's HTTP server already knows the file size and could serve an MD5/SHA-256 hash. Add a `/firmware/hash` endpoint and verify after download.

Alternatively, since the `.abin` format already contains an MD5 in its header, the Lua script could parse the header and verify the hash after writing. However, ArduPilot Lua doesn't have built-in MD5, so the simpler approach is to rely on the Content-Length check (already done) and the bootloader's CRC verification.

**Recommendation:** Accept current risk. The Content-Length check + bootloader CRC is sufficient. Document this as a known limitation.

---

## Issue #7 — `net_webserver_put.lua` client slot leak in `check_new_clients()` (MEDIUM)

**File:** `net_webserver_put.lua`, `check_new_clients()` line ~946–963

**Problem:** The client insertion loop has a subtle bug:

```lua
for i = 1, #clients+1 do
    if clients[i] == nil then
        local idx = i
        local client = Client(sock, idx)
        clients[idx] = client
    end
end
```

This loop doesn't `break` after inserting the client. It continues iterating and could insert the **same socket** into multiple slots if there are gaps in the array. Also, `check_clients()` uses `table.remove(clients, idx)` which shifts all subsequent indices, potentially causing clients to be skipped or double-processed in the same update cycle.

**Impact:** Under load (multiple simultaneous connections), clients could be orphaned or double-freed, causing the web server to become unresponsive.

**Fix:** Add `break` after client insertion. Replace `table.remove` with nil assignment and periodic compaction.

```lua
-- In check_new_clients():
for i = 1, #clients+1 do
    if clients[i] == nil then
        clients[i] = Client(sock, i)
        break  -- ← ADD THIS
    end
end
```

---

## Issue #8 — `_http_fc_reachable()` downloads the full HTML page (LOW)

**File:** `logs_ota_service.py`, `_http_fc_reachable()` line ~1241–1254

**Problem:** The method does `requests.get(self.fc_url, timeout=5, stream=True)` and then `resp.close()`. With `stream=True`, the response body isn't downloaded until you read it, so `resp.close()` should abort early. However, `requests` may still read some data before closing, and the FC's web server generates the full directory listing HTML before sending headers (no chunked encoding). This means the FC does the work of generating the HTML even though we discard it.

**Impact:** Minor — adds ~50ms latency per reachability check. Called multiple times during flash flow.

**Fix:** Use a `Range: bytes=0-0` request to a known small file (like `/APM/`) instead of the root page, similar to `_http_file_exists()`. Or just accept the minor overhead since it's only 5s timeout.

**Recommendation:** Accept as-is. The overhead is negligible compared to flash times.

---

## Issue #9 — `MavFtpClient.connect()` hangs if FC never sends heartbeat (LOW)

**File:** `logs_ota_service.py`, `MavFtpClient.connect()` line ~905–909

**Problem:** The `async for state in self.system.core.connection_state()` loop has no timeout. If the FC is powered off or the serial cable is disconnected, this loop runs forever, blocking the connect attempt. The `_initial_fc_connect()` method retries 12 times, but each attempt hangs indefinitely.

**Impact:** Service startup blocks forever if FC is offline. The job poll loop and diagnostics loop start via `asyncio.create_task()` so they still run, but `_initial_fc_connect()` consumes a task slot indefinitely.

**Fix:** Add a timeout to the heartbeat wait:

```python
async def connect(self) -> bool:
    ...
    try:
        async with asyncio.timeout(15):  # 15s heartbeat timeout
            async for state in self.system.core.connection_state():
                if state.is_connected:
                    self._connected = True
                    break
    except asyncio.TimeoutError:
        logger.warning("No FC heartbeat within 15s")
        return False
```

---

## Issue #10 — Step 4 "file consumed" check is too aggressive (LOW)

**File:** `logs_ota_service.py`, `handle_flash_firmware()` line ~2082–2093

**Problem:** After 30 seconds, if `ardupilot.abin` no longer exists but no stage file appeared, the code declares failure: "Firmware file consumed but no stage transition detected." However, the bootloader may take longer than 30 seconds to start processing on slow SD cards, especially if the FC is busy with other tasks. The file disappears when the bootloader renames it, but the rename to `ardupilot-verify.abin` and the next poll may not align.

**Impact:** False failure on slow SD cards or busy FCs.

**Fix:** Increase the threshold to 60 seconds, and check if the file was renamed (not just deleted):

```python
if elapsed > 60 and current_stage_idx == 0:
    if not await self._check_file_exists("ardupilot.abin"):
        # Check if it was renamed to verify (bootloader started)
        if await self._check_file_exists("ardupilot-verify.abin"):
            continue  # Bootloader is working, just slow
        error_msg = "Firmware file consumed but no stage transition detected"
        ...
```

---

## Issue #11 — `_stop_firmware_server()` not called on all Tier 1 failure paths (LOW)

**File:** `logs_ota_service.py`, `handle_flash_firmware()` line ~1963–1974

**Problem:** If `_start_firmware_server()` succeeds but then an exception is thrown before `_stop_firmware_server()` is called (e.g., `_wait_for_fc_pull()` raises an unexpected exception), the HTTP server keeps running on port 8070 indefinitely. The next flash attempt will fail to bind to the same port.

**Impact:** Subsequent flash attempts fail with "Address already in use" until the service restarts.

**Fix:** Wrap Tier 1 in a try/finally:

```python
if aiohttp_web:
    server_started = await self._start_firmware_server(tmp_path)
    if server_started:
        try:
            fc_pulled = await self._wait_for_fc_pull(update_id, ...)
        finally:
            await self._stop_firmware_server()
        if fc_pulled:
            upload_method = "HTTP pull (Approach C)"
            ...
```

---

## Issue #12 — `firmware_puller.lua` ack uses GET instead of POST (LOW)

**File:** `firmware_puller.lua`, line ~407–411

**Problem:** The ack is sent as a GET request (via `connect_to_pi("/firmware/ack")`), but the companion Pi's `_start_firmware_server()` registers it as `app.router.add_get("/firmware/ack", handle_ack)`. This works, but the docstring at the top of `firmware_puller.lua` says "POST /firmware/ack" (line 15). The inconsistency is confusing but not a bug since both sides use GET.

**Impact:** Documentation confusion only.

**Fix:** Update the docstring to say `GET /firmware/ack` instead of `POST /firmware/ack`.

---

## Summary Table

| # | Severity | Component | Issue | Blocking? |
|---|----------|-----------|-------|-----------|
| 1 | **HIGH** | `logs_ota_service.py` | `requests` blocks async event loop | Yes — freezes all tasks during HTTP calls |
| 2 | **HIGH** | `logs_ota_service.py` | Tier 1 waits 300s when FC has no puller | Yes — 5-minute delay per flash |
| 3 | MEDIUM | `logs_ota_service.py` | Step 4 MAVFTP fallback during FC reboot | Partial — unnecessary errors in logs |
| 4 | MEDIUM | `firmware_puller.lua` | No download stall timeout | Yes — stuck forever on network hang |
| 5 | MEDIUM | `net_webserver_put.lua` | 120s stall timeout too generous | Partial — corrupt file risk window |
| 6 | MEDIUM | `firmware_puller.lua` | No file integrity verification | No — bootloader CRC covers this |
| 7 | MEDIUM | `net_webserver_put.lua` | Client slot leak (missing `break`) | Partial — under concurrent load |
| 8 | LOW | `logs_ota_service.py` | `_http_fc_reachable()` downloads full page | No — minor latency |
| 9 | LOW | `logs_ota_service.py` | `connect()` hangs without heartbeat timeout | Partial — blocks connect task |
| 10 | LOW | `logs_ota_service.py` | Step 4 "consumed" check too aggressive | Partial — false failures on slow SD |
| 11 | LOW | `logs_ota_service.py` | Firmware server not stopped on exception | Partial — port leak on next attempt |
| 12 | LOW | `firmware_puller.lua` | Docstring says POST, code uses GET | No — documentation only |

---

## Recommended Fix Priority

1. **Issue #2** — Add early-exit to `_wait_for_fc_pull()` (5 lines, immediate impact)
2. **Issue #1** — Wrap `requests` calls in `asyncio.to_thread()` (6 call sites)
3. **Issue #11** — Add try/finally around Tier 1 server (3 lines)
4. **Issue #7** — Add `break` to `check_new_clients()` (1 line)
5. **Issue #4** — Add stall timeout to `firmware_puller.lua` (8 lines)
6. **Issue #10** — Increase consumed-check threshold + verify rename (5 lines)
7. **Issue #9** — Add heartbeat timeout to `connect()` (4 lines)
8. **Issue #3** — Smarter Step 4 monitoring (15 lines)
9. **Issue #5** — Reduce PUT stall timeout + cleanup partial file (5 lines)
10. **Issue #12** — Fix docstring (1 line)
