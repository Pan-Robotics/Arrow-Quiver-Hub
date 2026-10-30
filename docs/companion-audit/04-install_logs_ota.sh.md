# Audit — `companion_scripts/install_logs_ota.sh`

## Current systemd conclusion

**The current source no longer emits the checkpoint `6c3420a` quoted-`WorkingDirectory` fatal setting.** `install_logs_ota.sh:104` uses `quiver_systemd_directory`, whose contract emits an unquoted absolute path. I rendered the exact non-root heredoc into a temporary unit containing spaces in its install directory and ran `systemd-analyze verify` (systemd 255): `WorkingDirectory=/tmp/.../install dir` was accepted. Therefore the reported *quoted WorkingDirectory* failure is consistent with a stale installed unit or stale suite, not reproducible from this checkout. This audit did not inspect the Pi’s installed `/etc/systemd/system` files.

The current source does still produce an `EnvironmentFile=` warning (Finding 1), but it is not the fatal “bad unit file setting” reproduced by the earlier quoted-directory defect.

## Findings

### 1. Medium — quoted `EnvironmentFile=` is parsed as a non-absolute filename and ignored

**Status:** Confirmed.

`install_logs_ota.sh:105` uses the generic word-quoting helper for `EnvironmentFile=`:

```ini
EnvironmentFile="/chosen/path/.env"
```

A temporary unit rendered from the exact source passed `WorkingDirectory`, but `systemd-analyze verify` reported: `EnvironmentFile= path is not absolute, ignoring: "/tmp/.../config-file"`. The current systemd documentation says this directive takes an absolute filename; the literal quote becomes part of the filename. The runtime is normally rescued by the separate `Environment="QUIVER_ENV_FILE=/..."` line and `companion_config.load_environment()` (so the Python process reopens the file), but the generated unit does **not** itself load the advertised shared environment file. This contradicts `COMPANION_SERVICES.md:68` and makes the redundant unit directive noisy and ineffective.

**Fix:** Use an EnvironmentFile-specific formatter that emits a literal absolute path (including spaces) rather than `quiver_systemd_path`, or remove `EnvironmentFile=` and document that only `QUIVER_ENV_FILE` is passed. Add a regression that verifies a rendered path with spaces and fails on any `EnvironmentFile=` diagnostic.

### 2. Critical — unpinned `mavsdk` install can select v4, whose API is incompatible with this runtime

**Status:** Confirmed as an installer/runtime contract failure.

The installer runs `python3 -m pip install ... mavsdk ...` without a version bound (`install_logs_ota.sh:76`). The runtime expects the retired gRPC-wrapper API at `logs_ota_service.py:85-90`, including `from mavsdk import System` and `from mavsdk.ftp import FtpResult`. MAVSDK’s official v4 migration guide states that the `mavsdk` distribution became a native binding with a different API; the old asyncio/gRPC wrapper is now `mavsdk-grpc` under `mavsdk_grpc`, or the old name must be constrained with `mavsdk<4`. The currently published `mavsdk` is v4.1.0 and supports Python 3.13/aarch64, so Python 3.13 is not the compatibility problem—the unpinned major upgrade is.

On the audit environment, importing `mavsdk.ftp` from the observed current v4 package produced its explicit `LegacyModuleError` explaining the same migration. A newly provisioned Trixie host will install the current unpinned release and can therefore fail before any FC connection is attempted, or leave MAVSDK unavailable depending on the exception path/version.

**Fix:** Either pin `mavsdk<4` and test its Python 3.13/aarch64 wheel/server behavior, or install `mavsdk-grpc` and update the imports to `mavsdk_grpc`. Prefer a versioned requirements file with hashes/constraints over unbounded global pip resolution. Add an installer post-install import/API smoke test; do not connect to an FC in that test.

### 3. High — prompt accepts invalid poll/diagnostic intervals; service exits with traceback and systemd restart-loop

**Status:** Confirmed.

`install_logs_ota.sh:62-63` writes arbitrary prompt text to `POLL_INTERVAL` and `DIAGNOSTICS_INTERVAL`; only `FIRMWARE_SERVER_PORT` is later validated by `render-fc-params` (`:81`). At module/argument-parser construction, `logs_ota_service.py:2782-2785` calls `int(CONFIG.get(...))` outside argparse validation. With a temporary non-`.env` fixture containing `POLL_INTERVAL="not-a-number"`, even `--help` exited 1 with an uncaught `ValueError`. This occurs before the later positive-value check at `:2813-2814` and becomes repeated failures because the generated unit has `Restart=always` (`install_logs_ota.sh:109`).

**Fix:** Validate finite positive integer ranges before `quiver_set` in the installer and parse runtime values through a helper that reports `parser.error` rather than raising. Add tests for blank/default, non-numeric, zero, negative, and excessive values.

### 4. Medium — relative `LOG_STORE_DIR` is created in one directory but used from another; sandbox allow-list is ignored

**Status:** Confirmed.

The installer accepts `LOG_STORE_DIR` verbatim (`install_logs_ota.sh:59`), then runs `mkdir -p -- "$LOG_STORE_DIR"` and `chown` relative to the installer’s current working directory (`:83-85`). It later renders that same relative string into `ReadWritePaths=` (`:115`). A temporary unit with `ReadWritePaths="relative-cache"` produced `ReadWritePaths= path is not absolute, ignoring: relative-cache` from `systemd-analyze verify`.

The service has `WorkingDirectory=INSTALL_DIR`, so Python’s `Path("relative-cache")` instead resolves below `INSTALL_DIR`; the directory created by the installer may be elsewhere. Because `INSTALL_DIR` is separately writable this can be masked, but an intended cache outside it is neither created nor sandbox-whitelisted as documented.

**Fix:** Require an absolute `LOG_STORE_DIR` in the installer/config helper, reject newline/control characters, canonicalize it before `mkdir`, and render that absolute value into `ReadWritePaths`. Add a temporary-unit regression for a relative value and an absolute path containing spaces.

### 5. Critical — firmware flash has no armed-state interlock before serving firmware or rebooting the FC

**Status:** Confirmed by source inspection; hardware behavior was not tested.

The installer copies and enables the runtime that processes `flash_firmware` jobs (`install_logs_ota.sh:77-81,124`). `logs_ota_service.py:1919-2244` downloads, serves, and can call `await self.ftp.system.action.reboot()` at `:2123-2132`, but contains no call to `_check_arm_state` and no `armed` check. The only arm guard is in log synchronization (`:471-489` and `:606-617`), not OTA. The copied `firmware_puller.lua` likewise downloads when `FWPULL_ENABLE=1` without an arm check.

An authenticated Hub job arriving while an aircraft is armed can therefore stage firmware and request a reboot. The service must fail closed before exposing firmware and immediately before rebooting.

**Fix:** Require a fresh, explicit DISARMED state from FC telemetry for every flash job; reject if unavailable, stale, or armed. Re-check immediately before reboot. Make the FC-side Lua script independently refuse a download while armed if the platform API exposes that state. Test with local MAVSDK stubs only; do not test a reboot on hardware.

### 6. Critical — unauthenticated firmware endpoints allow a LAN request to cause a false “pull complete” and reboot path

**Status:** Confirmed by source inspection.

During a flash, `_start_firmware_server` binds `0.0.0.0` (`logs_ota_service.py:1423-1428`) and exposes unauthenticated `/firmware/status`, `/firmware/download`, and `/firmware/ack` (`:1368-1420`). `handle_ack` blindly sets `_fw_serve_downloaded=True` (`:1411-1415`). Further, `handle_download` sets `_fw_serve_bytes_sent` to the **entire file size before** the response is delivered (`:1392-1406`), and `_wait_for_fc_pull` treats either that value or an unauthenticated acknowledgement as successful (`:1486-1496`). The success path then reaches the reboot command.

Any host able to reach the temporary listener during the update window can acknowledge without receiving firmware, or trigger the bytes-sent fallback by beginning a download, causing a reboot decision that is not evidence of a complete FC receipt.

**Fix:** Bind only to the configured companion interface if feasible; validate the peer IP against the configured FC address; issue a per-update random capability/token in the status response and require it on download/ack; count completion only after an authenticated acknowledgement containing the expected byte count and artifact digest. Keep the armed-state gate from Finding 5 as an independent final defense.

### 7. High — checksum verification is optional although the setup guide describes it as mandatory

**Status:** Confirmed.

`logs_ota_service.py:2007-2029` verifies SHA-256 only if the job has `sha256Hash`; otherwise it logs a warning and continues toward firmware serving/reboot. The setup guide says the companion “downloads the artifact and verifies its SHA-256 hash” (`OTA_Setup_Guide.md:141-149`). For a firmware-bearing remote job, allowing an absent integrity value turns a malformed/incomplete server payload into a flash candidate.

**Fix:** Require a syntactically valid SHA-256 and fail the job before creating the firmware server when it is absent or mismatched. Define whether it covers the downloaded APJ bytes or the final ABIN bytes, document that choice, and test both APJ conversion and ABIN paths.

### 8. High — flash job returns success even after a commanded reboot fails to reappear

**Status:** Confirmed by source inspection; hardware behavior was not tested.

If the service sends reboot but the FC never becomes reachable within 120 seconds, `logs_ota_service.py:2227-2244` reports a `completed` progress event at 95% with `reboot_timeout_check_manually` and then returns `(True, None)`. `_job_poll_loop` converts that result into `complete_job(..., success=True)` (`:2641-2653`). Thus the Hub job can become successful despite no online/firmware-version confirmation. This conflicts with the stated OTA flow, which says the companion observes the FC returning online.

**Fix:** Return failure or a distinct non-terminal “manual verification required” state on reboot timeout; do not mark the job complete/successful until online plus version/hash verification succeeds. Preserve diagnostic context for operator recovery.

### 9. Medium — synchronous `requests` calls block the service’s event loop despite async method declarations

**Status:** Confirmed with a local timing stub.

`FCLogSyncer._fetch_directory_listing` is `async` but calls synchronous `requests.get(..., timeout=10)` directly (`logs_ota_service.py:491-525`). The log download path likewise calls blocking `requests.get` and iterates blocking `iter_content` (`:575-652`), and on-demand download repeats the pattern (`:1780-1834`). A no-network stub that slept 0.20 seconds delayed an independent coroutine scheduled for 0.05 seconds until 0.251 seconds; the event loop was blocked. The claimed `await asyncio.sleep(0)` between chunks cannot help while `requests.get` or `iter_content` waits for network data.

This delays the job poller, diagnostics, Socket.IO heartbeats, cancellation, and firmware HTTP server under an FC/HUB stall.

**Fix:** Use an async HTTP client consistently, or move the complete blocking request/streaming operation to a worker thread with bounded concurrency and thread-safe progress updates. Add a timing regression proving a concurrent heartbeat still runs while an FC request stalls.

### 10. Medium — alias resolution can discard a valid manually maintained `WEB_SERVER_URL`

**Status:** Confirmed with temporary non-`.env` fixtures.

The installer prompts `WEB_SERVER_URL` first (`install_logs_ota.sh:25`) through `quiver_get`. `companion_config._normalize_hub_aliases` canonically prefers `HUB_URL` on equal precedence (`companion_config.py:255-270`). A fixture containing `HUB_URL=""` and `WEB_SERVER_URL="https://web-set.example"` resolved **both** aliases to blank before and after `init`. The installer therefore displays an empty Hub URL prompt and a blank answer persists the loss through `quiver_set`, even though a usable legacy/manual `WEB_SERVER_URL` existed.

A file containing only `WEB_SERVER_URL` is migrated correctly, so this affects the realistic state where a blank `HUB_URL` line already exists (for example from an earlier template) and an operator manually populated only `WEB_SERVER_URL`.

**Fix:** Treat blank aliases as absent for conflict resolution: when exactly one alias is non-empty, propagate it to the other; only use `HUB_URL` as a tie-breaker when both are non-empty. Add fixtures for blank/nonblank aliases and explicit conflicting nonblank aliases.

## Dependency and compatibility notes

No Python 3.13-specific failure was found in the installer’s `python3` invocation itself. Current PyPI metadata for MAVSDK declares Python >=3.8, lists Python 3.13, and publishes a manylinux aarch64 `abi3` wheel; `python-socketio[asyncio_client]` declares Python >=3.8 and provides the requested extra. The actionable Python 3.13 deployment risk is Finding 2: unpinned resolution now selects a different MAVSDK major API, not a lack of Python 3.13 support.

The shell script passes `bash -n`; the runtime and configuration helper passed `py_compile` under the audit host’s Python 3.12. No package installation, network request from the runtime, systemd service start/restart, FC connection, firmware transfer, or hardware test was performed.

## References

[1]: https://www.freedesktop.org/software/systemd/man/systemd.exec.html "systemd.exec EnvironmentFile documentation"
[2]: https://mavsdk.mavlink.io/main/en/python/migration.html "Migrating from MAVSDK-Python"
[3]: https://pypi.org/project/mavsdk/ "MAVSDK PyPI metadata"
[4]: https://pypi.org/project/python-socketio/ "python-socketio PyPI metadata"
