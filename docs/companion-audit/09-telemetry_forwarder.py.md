# `companion_scripts/telemetry_forwarder.py` audit

Audited the complete 468-line assigned script at `6c3420a`, plus its direct contracts: `install_telemetry_forwarder.sh`, `installer_common.sh`, `telemetry-forwarder.service`, `companion_config.py`, the shared example configuration, repair/setup docs, the REST receiver, and relevant regression tests. No project source, Git configuration, service, package, network endpoint, CAN interface, or flight controller was changed or exercised.

## Findings

### 1. **High — confirmed:** the current telemetry installer still writes an invalid `EnvironmentFile=` directive

`install_telemetry_forwarder.sh:46` applies the general word-quoting helper to `EnvironmentFile`. The resulting unit contains `EnvironmentFile="/absolute/path/test_config"`. On real systemd 255, including with a space-containing path, `systemd-analyze verify` emits:

```text
EnvironmentFile= path is not absolute, ignoring: "/tmp/.../test_config"
```

It exits zero, which explains why the existing test (`server/companion-installers.test.ts:148-165`) passes despite the warning. A paired temporary fixture proved that `EnvironmentFile=/absolute/path with space` and `EnvironmentFile=/absolute/path\\x20with\\x20space` are accepted, while the quoted spelling is not. systemd documents `EnvironmentFile=` as an absolute filename/wildcard expression, not an `ExecStart` word list [1]. This is a separate directive-specific quoting defect from the checkpoint's `WorkingDirectory` repair; the checkpoint itself contains the same line.

For this script specifically, `Environment="QUIVER_ENV_FILE=..."` is correctly parsed and `companion_config.load_environment()` subsequently loads that file, so the process may self-mask the ignored `EnvironmentFile`. It is nevertheless an invalid deployed unit, means the manager does not supply the shared variables, produces the observed class of diagnostic, and can affect other unit consumers. It does **not** establish which directive failed on the reporter's already-installed Pi; those files may still have the older quoted `WorkingDirectory` defect.

**Fix:** add a separate absolute-`EnvironmentFile` formatter (reject non-absolute/control characters; percent-escape as needed; do not surround the complete value with quotes), use it in all installers, and update the actual template renderer/units. Extend `repair_companion_services.sh` beyond `WorkingDirectory`, and make validation fail on `systemd-analyze` diagnostics rather than only a zero exit status. Add a regression that asserts no `path is not absolute` output. The current source template is also not the source actually rendered by the telemetry installer, and differs in restart/start-limit values; eliminate that drift or render the template.

### 2. **Critical — confirmed:** an unpinned fresh install resolves the current `mavsdk` API, but this script uses the removed legacy asynchronous API

The installer runs `python3 -m pip install --break-system-packages mavsdk aiohttp dronecan` without version constraints (`install_telemetry_forwarder.sh:25-27`). The script then imports `System` from `mavsdk` and awaits its legacy methods (`telemetry_forwarder.py:36,119-140`). Current MAVSDK v4 documentation says the former `mavsdk` package was renamed to `mavsdk-grpc`, that its API is different from current native `mavsdk`, and shows v4's async API as `mavsdk.asyncio.Mavsdk` plus `add_any_connection()`/`first_autopilot()` [2] [3]. Current PyPI publishes `mavsdk` 4.1.0 for Linux aarch64 and declares Python 3.13 support [3].

Thus a Raspberry Pi OS Trixie/Python 3.13 installer can successfully install the newest package yet the forwarder fails before `main()` at `from mavsdk import System`. A temporary module with the v4-style `Mavsdk` but no legacy `System` reproduced exactly `ImportError: cannot import name 'System'`. This is independent of CAN hardware. Current DroneCAN's universal wheel declares Python >=3.7 and was uploaded using CPython 3.13, so the evidence does not indicate a Python-3.13 blocker for DroneCAN itself [4].

**Fix:** choose and test one API line before release. Either migrate this forwarder to the documented MAVSDK v4 API, or explicitly pin/install the maintained legacy `mavsdk-grpc` package and change imports consistently (or pin a verified legacy `mavsdk<4` only if it is verified on aarch64/Python 3.13). Put exact compatible constraints in a requirements/constraints file and preflight `python3 -c` imports with the same `/usr/bin/python3` used by `ExecStart` before writing/enabling the unit.

### 3. **High — confirmed:** a MAVLink startup failure permanently stops telemetry while the systemd service remains alive

`mavlink_worker_async()` catches every exception at lines 117-149 and then returns. It has no reconnect/supervision loop. `start()` leaves the main thread in an unconditional loop (lines 404-410), and the worker is a daemon thread (lines 390-400), so systemd sees a still-running main process and does not apply `Restart=always`. The same issue applies after a normal connection later ends. The connection-state async iterator also has no timeout or stop-aware wait.

A fully in-memory MAVSDK stub whose `connect()` raises showed one call, normal worker return, and `stop_event` still false. This contradicts the legacy setup guide claim that it reconnects after a flight-controller/network interruption (`docs/sdk/Quiver_SDK_Developer_Guide_Outline.md:184`).

**Fix:** run connection/collection in a stop-aware supervisor loop with bounded exponential backoff, log each state transition at warning/error level, and retry after connect/rate/subscription failures. Ensure shutdown can interrupt waiting for connection. Consider an explicit health signal or terminate the process after persistent failure if systemd restart policy is preferred.

### 4. **High — potential hardware-safety issue:** default UAVCAN mode creates an active fixed-ID DroneCAN node, not a passive battery listener

`ENABLE_UAVCAN` defaults true (`telemetry_forwarder.py:50`; `companion-config.example:60-62`). The worker opens SocketCAN and creates `dronecan.node.Node(..., node_id=111)` before spinning it (`telemetry_forwarder.py:282-318`), with `GetNodeInfo` metadata. DroneCAN requires nodes to periodically broadcast `uavcan.protocol.NodeStatus` [5]; PyDroneCAN documents that a running node should keep a thread in `spin()` and that node ID is configured on construction [6]. Therefore this code participates and transmits on the aircraft bus. It is not a receive-only monitor.

A fixed undocumented ID can collide with an existing node, and the code neither validates a configured ID nor detects collision before advertising itself. This audit did not attach to a CAN bus, so an actual collision is **not** claimed.

**Fix:** make UAVCAN opt-in until validated, add a documented/configured node ID with an allowed-range and uniqueness/operator acknowledgement check, and choose a passive/raw receive design if the product only needs battery observations. If an active node is intentional, document its NodeStatus/GetNodeInfo behavior and test it on a representative isolated CAN topology. Close the node/driver in `finally` and arrange graceful service-stop signaling.

### 5. **High — confirmed design blocker for non-root UAVCAN operation; target runtime untested:** the unit grants no raw-socket capability

The generated unit deliberately runs as the selected non-root `User=`/`Group=` and sets `NoNewPrivileges=true` (`install_telemetry_forwarder.sh:41-60`). It grants neither `AmbientCapabilities=CAP_NET_RAW` nor another raw-socket mechanism. SocketCAN uses `PF_CAN/SOCK_RAW/CAN_RAW` [7], while Linux identifies `CAP_NET_RAW` as the capability to use RAW/PACKET sockets [8]. The UAVCAN worker therefore needs an explicit privilege design; membership in a filesystem group alone does not grant the capability.

The sandbox has no AF_CAN support (`EAFNOSUPPORT`), so I did not and cannot claim an on-target Pi result. On a normal supported SocketCAN kernel, the unit policy makes the default-enabled UAVCAN worker likely to log its one startup error and stop (finding 3), while MAVLink/HTTP continues.

**Fix:** decide whether this service must be active on CAN. If yes, grant only the minimal deliberate capability (for example systemd `CapabilityBoundingSet=CAP_NET_RAW` and `AmbientCapabilities=CAP_NET_RAW` to a dedicated service account, after confirming the exact SocketCAN library behavior) and regression-test on Pi. If no, disable it by default and retain the least privilege policy.

### 6. **Medium — confirmed:** non-finite and malformed update rates are not safely rejected, with a Python 3.13-specific failure mode

Configuration is converted during import (`float(CONFIG.get(...))`, line 49), and CLI validation tests only `<= 0` (lines 439-452). A disposable stubbed CLI test showed `0` and `-1` reject, but `nan` and `inf` reach construction/start; malformed text instead produces an import-time traceback before argparse. `update_interval = 1.0 / update_rate_hz` is line 77. In Python 3.13, `asyncio.sleep(math.nan)` raises `ValueError` [9]. The periodic sender catches that exception only at debug level and immediately loops (lines 240-262), which can spin/queue-churn. `inf` produces a zero interval and sends at an unbounded rate; it is not a valid telemetry rate.

**Fix:** parse after argparse with a clear `parser.error`, require `math.isfinite(rate) and rate > 0`, and define a realistic upper bound. Reuse that validator for environment values and constructor/direct test use.

### 7. **Medium — confirmed:** failed HTTP deliveries are discarded; the documentation's local-buffer/replay claim is false

The bounded in-memory queue (size 10, lines 91 and 251-256) is only backpressure. `http_worker()` removes an item before sending (lines 347-356); timeout, exception, and every non-200 response merely log it and do not requeue (lines 361-369). A no-network in-memory HTTP stub returning 503 confirmed one POST, an empty queue, and zero successful sends. Repeated non-200 responses also have no backoff, so they can produce warning logs at the telemetry rate.

This directly conflicts with `docs/sdk/Quiver_SDK_Developer_Guide_Outline.md:184`, which says telemetry is buffered locally and transmitted after connectivity is restored. The implementation is latest-sample/drop-on-failure, not durable buffering.

**Fix:** decide the intended aircraft-telemetry semantics. If historical delivery is required, add bounded persistent spool/retry, expiry, ordering, and disk/write-path limits. If live/latest telemetry is intended, replace the false replay claim, coalesce to the newest payload, add response/error backoff, and expose dropped/failed counters.

### 8. **Medium — confirmed:** active setup docs can configure a doubled ingestion path

The script documents and implements a **Hub base URL** (`telemetry_forwarder.py:16,70,354`), appending `/api/rest/telemetry/ingest` itself. The REST server matches only `/telemetry/ingest` beneath the REST router (`server/rest-api.ts:275`). Yet the SDK outline supplies `WEB_SERVER_URL=https://your-hub.com/api/rest/telemetry/ingest` in two active examples (lines 174 and 1115), and the root README supplies a `/api/rest` suffix. Those values form respectively:

```text
.../api/rest/telemetry/ingest/api/rest/telemetry/ingest
.../api/rest/api/rest/telemetry/ingest
```

Both will fail rather than reach the receiver. The current companion README/example correctly uses a base Hub URL, so this is stale-suite documentation drift.

**Fix:** define one canonical setting name and base-URL format across root README, SDK docs, installer prompt/help, examples, and tests. Optionally normalize a legacy exact ingest URL once with a warning, but avoid silently accepting arbitrary paths.

### 9. **Medium — confirmed:** async tasks and service shutdown are not managed cleanly

After connection, six tasks are created without retaining references (lines 135-140). `stop()` only sets a threading event and joins threads for two seconds (lines 412-425); it does not cancel/await collector tasks. `mavlink_worker()` then closes the loop (lines 264-271), leaving subscriptions that may still await telemetry. The UAVCAN node/driver is also never explicitly closed. The normal systemd `SIGTERM` path is not handled; only `KeyboardInterrupt` invokes `stop()`.

**Fix:** retain tasks in a `TaskGroup` or list, cancel and `gather(..., return_exceptions=True)` on stop, close MAVSDK/UAVCAN resources, and translate `SIGTERM` to the same idempotent shutdown path. Use one long-lived event loop in the main thread rather than creating a new `asyncio.run(asyncio.sleep(1))` loop each second.

## Checked contracts with no defect found

- `companion_config.py` correctly reads literal values without shell evaluation, resolves `HUB_URL` to `WEB_SERVER_URL`, honors an existing explicit `QUIVER_ENV_FILE`, and preserves quoted literal content. An isolated non-dotfile fixture returned the same URL through both aliases and retained `#`, `$HOME`, escaped quotes, and whitespace as data.
- The forwarder payload field names and 200-success handling match the inspected REST endpoint's required `api_key`, `drone_id`, `timestamp`, and object `telemetry` fields (`server/rest-api.ts:275-344`).
- Python syntax compilation passed. No firmware-flashing, MAVLink command, flight-mode, or parameter-write call exists in this assigned file. Hardware/vehicle behavior was not tested.

## Validation evidence and limits

- Rendered the current telemetry installer in an isolated temporary tree with fake `apt-get`, `pip`, and `systemctl`; no package install, daemon reload, enablement, or service start occurred. The generated unit reproduced the `EnvironmentFile=` warning under real `systemd-analyze verify` 255.
- Used temporary in-memory MAVSDK/DroneCAN/aiohttp stubs for failure and HTTP-delivery behavior. No MAVLink, CAN, Hub, or Internet endpoint was contacted.
- Compiled the assigned Python files. The sandbox is Python 3.12/systemd 255 and has no AF_CAN support, not Raspberry Pi OS Trixie aarch64/Python 3.13. The Trixie/Python-3.13 dependency conclusion is based on current package metadata/docs, not an installation on hardware.
- The assigned file and its tracked immediate contracts remain unmodified. Existing unrelated working-tree changes (`todo.md` and files created by other work) were not touched.

## References

[1]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html "systemd.exec EnvironmentFile documentation"
[2]: https://github.com/mavlink/MAVSDK-Python "MAVSDK-Python legacy wrapper and migration guidance"
[3]: https://mavsdk.mavlink.io/main/en/python/quickstart.html "MAVSDK v4 Python QuickStart"
[4]: https://pypi.org/project/dronecan/ "DroneCAN PyPI package metadata"
[5]: https://dronecan.github.io/Specification/6._Application_level_functions/ "DroneCAN application-level functions"
[6]: https://dronecan.github.io/Implementations/Pydronecan/Tutorials/2._Basic_usage/ "PyDroneCAN basic usage"
[7]: https://docs.kernel.org/networking/can.html "Linux SocketCAN documentation"
[8]: https://man7.org/linux/man-pages/man7/capabilities.7.html "Linux capabilities"
[9]: https://docs.python.org/3.13/library/asyncio-task.html "asyncio tasks and sleep"
