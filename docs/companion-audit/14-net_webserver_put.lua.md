# Audit: `companion_scripts/net_webserver_put.lua`

Audited the complete 1,007-line applet and its immediate companion contracts: `companion_config.py`, `installer_common.sh`, all three relevant installers, generated-unit tests, Logs & OTA runtime, `firmware_puller.lua`, and OTA/webserver setup documents. No project file, package, service, network endpoint, or hardware was modified or exercised.

## Findings

### 1. High — current installers still quote `EnvironmentFile=`, so systemd 255 ignores the shared config
**Evidence:** `installer_common.sh:31-39` emits `"…"`; Hub, telemetry, and Logs & OTA use it for `EnvironmentFile=` (`install_hub_client.sh:162`, `install_telemetry_forwarder.sh:46`, `install_logs_ota.sh:105`). A temporary unit verified by real `systemd-analyze 255` emitted `EnvironmentFile= path is not absolute, ignoring: "…/config"`. The same fixture succeeds with an unquoted path, including one containing a space. The app’s `QUIVER_ENV_FILE` `Environment=` assignment remains correctly quoted and allows the Python helper to reload the file, so this is not itself the fatal “bad unit file setting,” but the advertised systemd `EnvironmentFile` is ineffective.

**Stale-unit distinction:** current checkpoint `6c3420a` now emits a literal `WorkingDirectory=` (`quiver_systemd_directory`, installers lines above); a temporary old-style `WorkingDirectory="/tmp/install dir"` reliably produces `path is not absolute` and `Unit configuration has fatal error` / `bad unit file setting`. Therefore the reported fatal error is consistent with installed pre-checkpoint units, not the current source’s `WorkingDirectory`. The repair script fixes only that historical directive and leaves the current `EnvironmentFile` warning.

**Fix:** add a distinct absolute-path formatter for `EnvironmentFile` (no surrounding quotes; reject newline/NUL/nonabsolute path) and use it only there. Retain word quoting for `Environment=` and `ExecStart=`. Extend unit regression coverage to assert `systemd-analyze verify` has no `EnvironmentFile` warning, not merely exit code zero.

**Test:** Safe temporary-unit repro described above; targeted `server/companion-installers.test.ts` passed 20/20, but its assertion only checks the verify exit status, which is zero despite this warning.

### 2. High — unpinned `mavsdk` now disables FC/OTA functionality, including on a Python 3.13-capable install
**Evidence:** Logs & OTA imports the legacy API at `logs_ota_service.py:86-90`: `from mavsdk import System` followed by `from mavsdk.ftp import FtpResult`; either `ImportError` sets **both** names to `None`. Its installer installs unpinned `mavsdk` at `install_logs_ota.sh:76`. Safe local import with currently resolved `mavsdk 4.1.0` succeeded for `System` but `from mavsdk.ftp import FtpResult` raised `ModuleNotFoundError`/`ImportError`: v4 explicitly says the old gRPC API was split and recommends `mavsdk-grpc` or an API-compatible version. `MavFtpClient.connect()` then returns false when `System is None` (`logs_ota_service.py:900-904`), preventing MAVLink reboot/version verification and any MAVFTP fallback. Current package metadata advertises Python 3.13, so this is an API-major-version failure rather than evidence that Python 3.13 itself is unsupported.

**Fix:** choose and lock one API family after testing on target aarch64/Python 3.13: either pin a legacy compatible package/version and its required server artifact, or port imports and all use sites to MAVSDK v4. Add an installer post-install **import/API** preflight that fails before writing/enabling a unit.

**Test:** Import-only local reproduction; no package install or FC connection. PyPI metadata for current MAVSDK says `Requires-Python >=3.8` and describes the v4 API break [4].

### 3. High — PUT writes header coalesced bytes beyond `Content-Length`, then reports success
**Evidence:** `read_header()` splits at the first `\r\n\r\n` and stores every remaining byte in `put_body_leftover` (`lines 318-329`). `handle_put()` writes all of it before enforcing the declared length (`799-808`). If `Content-Length: 1` arrives with two body bytes in the first receive, it writes both, sets `put_remaining=-1`, then `receive_file()` sends `201 Created` because `put_remaining <= 0` (`653-668`). A direct arithmetic model of those exact lines produced `written='AB', remaining=-1, received=2`.

**Impact:** malformed or pipelined input can create an unexpected firmware file and obtain a success response. Since the destination can be bootloader-consumed, byte-count integrity must be strict.

**Fix:** validate `Content-Length` as decimal digits and a bounded integer; reject any header leftover larger than it with `400` and delete/close the partial file. Write at most `min(#leftover, put_remaining)`, and only return `201` when received equals declared length exactly. Reject additional bytes because this server deliberately closes connections and does not support pipelining.

**Test:** Add a Lua Socket/fs stub test for one-receive header+body cases: exact body succeeds; body larger than declared fails and leaves no final file; fractional/exponent/duplicate lengths fail.

### 4. High — SD-card write/flush errors are ignored and can still return `201 Created`
**Evidence:** `put_file:write(data)` (`707`), `put_file:flush()` (`717`), header-leftover `write`/`flush` (`804-805`), and final flush (`655`) have no result/error checks. Counters are advanced from received network bytes regardless of a failed SD write. The applet can therefore acknowledge a complete upload after an SD-full or I/O-error path while leaving a partial `ardupilot.abin`.

**Fix:** wrap each write/flush/close result; on failure close the handle, remove the temporary/partial upload, send one `5xx` best-effort response if possible, log the filesystem error, and never emit completion. Count successful writes, not only received bytes.

**Test:** Lua stdlib/fs stub whose `write` or `flush` returns `nil, "disk full"`; assert no `201`, no final file, and cleanup message. This was not hardware-tested.

### 5. High (operational-safety risk; direct behavior confirmed) — PUT writes the bootloader trigger filename directly and has no armed-state guard
**Evidence:** the applet opens caller-selected `/APM/...` output directly with `io.open(path, "wb")` (`788-790`); no temporary name, final atomic rename, expected firmware-name restriction, checksum, or `arming:is_armed()` check exists. Prefix-only authorization (`734`) permits every path under `/APM/`, including the bootloader-triggering `ardupilot.abin`. `firmware_puller.lua` is the documented/current flow and the Logs & OTA handler now uses its HTTP pull exclusively (`logs_ota_service.py:2061-2113`); the PUT applet is only a legacy manual path despite the installer copying it.

**Risk:** direct-to-final writes expose a partially written boot file if the FC loses power/resets or receives an externally induced reboot mid-upload. Whether a particular bootloader flashes it is hardware/firmware-specific and was not tested. ArduPilot exposes `arming:is_armed()` to Lua, so an upload can be blocked while armed [3].

**Fix:** default `WEB_PUT_ENABLE` to disabled; require disarmed state; restrict PUT to exactly a safe staged filename (or explicitly documented safe set); write a `.part` file, check exact length and write success, then rename to `ardupilot.abin` only after completion. Keep the puller as the supported OTA method and avoid installing/enabling this endpoint unless manual PUT remains a supported, tested feature.

**Test:** Lua stubs for armed/disarmed, reset/error before finalization, and successful staged promotion. Test against the intended FC/bootloader in a non-flight bench before enabling OTA.

### 6. Medium — unbounded request header can exhaust the FC scripting heap
**Evidence:** `read_header()` appends unbounded input (`header = header .. s`, line 318) until a terminator arrives. There is no maximum header length. A peer that continuously sends a non-terminated header during the configured timeout can force repeated string reallocations in the finite Lua heap. ArduPilot documents shared scripting heap constraints and that scripts may fail with insufficient memory [2].

**Fix:** set a small explicit maximum (for example 8 KiB), send `431 Request Header Fields Too Large` or close, and remove the client once exceeded. Also cap individual request-line/header counts.

**Test:** Socket stub that feeds > maximum bytes without `\r\n\r\n`; assert close/removal without continued allocation.

### 7. Medium — an extensionless uploaded file can trigger a Lua error on GET
**Evidence:** `content_type()` does `local _, ext = string.match(path, '(.*[.])(.*)')` then unconditionally calls `string.lower(ext)` (`560-566`). For an existing extensionless path, `ext` is nil. PUT permits `/APM/<extensionless>` (`734`, `790`), and a later GET reaches `file_download()` then `content_type()`. This is also inherited from the upstream applet, but is reachable through this fork’s new write surface.

**Fix:** if no extension was matched, return `application/octet-stream` before lowercasing. Add a GET regression after PUT of `/APM/firmware`.

**Test:** Lua stdlib stub or syntax/runtime harness with `content_type('/APM/firmware')`; assert octet-stream and no exception.

## Contract checks that did not produce a blocker

- `companion_config.py` literal parsing, alias synchronization, `.NN` expansion, explicit `FC_WEBSERVER_URL` override, and FC-parameter rendering worked in a temporary config file. No `.env` was touched. The FC applets correctly do not read the Pi configuration; `firmware_puller.param` carries only the Pi IP and firmware port.
- The current suite uses `--break-system-packages` for pip. Current aiohttp metadata supports Python 3.13; DroneCAN is pure Python and advertises `>=3.7`. No package was installed on Raspberry Pi hardware, so wheel availability and runtime operation there remain untested.
- The current PUT receive loop is asynchronous at the API level: ArduPilot’s socket `recv` calls `pollin(timeout)` and then `recvfrom(..., MSG_DONTWAIT)` [1]. The applet’s 16-read/512 KiB work budget can nevertheless consume a script time slice; no flight-controller timing/hardware test was performed.
- Current setup documentation correctly describes HTTP pull via `firmware_puller.lua` as the active OTA route. However, Logs & OTA’s top-level legacy “three-tier” description still says PUT/MAVFTP fallbacks while the active flash handler states and implements pull-only; align that wording and the applet installation guidance to avoid enabling a legacy write endpoint unnecessarily.

## References

[1]: https://raw.githubusercontent.com/ArduPilot/ardupilot/master/libraries/AP_HAL/utility/Socket.cpp "ArduPilot Socket implementation"

[2]: https://ardupilot.org/copter/docs/common-lua-scripts.html "ArduPilot Lua Scripts"

[3]: https://ardupilot.org/sub/docs/common-lua-binding-syntax.html "Decoding the LUA Binding Descriptions"

[4]: https://pypi.org/pypi/mavsdk/json "MAVSDK PyPI metadata"
