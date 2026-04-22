# Quiver OTA Firmware Update — Setup & Implementation Guide

## Overview

Remote Over-The-Air (OTA) firmware updates for the Pixhawk 6C flight controller via the onboard Raspberry Pi companion computer. Firmware is pushed from the Quiver Hub dashboard, downloaded by the Pi, and pulled by the FC at Ethernet speed (~650 KB/s). Total flash time: **~33 seconds** from job trigger to verified reboot.

### Architecture

```
Hub Dashboard → (HTTPS) → Pi downloads .abin
                           Pi serves on HTTP :8070
FC (firmware_puller.lua) → (HTTP GET) → pulls from Pi :8070
                           writes to /APM/ardupilot.abin
Pi sends MAVLink reboot → FC reboots
                           Bootloader flashes firmware
Pi polls FC webserver   → FC back online → "completed"
```

---

## FC Parameters Modified

### Scripting (required for Lua scripts)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SCR_ENABLE` | `1` | Enable Lua scripting engine. **Requires reboot after setting.** |
| `SCR_HEAP_SIZE` | `204800` | 200KB heap for Lua VM (default may be too small with multiple scripts) |

### Firmware Puller (firmware_puller.lua)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `FWPULL_ENABLE` | `1` | Enable firmware polling from companion Pi |
| `FWPULL_PI_IP0` | `192` | Pi IP address octet 1 |
| `FWPULL_PI_IP1` | `168` | Pi IP address octet 2 |
| `FWPULL_PI_IP2` | `144` | Pi IP address octet 3 |
| `FWPULL_PI_IP3` | `20` | Pi IP address octet 4 |
| `FWPULL_PORT` | `8070` | Pi firmware server port |

> **Important:** Set `FWPULL_PI_IPx` to the Pi's actual IP as seen from the FC. Verify with `hostname -I` on the Pi.

### Web Server (net_webserver_put.lua)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `WEB_ENABLE` | `1` | Enable Lua web server |
| `WEB_BIND_PORT` | `8080` | Web server port |
| `WEB_PUT_ENABLE` | `1` | Enable HTTP PUT uploads (not used in Tier 1, but available) |
| `WEB_MAX_UPLOAD` | `16777216` | Max upload size: 16MB |

### Networking (already configured for Quiver)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `NET_ENABLE` | `1` | Required for all HTTP/TCP operations |

---

## Pi Configuration

### UFW Firewall Rule

The FC must be able to connect to the Pi on port 8070. The Pi's UFW default INPUT policy is DROP, so an explicit allow rule is needed:

```bash
sudo ufw allow from 192.168.144.11 to any port 8070
```

Replace `192.168.144.11` with the FC's actual IP if different.

### Python Dependencies

```bash
pip install --break-system-packages mavsdk aiohttp python-socketio[asyncio_client] psutil requests
```

---

## FC SD Card Layout

```
APM/
├── scripts/
│   ├── firmware_puller.lua          ← Pulls firmware from Pi (Tier 1)
│   ├── net_webserver_put.lua        ← Web server with PUT support
│   └── relay_delayed_close.lua      ← (existing, unrelated)
└── ardupilot.abin                   ← Firmware file (written by puller, consumed by bootloader)
```

---

## Changes Made to logs_ota_service.py

### 1. Firmware Download Handler — Single Response Body

**Problem:** aiohttp's `StreamResponse` with chunked writes caused `ClientConnectionResetError` because the FC's Lua VM reads at ~4KB/5ms and aiohttp's internal write pipeline times out when the receiver is slow.

**Fix:** Replaced `StreamResponse` with a single `Response(body=firmware_data)`. The OS kernel's TCP stack handles flow control natively — proper TCP windowing and backpressure without application-level timeouts.

```python
# BEFORE (broken):
response = aiohttp_web.StreamResponse(...)
await response.prepare(request)
for chunk in file:
    await response.write(chunk)  # ← times out, resets connection

# AFTER (working):
with open(firmware_path, "rb") as f:
    firmware_data = f.read()
return aiohttp_web.Response(body=firmware_data, ...)  # ← kernel handles pacing
```

### 2. Tier 1 Only — Removed MAVFTP and HTTP PUT Fallbacks

**Problem:** MAVFTP operations (list_directory, remove_file, upload) corrupt the FTP sequence counter within a MAVSDK session. Once corrupted, all subsequent MAVFTP operations fail with `Ignore: last: X, req: Y` forever. HTTP PUT requires a custom Lua web server that conflicts with the stock one.

**Fix:** Removed Tier 2 (HTTP PUT) and Tier 3 (MAVFTP) entirely. Flash jobs use only Tier 1 (FC HTTP pull via firmware_puller.lua). If the FC doesn't pull, the job fails with a diagnostic message listing what to check.

### 3. No MAVFTP in Pre-Upload Cleanup

**Problem:** The original code called `ftp.list_directory("/APM/")` and `ftp.remove_file()` to clean up old firmware files before upload. This corrupted the MAVFTP sequence counter, causing all subsequent operations to fail.

**Fix:** Pre-upload cleanup only uses HTTP (checking via `_http_file_exists`). If HTTP is unavailable, cleanup is skipped entirely. The bootloader overwrites old files anyway.

### 4. Automatic Reboot After Transfer

**Problem:** After firmware transfer, the original code monitored for bootloader stage files (ardupilot-verify.abin, etc.) via HTTP polling. But these files only exist during the bootloader's flash process (during reboot), not while the FC is running.

**Fix:** After successful transfer:
1. Send MAVLink reboot command via `mavsdk.action.reboot()`
2. Wait 5s for FC to go offline
3. Poll FC webserver every 5s for up to 2 minutes
4. Report "completed" when FC comes back online
5. Falls back to "please reboot manually" if reboot command fails

### 5. Early Exit Timeout 20s → 30s

Gives the FC's firmware_puller.lua 6 poll cycles (5s each) instead of 4 to connect to the Pi's firmware server.

---

## Scripts (Latest Versions)

### firmware_puller.lua (FC — APM/scripts/)

Debug version with GCS messages at every stage for troubleshooting:

- `FWPull: LOADED OK` at startup with IP/port/enable state
- `FWPull: polling <ip>:<port> (cycle N)` every ~60s heartbeat
- `FWPull: Pi unreachable (<reason>)` on connection failure
- `FWPull: connecting / connected / send` at every TCP step
- `FWPull: status HTTP <code>` and response body on status check
- `FWPull: firmware ready (N KB), starting download` when firmware available
- Download progress every 100KB
- `FWPull: DONE — N KB → /APM/ardupilot.abin` on success
- Stall detection: aborts after 30s with no data

**Flow:**
1. Polls `GET http://<pi_ip>:8070/firmware/status` every 5s
2. If `{"ready": true, "size": N}`, connects to `/firmware/download`
3. Writes response body to `/APM/ardupilot.abin` in 4KB chunks
4. Sends `GET /firmware/ack` to signal completion
5. Logs "reboot to flash firmware"

**Key parameters:** FWPULL_ENABLE, FWPULL_PI_IP0-3, FWPULL_PORT

### net_webserver_put.lua (FC — APM/scripts/)

Extended version of ArduPilot's stock net_webserver.lua with HTTP PUT support:

- All stock GET functionality preserved (directory listing, file serving, CGI, SSI)
- Added HTTP PUT method for file uploads to `/APM/` directory only
- Security: path traversal prevention, size limits, `/APM/` restriction
- PUT receive with progress logging every 100KB via GCS messages
- Stall timeout: 30s with no data → abort + delete partial file
- Multi-chunk reads per cycle for throughput (up to 512KB/cycle)

**Key parameters:** WEB_ENABLE, WEB_BIND_PORT, WEB_PUT_ENABLE, WEB_MAX_UPLOAD

> **Note:** Uses param table key 47 (`WEB_` prefix). If the ArduPilot firmware has a built-in C++ web server that also uses key 47, this script will fail to load. In that case, remove this script and use only firmware_puller.lua (Tier 1).

### logs_ota_service.py (Pi — companion computer)

Full service with:

- **FC log sync** — background HTTP polling of FC webserver for .BIN log files
- **FC log serving** — cached logs uploaded to Hub on request
- **OTA firmware flash** — Approach C (FC HTTP pull) only
- **System diagnostics** — CPU, memory, disk, temp, service status
- **Remote log streaming** — journalctl → Socket.IO to browser
- **Job queue** — polls Hub for pending flash/scan/download jobs

**OTA flash flow:**
1. Download .abin/.apj from Hub CDN
2. Auto-convert .apj → .abin if needed (zlib decompress, MD5 header)
3. SHA-256 integrity check against Hub's hash
4. Start aiohttp server on :8070 serving the firmware
5. Wait for FC to pull (30s early exit if no activity)
6. Send MAVLink reboot command
7. Poll FC webserver until back online (2 min timeout)
8. Report completion to Hub

---

## Troubleshooting

### FC can't reach Pi (FWPull: connect failed)
- Check UFW: `sudo ufw status | grep 8070`
- Check Pi IP matches FWPULL_PI_IPx params
- Test from Pi: `python3 -m http.server 8070` then watch FC Messages

### firmware_puller.lua not loading
- Check `SCR_ENABLE=1` (requires reboot)
- Check file is in `APM/scripts/firmware_puller.lua`
- Check for Lua errors: look for `SCR:` in Mission Planner Messages
- Check param table conflict: if another script uses key 48, change it

### net_webserver_put.lua crashes
- Param table key 47 conflict with built-in web server → remove the Lua script
- `string.format` error on line 722 → cosmetic bug in progress logging (floats vs integers), doesn't affect functionality

### MAVFTP sequence corruption
- Symptom: `Ignore: last: X, req: Y` repeating forever
- Cause: any MAVFTP operation (list_directory, remove_file, upload) can corrupt the sequence
- Fix: restart the logs-ota service for a fresh MAVSDK session
- Prevention: the updated service never uses MAVFTP in the flash path

### Dashboard stuck at 65% / "Firmware file consumed but no stage transition"
- Old behavior: monitored for bootloader stage files while FC was still running
- Fix: updated service reboots FC and waits for it to come back instead
