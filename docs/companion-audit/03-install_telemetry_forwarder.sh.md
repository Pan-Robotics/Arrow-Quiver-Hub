# Audit: `companion_scripts/install_telemetry_forwarder.sh`

Reviewed the complete 71-line installer at `6c3420a`, its immediate contracts (`installer_common.sh`, `companion_config.py`, `telemetry_forwarder.py`, `telemetry-forwarder.service`), companion setup/repair documentation, and the focused installer regression. The current `WorkingDirectory` rendering is correct: it is literal and absolute at line 45. An older installed unit can still retain the pre-checkpoint quoted `WorkingDirectory`; source changes do not alter an installed unit until the installer or repair script is run.

## Confirmed findings

### Critical — unpinned `mavsdk` now installs an API incompatible with the runtime

**Installer:** `install_telemetry_forwarder.sh:27` installs unversioned `mavsdk`. **Runtime contract:** `telemetry_forwarder.py:36,119-140` uses the legacy `System()` constructor and async `System.connect()`/`drone.telemetry` API.

A temporary, non-hardware import check against the current package selected by that command produced: `TypeError: System is not constructed directly, get it from Mavsdk instead. Since v4, the 'mavsdk' package is the native MAVSDK binding ... pin 'mavsdk<4'`. The current PyPI release does publish a Python-3.13-compatible, aarch64 `abi3` wheel, so on Debian Trixie arm64 the installation can succeed while the worker then fails at runtime rather than exposing a dependency-resolution error. [1] [2]

**Impact:** telemetry cannot start with the package the installer currently selects. Because the worker failure is also swallowed (next finding), the unit can remain `active` while sending no data.

**Fix:** pin and test the legacy dependency stack that matches this code on Trixie/aarch64, including its daemon/dependency behavior, or migrate the runtime to the current native MAVSDK v4 API. Add an installer smoke test that imports the installed package and exercises only the API surface used here; do not treat successful `pip install` as proof of compatibility.

### High — current renderer still emits a malformed `EnvironmentFile=` directive

**Installer:** `install_telemetry_forwarder.sh:46` applies `quiver_systemd_path()` to `EnvironmentFile`. That helper (`installer_common.sh:31-38`) produces a quoted word. The isolated rendered result was:

```ini
EnvironmentFile="/tmp/.../telemetry-config"
```

`systemd-analyze verify` (systemd 255) reports `EnvironmentFile= path is not absolute, ignoring: "/tmp/.../telemetry-config"`. A direct A/B temporary-unit repro confirmed that the unquoted form is accepted, including an absolute filename containing spaces, while the quoted form is ignored. This follows the documented requirement that `EnvironmentFile=` receive an absolute filename. [3]

The runtime will usually still discover the file via the separately correct `Environment="QUIVER_ENV_FILE=..."` line and `load_environment()`, so this is not proof that *this* directive alone prevents process startup. It is nevertheless a confirmed invalid directive, produces the observed class of systemd diagnostic, contradicts the documentation's claim that systemd loads the shared file, and is a likely source of confusion during deployment.

The template is correct on this point (`telemetry-forwarder.service:16` has an unquoted placeholder), but the installer does not render from it. The repair script (`repair_companion_services.sh:41-58`) repairs only quoted `WorkingDirectory`; it leaves this malformed line in place. The regression at `server/companion-installers.test.ts:154,159` explicitly expects the invalid quoted form and checks only `systemd-analyze`'s zero exit code, which does not fail on this warning.

**Fix:** add a single-path formatter for `EnvironmentFile=` that rejects CR/LF/NUL and percent-escapes without adding quotes; use it at line 46. Keep quoted word escaping for `Environment=` and `ExecStart=`. Update the repair script to normalize the old quoted `EnvironmentFile=` form, align its generated-unit check with stderr/warnings rather than exit status alone, and revise the current expectation in the regression.

### High — MAVLink worker failures are logged then converted into a permanently healthy-looking unit

**Runtime:** `telemetry_forwarder.py:117-149` catches every connection/setup exception, logs it, and returns. `start()` then remains in an unconditional loop at lines 404-410 without checking whether `mavlink_thread` died. `Restart=always` in the generated unit (`install_telemetry_forwarder.sh:50`) only applies when the main process exits, so it cannot recover the failed worker.

A bounded subprocess with a stub whose `System.connect()` raises confirmed the behavior: it logged `simulated MAVSDK connect failure` and `MAVLink worker stopped`, yet the top-level process stayed alive until killed by the test timeout (exit 124). This applies both to the confirmed current MAVSDK incompatibility and to ordinary setup/disconnect failures. The connection-state wait at lines 123-126 also has no timeout or liveness escalation.

**Fix:** supervise workers from the main thread. On a non-cancellation MAVLink setup failure, either retry with bounded exponential backoff or cause the main process to exit non-zero after a clear error so systemd restart/start-limit handling is meaningful. Track created collector tasks, propagate fatal task exceptions, and handle `SIGTERM` by calling `stop()` rather than relying only on `KeyboardInterrupt`.

### Medium — installer accepts invalid required telemetry configuration and fails only after system changes

**Installer:** lines 13-20 accept a blank `WEB_SERVER_URL`, arbitrary `UPDATE_RATE_HZ`, and arbitrary CAN interface; line 16 validates only `API_KEY`. The first-run template leaves both Hub URL aliases blank (`companion-config.example:24-25`). With a blank Hub URL, the runtime rejects the configuration at `telemetry_forwarder.py:445-446`, after the installer has already run apt/pip, copied files, written the unit, enabled it, and attempted a restart.

A temporary stubbed CLI repro returned the expected `--hub-url is required` error. A nonnumeric `UPDATE_RATE_HZ` crashes during module import at line 49 before argparse can display its later range validation; `0` reaches argparse and exits with `--update-rate-hz must be greater than zero`. These bad settings then repeatedly restart until the unit's start limit is reached.

**Fix:** validate before lines 25-27: require an absolute HTTP(S) Hub URL (warn or reject plaintext HTTP according to product policy), nonempty drone ID, numeric finite positive rate with a reasonable upper bound, and a valid simple SocketCAN interface name when UAVCAN is enabled. Write only normalized values. Retain the existing safe alias behavior: `quiver_set WEB_SERVER_URL` correctly synchronizes `HUB_URL`, and the isolated render contained both aliases.

### Medium — default DroneCAN monitoring creates an active, fixed-ID CAN node without an explicit safety gate

**Installer/config:** lines 18-19 prompt DroneCAN options but default from `companion-config.example:60-62` is `ENABLE_UAVCAN=true`, `CAN_INTERFACE=can0`. **Runtime:** `telemetry_forwarder.py:50-51,282-290` opens SocketCAN and instantiates node ID `111`, described only in a comment as unique; it is not configurable or collision-checked.

This worker does not contain actuator or firmware-update commands. However, a fake transport repro of the installed DroneCAN `Node` class showed one outbound CAN frame after 1.3 seconds of `spin()`, consistent with automatic node-status publication. Thus enabling this option causes bus transmission, not passive battery observation. On a real vehicle, a duplicate node ID or an incorrectly selected interface is an operational/safety concern; this audit did not open `can0` or test a vehicle bus.

**Fix:** default this optional functionality to disabled, require explicit operator opt-in, add a validated configurable node ID (1–127) and collision/health guidance, and state in the prompt/docs that enabling it transmits DroneCAN protocol/status traffic. Do not claim passive-listener behavior unless implementation is changed and tested.

## Potential hardening issue

### Low — externally supplied `QUIVER_ENV_FILE` is not rejected when it contains control characters

`installer_common.sh:103-105` checks only that `QUIVER_ENV_FILE` begins with `/`; unlike `INSTALL_DIR` at lines 99-100, it does not reject CR/LF/NUL. `quiver_systemd_path()` does not escape newlines. A safe formatter repro rendered a physical multi-line unit value when given a newline path. This requires a privileged caller-controlled environment value, so it is not a normal prompt-path injection route, but it can make a malformed unit and should be closed while adding the `EnvironmentFile=` formatter.

**Fix:** apply the same CR/LF/NUL validation to `ENV_FILE` before directory creation/rendering, and validate `QUIVER_SYSTEMD_DIR` as an absolute newline-free directory before line 31.

## Contracts checked without finding an additional blocker

The installer runs only as root, uses argument-safe filesystem calls for its normal user-selected paths, locks the shared configuration to the selected service account through `quiver_set`, and does not execute `.env` content as shell code. `ProtectSystem=strict`, `ProtectHome=read-only`, and `ReadWritePaths=INSTALL_DIR` do not conflict with the inspected runtime, which does not persist telemetry locally. The REST payload and `/api/rest/telemetry/ingest` handler agree on `api_key`, `drone_id`, ISO timestamp, and telemetry object fields. The current source/template/docs are clear that firmware-puller configuration is separate; this installer itself does not update flight-controller firmware.

## Verification limits

No Raspberry Pi, `can0`, MAVLink endpoint, Hub, flight controller, target package manager, or real systemd service was used. All systemd results came from temporary units and `systemd-analyze verify`; all runtime behavior came from temporary Python dependency stubs except the isolated current-MAVSDK API import check. That initial temporary renderer inadvertently allowed pip to fetch sandbox-only packages; they were immediately removed. No project source, Git configuration, target device, service, firmware, or managed `.env` was modified.

## References

[1]: https://pypi.org/project/mavsdk/ "MAVSDK PyPI release metadata"
[2]: https://packages.debian.org/trixie/python3 "Debian Trixie python3 package"
[3]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html "systemd.exec EnvironmentFile documentation"
