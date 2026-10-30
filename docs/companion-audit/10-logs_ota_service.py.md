# `logs_ota_service.py` audit

Audited all 2,869 lines of `companion_scripts/logs_ota_service.py` and its immediate deployment contracts: `companion_config.py`, `installer_common.sh`, `install_logs_ota.sh`, `logs-ota.service`, `companion-config.example`, `firmware_puller.lua`, the OTA/companion documentation, and targeted existing tests. Project files were not changed.

## Confirmed findings

### Critical — installer installs the wrong MAVSDK API today

`install_logs_ota.sh:76` installs unpinned `mavsdk`, while `logs_ota_service.py:86-90` requires the pre-v4 gRPC API (`from mavsdk import System`, `from mavsdk.ftp import FtpResult`). Current PyPI `mavsdk` is v4; its migration guide says the old gRPC API moved to `mavsdk-grpc` / `mavsdk_grpc`, and the v4 native binding has a different API.[1] [2]

**Evidence:** an isolated import against the locally installed current `mavsdk 4.1.0` produced the package's `LegacyModuleError` for `mavsdk.ftp`; the broad `ImportError` handler consequently left `System is None`. The daemon can then start, but every FC connection fails as “MAVSDK not installed.” This is especially likely on the reported fresh Python 3.13/aarch64 install because the current package publishes a compatible Linux aarch64 ABI3 wheel.[1]

**Fix:** deliberately retain the legacy API by installing `mavsdk-grpc` and importing `mavsdk_grpc` (including its FTP module), or pin `mavsdk<4` only after proving that selected legacy release supports the target platform/Python. Pin all direct runtime dependencies in a maintained requirements/constraints file. Add a clean-environment smoke test that imports the installed package and exercises the imports used by this file.

### Critical — firmware flashing/reboot has no armed-state interlock

`handle_flash_firmware()` (`1919-2263`) never checks telemetry armed state before downloading, exposing the firmware server, or sending `action.reboot()` at `2124-2133`. The log syncer’s guard is not shared with this handler.

**Evidence:** an isolated fake MAVSDK system whose `telemetry.armed()` raises if called still reached `action.reboot()` and returned `(True, None)`. No controller/network was contacted. This is contrary to the file’s stated safety posture for log actions and permits a queued remote firmware job to reboot an armed vehicle.

**Fix:** make a fresh, bounded arm-state query mandatory immediately before serving/uploading and immediately before reboot; fail closed on missing MAVSDK, unavailable telemetry, timeout, or armed state. Also re-check after the FC pull completes. Report the job failed/not executed, not completed, in those cases. Add unit tests for armed, unknown, timeout, and arm-state transition during a flash.

### Critical — the temporary firmware server accepts any client and can falsely authorize a reboot

`_start_firmware_server()` binds `0.0.0.0` (`1425`) and exposes unauthenticated `/firmware/status`, `/firmware/download`, and `/firmware/ack`. `handle_ack()` accepts any request as proof of FC completion (`1411-1415`); `_wait_for_fc_pull()` also accepts merely serving the full file as completion (`1491-1496`). The FC Lua contract only sends its ACK after it has closed the file after receiving the expected size (`firmware_puller.lua:329-337`).

**Evidence:** a stub with `_fw_serve_bytes_sent == _fw_serve_size` and no ACK made `_wait_for_fc_pull()` return `True`. Thus any reachable peer that fetches the file, or only calls `/firmware/ack`, can make the daemon proceed to the reboot path. Network reachability determines exploitability, but the missing authentication/source validation and false-completion behavior are confirmed by code.

**Fix:** restrict the listener/firewall to the configured FC address and reject other `request.remote` values. Prefer an unpredictable, per-job token carried in the status/download/ack protocol and verified on ACK; do not treat bytes handed to TCP as FC receipt. Require a validated ACK after FC-side durable completion, then retain the server until that proof or timeout. Test an ACK/download from a wrong address and a complete response without ACK.

### High — firmware integrity is optional although the setup guide says it is verified

`handle_flash_firmware():2007-2029` proceeds when `sha256Hash` is absent, only logging a warning. `OTA_Setup_Guide.md:141-149` says the companion verifies SHA-256 before delivery. The Hub router can create a job with `sha256Hash: null` (`server/routers.ts:1547-1552`).

**Fix:** require a syntactically valid SHA-256 for unattended firmware jobs and fail closed if missing/mismatched. If an explicit operator override is retained, make it a separately authorized, conspicuous operation and never the default queued-job path. Add tests for missing, malformed, and mismatch hashes.

### High — firmware jobs are marked successful without a confirmed flash

After successful server pull, `handle_flash_firmware()` returns success even if no reboot command could be sent (`2236-2244`) or if a sent reboot does not return within 120 seconds (`2227-2244`). `_job_poll_loop()` then calls `complete_job(job_id, success, error_msg)` (`2652-2653`). The progress reports call these states `completed` at 90/95%, so both the job record and UI can say successful while the firmware is only waiting for manual action or the FC status is unknown.

**Fix:** return a non-success terminal/pending-confirmation state until reboot and a robust post-flash version check succeed. If manual reboot is supported, model it as an explicit operator-acknowledged job state rather than a successful completion. Treat a reboot timeout as failure/unknown requiring intervention, not completion.

### High — synchronous I/O blocks the single asyncio loop, including safety/status work

Several `async def` methods call blocking `requests` or `subprocess` directly: directory scan (`491-525`), log download (`575-651`, `1781-1852`), Hub polling/reporting from the job and diagnostic loops (`2611`, `2664-2665`), and diagnostics service status (`2367-2378`). A log download has a 600-second synchronous request timeout.

**Evidence:** with `requests.get` safely stubbed to sleep 0.20 seconds, a ticker due after 0.01 seconds completed after 0.201 seconds while `_fetch_directory_listing()` ran. This disproves the comment at `575-580` that `asyncio.sleep(0)` keeps Socket.IO heartbeats responsive: yielding only occurs after blocking request/iterator calls return.

**Fix:** use an async HTTP client consistently, or wrap each complete blocking transaction (including stream iteration and Hub calls) in `asyncio.to_thread`; similarly move `DiagnosticsCollector.collect()` off-loop. Give every network operation bounded connect/read timeouts and cancellation behavior. Add a concurrency regression test proving heartbeat/status tasks run during delayed listing/download/poll requests.

### High — FC-controlled log names can escape the configured cache directory

The HTML parser accepts the first table-cell text as `name` without validation (`350-375`). `_download_log_file()` then constructs `self.log_store_dir / filename` and a temp path directly (`581-584`); the on-demand handler repeats this at `1769`, `1794-1812`. It does not require a basename, reject `..`, or prove resolved paths remain under the cache root.

**Evidence:** parsing a safe local fixture with `../../outside.BIN` resulted in a computed path `/tmp/quiver-store/../../outside.BIN`, resolving to `/outside.BIN`, outside the store. With the root service option this becomes a write-path boundary issue; `ProtectSystem` reduces impact for the installed unit but does not protect manual execution and cannot substitute for input validation.

**Fix:** accept only a strict filename grammar expected for FC logs (for example a basename ending in `.BIN`/`.log`), resolve both temporary/final paths with `strict=False`, and reject any path not relative to the resolved store. Use the validated name for cache paths and URL-encode/validate href separately. Test traversal, absolute names, separators, and symlinked cache directories.

### Medium — the current installer still emits an invalid quoted `EnvironmentFile=` directive

The reported checkpoint fixed `WorkingDirectory`: `install_logs_ota.sh:104` correctly renders a literal absolute directory. However line `105` calls `quiver_systemd_path`, producing `EnvironmentFile="/path/.env"`. On systemd 255, quoted `EnvironmentFile=` is parsed as a path beginning with `"`, which is not absolute and is ignored. `COMPANION_SERVICES.md:168-174` incorrectly says this directive should remain quoted; existing installer tests also assert the quoted form (`server/companion-installers.test.ts:135,154,173`).

**Evidence:** `systemd-analyze verify` on a temporary unit rendered in the same form emitted `EnvironmentFile= path is not absolute, ignoring: ".../config.ini"`. The same unquoted absolute path, including a space, verified without this diagnostic. The service’s `Environment="QUIVER_ENV_FILE=..."` remains valid and lets `load_environment()` open the file, so this source defect may not alone stop this Python process; nevertheless systemd ignores the intended EnvironmentFile and it can be the visible “bad unit file setting.” Actual Pi units could additionally be stale pre-checkpoint files; this audit did not inspect them.

**Fix:** use a directive-specific absolute-file formatter for `EnvironmentFile=` (escape `%`, reject non-absolute/control-character paths, but do not wrap the path in quote characters). Update the documentation and test expectations. Validate the exact installed rendered unit with `systemd-analyze verify` in installer tests.

### Medium — numeric configuration errors crash at import/argument construction instead of producing a controlled CLI error

`FIRMWARE_SERVER_PORT` is converted in the class body (`1154`), and `POLL_INTERVAL` / `DIAGNOSTICS_INTERVAL` are converted in argparse defaults (`2782-2786`). An invalid value is not caught by the later positive-interval validation.

**Evidence:** importing the script with a temporary non-`.env` config containing `FIRMWARE_SERVER_PORT=not-a-port` raised an uncaught `ValueError` at line 1154 before CLI validation/logging. The shared renderer validates only the port used to generate FC parameters; runtime config is not equivalently validated.

**Fix:** retain raw config until after argparse, use typed validators that produce `parser.error`, validate both intervals and port range 1–65535, and instantiate the handler with the validated port rather than a class-import constant. Regression-test invalid numeric values.

### Medium — `--no-fc` does not implement the advertised diagnostics-only behavior

The CLI example says `--no-fc` is “diagnostics only” (`2765-2770`), but `run()` always starts `FCLogSyncer.run_sync_loop()` (`2699-2705`) and `_initial_fc_connect()` (`2689`); the job loop also attempts a MAVSDK connection for every supported job before dispatch (`2630-2635`). With no MAVSDK system, `_check_arm_state()` returns safe/disarmed (`476-489`), so HTTP log activity can run without the arm safeguard.

**Fix:** do not create/start FC-specific loops or dispatch FC jobs when `--no-fc` is selected, and report an explicit unsupported-job failure without attempting an empty connection string. If HTTP-only logs are intended in this mode, document that separately and require a reliable arm-state source.

### Medium — `LOG_STORE_DIR` is not constrained to an absolute path before being rendered in a systemd path list

The installer creates and writes `LOG_STORE_DIR` (`83-85`) and inserts it into `ReadWritePaths=` (`115`) but does not require an absolute path. `quiver_systemd_path` quotes it but does not validate its form. The default is safe (`companion-config.example:65`), yet an interactive/configured relative value produces a unit setting systemd ignores and a service-relative cache path that may differ from the installer’s current-working-directory path.

**Evidence:** a temporary equivalent unit with `ReadWritePaths=relative-fc-logs /tmp` yielded `ReadWritePaths= path is not absolute, ignoring: relative-fc-logs` from `systemd-analyze verify`.

**Fix:** reject non-absolute/control-character `LOG_STORE_DIR` in the installer and runtime; resolve once, create/chown that exact path, and use that exact absolute value in unit policy. Test a relative input is rejected before dependency installation and unit creation.

### Low — the documented `.service` template is not the installer’s source of the deployed unit

`logs-ota.service` presents itself as an installer-rendered template (`1-12`), but `install_logs_ota.sh:92-121` instead writes a separate heredoc and never reads that template. The two have already diverged (for example template `NoNewPrivileges=true` vs installer’s root-dependent value at `117`). This is a maintenance/stale-suite risk: fixing the template alone will not affect installed units.

**Fix:** either render the template as the single deployment source or remove/clearly label it as illustrative only. Add a test that detects divergence between the deployment renderer and the distributed template’s directive contract.

## Configuration and compatibility observations

`load_environment()` is called before service defaults (`63-67`), supports the documented `QUIVER_ENV_FILE` overlay, fails closed for a specified missing file, synchronizes `HUB_URL`/`WEB_SERVER_URL`, and derives the FC web URL only when it is not explicit. Its literal parser avoids shell evaluation. These portions matched the immediate docs/tests. The parser/path findings above are consumers of otherwise correctly loaded values.

Python syntax compilation passed under the audit host’s Python 3.12. The service uses `asyncio.timeout`, which is available on Python 3.13. Current `aiohttp` declares Python 3.13 support, and current `python-socketio` requires Python >=3.8; neither was identified as the Python 3.13 blocker.[3] [4] The blocking issue is specifically the unpinned `mavsdk` package/API transition.

No Raspberry Pi, flight controller, serial device, Hub endpoint, real systemd service, package installation, or firmware operation was used. All runtime evidence came from temporary files and local stubs; systemd evidence came from local `systemd-analyze verify` on temporary unit files. Existing installed files on the reported Pi may still contain the pre-checkpoint quoted `WorkingDirectory=` defect, so their actual contents remain necessary to identify the exact reported startup rejection.

## References

[1]: https://pypi.org/project/mavsdk/ "MAVSDK PyPI package metadata"
[2]: https://mavsdk.mavlink.io/main/en/python/migration.html "Migrating from MAVSDK-Python"
[3]: https://pypi.org/project/aiohttp/ "aiohttp PyPI package metadata"
[4]: https://pypi.org/project/python-socketio/ "python-socketio PyPI package metadata"
