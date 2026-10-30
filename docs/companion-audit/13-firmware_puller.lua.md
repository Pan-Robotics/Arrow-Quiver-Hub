# `companion_scripts/firmware_puller.lua` audit

## Findings

### 1. Critical — companion can reboot the FC after merely accepting the download request, not after receiving the FC acknowledgement
**Lines:** `firmware_puller.lua:329-337`; `logs_ota_service.py:1392-1397, 1476-1496, 2093-2097`  
**Status:** Confirmed.

The FC script only acknowledges after it closes the completed file, which is the right signal to use. The companion, however, sets `_fw_serve_bytes_sent` to the full file length as soon as its `aiohttp` handler has read the file into memory, before TCP has delivered it to the FC. `_wait_for_fc_pull()` then treats `bytes_sent >= size` as success even with `_fw_serve_downloaded == False`, immediately stops the HTTP server in `finally`, and continues to the reboot stage.

A local Python stub set `size=bytes_sent=4096`, `ack=False`; the current method returned `True` and logged `treating as complete (ack may be delayed)`. This needs no hardware or network to demonstrate the state error. Slow/incomplete FC transfer can therefore be interrupted and followed by a reboot/reporting sequence as though the artifact reached `/APM/ardupilot.abin`.

**Fix:** Remove the bytes-served success fallback. Retain the server until a validated FC acknowledgement arrives or the deadline expires; a TCP server write/read into memory is progress at most, never receipt confirmation. Treat missing acknowledgement as failure and do not reboot.

### 2. Critical — firmware transfer/reboot has no armed-state interlock
**Lines:** `firmware_puller.lua:233-337`; `logs_ota_service.py:1919-2244`  
**Status:** Confirmed.

The runtime has an arm-state helper, but it is used only by `FCLogSyncer` (`logs_ota_service.py:471-489, 608, 708, 754`). `handle_flash_firmware()` contains no armed-state check before exposing firmware, writing `/APM/ardupilot.abin`, or calling `system.action.reboot()` at line 2128. A queued job can therefore initiate a bootloader-triggering reboot while an aircraft is armed.

**Fix:** Before starting the firmware server and again immediately before reboot, obtain a bounded-time MAVSDK armed sample. Fail closed if the state is armed or unavailable. The Hub job must be completed as failed/deferred rather than reporting a completed update.

### 3. High — current installers still render an invalid quoted `EnvironmentFile=` path on systemd 255
**Lines:** `installer_common.sh:31-38`; `install_hub_client.sh:161-165`; `install_telemetry_forwarder.sh:45-49`; `install_logs_ota.sh:104-108`  
**Status:** Confirmed on systemd 255; affects the immediate configuration contract, not Lua syntax.

Checkpoint `6c3420a` corrected `WorkingDirectory=` by using `quiver_systemd_directory`, so the old quoted-working-directory error remains a *stale installed-unit* possibility rather than a defect in the current three installers. But all three still call `quiver_systemd_path` for `EnvironmentFile=`. That formatter emits double quotes.

A temporary current `logs-ota.service` with an install path containing spaces passed `systemd-analyze verify` with exit code 0 but emitted: `EnvironmentFile= path is not absolute, ignoring: "…/test-config"`. A three-way temporary unit repro showed that a literal `EnvironmentFile=/path with spaces/file` and `\\x20` form are accepted, whereas the quoted form is ignored. The existing regression helper only checks verify’s exit status, so it misses this diagnostic. `QUIVER_ENV_FILE` may still allow Python to reload the file, but systemd itself does not load the declared EnvironmentFile, contradicting the unit contract and leaving a systemd warning.

**Fix:** Use a distinct EnvironmentFile formatter: require one absolute, newline/NUL-free path and print it without surrounding quotes (escape `%` as `%%` for specifier safety). Keep quoted-word formatting for `ExecStart`, `Environment`, and path-list directives. Update the three installer assertions to fail on verifier diagnostics, not only a nonzero exit.

### 4. High — Lua accepts mismatched or oversized download bodies and acknowledges them
**Lines:** `firmware_puller.lua:219-226, 279-304, 329-337`  
**Status:** Confirmed logic; malformed/malicious response is the triggering condition.

The status `size` is bounded to 16 MiB, but a positive download `Content-Length` blindly overwrites it at line 289. It is not checked against the status size or `MAX_FIRMWARE_SIZE`. The script also completes on `received >= expected`, so it can write trailing bytes before declaring success. A smaller Content-Length can make a partial body appear complete; a huge one removes the size cap and can fill FC storage. In both cases the script closes the file and sends `/firmware/ack`.

**Fix:** Keep the status size immutable for the transfer. Require a download Content-Length, when supplied, to equal that size and be within the cap. Before every write, reject `received + chunk_len > expected`; only close, rename, and acknowledge when the byte count is exactly equal. Treat EOF before exact completion as an abort.

### 5. High — write, flush, and close failures can be counted as successful firmware bytes
**Lines:** `firmware_puller.lua:293-294, 302-303, 311-313, 329-336`  
**Status:** Confirmed unchecked-error path; disk/I/O failure is the triggering condition.

`file:write`, `flush`, and `close` results are discarded, but byte counters advance immediately. A full/corrupt SD card can therefore produce a partial file, a completion acknowledgement, and the companion’s reboot sequence. The bootloader’s artifact checksum may prevent flashing, but the operation is still incorrectly treated as delivered and may reboot the vehicle.

**Fix:** Check every write/flush/close result. On any failure, close handles, remove only the partial staging file, do not acknowledge, and return to an error/backoff state.

### 6. High — unauthenticated `/firmware/ack` makes completion externally forgeable on the payload LAN
**Lines:** `firmware_puller.lua:335-336`; `logs_ota_service.py:1411-1415, 1418-1420`  
**Status:** Confirmed.

The FC sends a plain unauthenticated GET, and the companion accepts any requester as `_fw_serve_downloaded=True`. Any host able to reach the temporary `0.0.0.0:FIRMWARE_SERVER_PORT` listener can forge an acknowledgement. Combined with finding 1, the service can proceed to reboot without a real FC download. HTTP also provides no artifact authenticity between Pi and FC; the `.abin` MD5 is consistency data, not source authentication.

**Fix:** At minimum bind/allow only the configured `FC_IP` and reject acknowledgements from any other peer. Couple acknowledgement to an exact completed transfer and retain the server until it arrives. If the LAN trust boundary is insufficient, add an FC-side secret/token and artifact digest validation rather than relying on plain HTTP.

### 7. Medium — status requests can block or wedge the applet indefinitely, and request-send errors are not detected correctly
**Lines:** `firmware_puller.lua:97-116, 178-195, 354-377`  
**Status:** Confirmed from current upstream SocketAPM API/source; target-version behavior remains a deployment qualification.

The Lua binding documents `send()` as returning an integer. The implementation returns the POSIX `send` result, so `-1` and a partial positive count are both truthy in Lua; `if not s:send(...)` therefore misses them. It must compare the result to `#req`.

The script never calls `set_blocking(false)`, while the upstream socket constructor leaves a normal TCP socket in its OS default blocking mode and `connect()` directly invokes `connect(2)`. A dropped route can hold the script in connect. Once a status socket is created, `STATE_CHECKING` has no timestamp or disconnected-socket exit: repeated `recv()` nil results leave it there permanently. The 30-second stall guard applies only after the download state begins.

**Fix:** Check `sent == #req`. Use an explicit nonblocking connect/pending/pollout state or another bounded connection mechanism, and record a status-request deadline. On timeout, EOF, or disconnect, close/reset and resume the normal poll cadence. This matters because ArduPilot scripts run as scheduled callbacks and an individual script error terminates that script.[1] [2]

### 8. Medium — direct write to final bootloader filename makes interruption destructive
**Lines:** `firmware_puller.lua:37, 78-83, 233-241, 329-337`  
**Status:** Potential safety failure; power loss/FC reset or download failure is the trigger.

The script opens `/APM/ardupilot.abin` with `"wb"` before it has connected to or validated the download response. It destroys any prior pending artifact immediately. A controller reset or power interruption during transfer leaves the bootloader-visible filename partially written; cleanup cannot run after a reset.

**Fix:** Write to a non-bootloader staging name, validate exact length and I/O completion, then rename to `/APM/ardupilot.abin` only after confirming that the FC filesystem supports the required rename semantics. On abort, remove the staging file only.

## Contract checks that passed

- All 384 lines of `firmware_puller.lua` were read. The parameter renderer correctly emits `FWPULL_PI_IP0`…`3` and `FWPULL_PORT`, omits `FWPULL_ENABLE`, rejects zero/multicast first octets, and rejects ports outside 1–65535. A test config rendered `10.20.30.40:9123` correctly.
- The shared parser treats `.env` as literal data rather than sourcing it. Current alias resolution gave `HUB_URL` precedence when both aliases differ at the same source level, and synchronized the resolved `WEB_SERVER_URL`; this is consistent with its documented contract.
- The current installer includes `python3`, `python3-pip`, and `--break-system-packages` for `mavsdk`, `requests`, `psutil`, `python-socketio[asyncio_client]`, and `aiohttp`. Python compilation passed on the available Python 3.12; the used `asyncio.timeout`/`to_thread` APIs are available before Python 3.13. No package install was performed.
- Shell syntax checks passed for the relevant installers and helper. No Lua interpreter was available, so no claim of FC execution or hardware/network testing is made.

## Stale-suite distinction

`6c3420a` is the current repository head and specifically fixed quoted `WorkingDirectory=` in the three relevant installers. The current source emits a literal WorkingDirectory and the temporary rendered OTA unit did not receive a WorkingDirectory diagnostic. An existing Pi can still run an older unit with `WorkingDirectory="..."`; only the installed files under `/etc/systemd/system/` establish that. The current repair script is designed for that historical defect, but it does not correct the still-quoted `EnvironmentFile=` construction identified above.

## Verification performed

No project file, Git configuration, package, network service, or hardware was modified/started. Reproductions used temporary non-`.env` config filenames. `systemd-analyze verify` was run against a temporary unit under local systemd 255.4. A Python stdlib stub exercised `_wait_for_fc_pull()` without network I/O. The deployed ArduPilot firmware/version and filesystem behavior were not tested.

## References

[1]: https://ardupilot.org/copter/docs/common-lua-scripts.html "ArduPilot Lua Scripts"

[2]: https://raw.githubusercontent.com/ArduPilot/ardupilot/master/libraries/AP_HAL/utility/Socket.cpp "ArduPilot SocketAPM implementation"
