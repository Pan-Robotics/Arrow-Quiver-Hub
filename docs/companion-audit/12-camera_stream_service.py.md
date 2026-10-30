# `camera_stream_service.py` audit

## Confirmed findings

### High — rendered `EnvironmentFile=` is still invalid when the path is quoted

**Locations:** `camera-stream.service:16`; `install_camera_services.sh:59, 71–95`; `installer_common.sh:31–38`; regression `server/companion-camera-install.test.ts:154, 164`.

The checkpoint fixed `WorkingDirectory=` by using `quiver_systemd_directory`, but the camera installer still feeds `ENV_FILE_PLACEHOLDER` through `quiver_systemd_path()`. The generated line is therefore `EnvironmentFile="/absolute/path/runtime.conf"`. `EnvironmentFile=` requires an absolute pathname; the surrounding quote becomes part of the value. `systemd-analyze verify` on a rendered temporary camera unit (systemd 255) emitted:

```text
EnvironmentFile= path is not absolute, ignoring: "/tmp/.../my camera companion/runtime.conf"
```

The same reproducer passed with the literal path, including spaces. `verify` returned zero despite the diagnostic, so the existing test only checking its exit status misses the defect and explicitly asserts the wrong quoted output. Systemd documents that `EnvironmentFile=` takes an absolute filename, while its word-quoting rules apply to `Environment=` rather than making quote characters valid in the path.[1]

This is a direct plausible cause of the reported “bad unit file setting” on current Raspberry Pi OS. It also affects the other installers because they share `quiver_systemd_path()`. `QUIVER_ENV_FILE` may let Python reread the selected file after systemd ignores it, but that does not make the generated unit valid and breaks normal systemd configuration loading.

**Fix:** Add/use a directive-specific absolute `EnvironmentFile` formatter: reject non-absolute/newline/NUL input and emit the raw path with percent escaping only. Keep `quiver_systemd_path()` for `Environment=` assignments and `ExecStart` words. Update all unit renderers and the repair tool; it currently repairs only quoted `WorkingDirectory=`. Amend the camera test to fail on verifier stderr containing `path is not absolute` and expect `EnvironmentFile=/path with spaces/config`, not quotes. Correct the documentation statement that `EnvironmentFile` should remain quoted.

**Test:** Render every unit into temporary directories with and without spaces, invoke `systemd-analyze verify`, and assert clean stderr as well as zero status.

### High — installed external-go2rtc mode never reaches a steady lifecycle state

**Locations:** `camera_stream_service.py:336–346, 537–555`; installer contract `install_camera_services.sh:233, 292–296`; docs `COMPANION_SERVICES.md:98–100`.

The installer writes `GO2RTC_EXTERNAL=true`. In that mode `_start_go2rtc()` merely GETs `/api/streams` and returns `True`; it deliberately does not create `self.go2rtc_process`. The next loop immediately satisfies `self.go2rtc_process is None` at line 540, so it calls `_start_go2rtc()` again every loop. A temporary-config/stub repro with the actual external setting recorded a `start` call even though the external service was assumed healthy. In production that means a new synchronous API request and “Starting go2rtc” message roughly every two seconds; failure accounting is also applied to a separately managed unit.

**Fix:** Branch lifecycle control by `GO2RTC_EXTERNAL`. In external mode, do not use `go2rtc_process is None` as the start predicate; run only a health check and leave restart ownership to `go2rtc.service`. Alternatively use an explicit external-availability state, but never create/kill a local process sentinel for the external service. Make `_stop_go2rtc()` a documented no-op in that mode and avoid incrementing child-process reconnect state.

**Test:** With a temporary config containing `GO2RTC_EXTERNAL=true` and `SKIP_FUNNEL_SETUP=true`, stub successful health/API calls for several iterations and assert no local start attempt after initial observation. Separately test local mode creates and stops one child.

### High — the Tailscale Funnel contract is stale, and the shipped default target is not supported by current Funnel docs

**Locations:** `camera_stream_service.py:211–248`; `install_camera_services.sh:156`; `companion-config.example:45`; docs `COMPANION_SERVICES.md:102–104`.

The target’s standalone setup runs `tailscale serve --bg --https=<port> http://localhost:<port>` and then `tailscale funnel <port> on`. Current Tailscale documentation says the current form is one direct command, `tailscale funnel --https=<port> <target>`, and notes that the CLI changed in v1.52. It also says reverse-proxy targets currently support only `http://127.0.0.1`, not `http://localhost`.[2] The shared template defaults `GO2RTC_API_HOST=localhost`, and the generated persistent Funnel unit therefore also targets `http://localhost:…`. This can prevent the public signaling service from being configured on a current install even after the unit parsing issue is fixed. The target’s comments describe the obsolete two-step form.

**Fix:** Default `GO2RTC_API_HOST` to `127.0.0.1` consistently in the template/docs, validate any Funnel proxy host against the supported loopback target, and replace the target’s two-step setup with the current direct `tailscale funnel --bg --https=<allowed-port> http://127.0.0.1:<api-port>` form. Use the corresponding current `off` form for teardown if needed. Preserve an explicit compatibility policy if older Tailscale releases must remain supported.

**Test:** Unit-test constructed argv for current direct Funnel syntax and 443/8443/10000 only; use a mocked `tailscale` binary, not a real tailnet.

### Medium — `--go2rtc-api` does not act as the documented “strongest whole-URL override”

**Locations:** `camera_stream_service.py:317–324, 417–444, 717–724`.

With only `--go2rtc-api http://127.0.0.1:2999`, the service health endpoint is `:2999`, but `args.api_port` remains the default 1984. Local go2rtc configuration is generated with `listen: "127.0.0.1:1984"`; local WebRTC fallback and Funnel setup also use 1984. A safe Python reproduction showed exactly this divergence. It defeats a manual alternate-endpoint invocation and could cause the manager to monitor one go2rtc while starting/publishing another.

**Fix:** Parse the override once with `urllib.parse.urlsplit`; either derive `api_port` and host from it when `--api-port` is absent, or reject conflicting combinations. Pass a single normalized endpoint model to config generation, health checks, Funnel setup, and fallback URL generation.

**Test:** Cover URL-only, port-only, matching URL+port, and conflicting URL+port cases, including an IPv6 literal if it is supported.

### Medium — synchronous operations block the service’s asyncio loop; combined mode can delay camera control and shutdown

**Locations:** `camera_stream_service.py:139–208, 211–258, 400–413, 446–500, 526–603, 668–673`.

`run()` directly invokes blocking `subprocess.run`, `time.sleep`, and `requests.get/post`. The timeout budgets include up to 15 seconds for Funnel setup, 10 seconds per Hub registration, 3 seconds per health check, and retrying Tailscale detection. `CombinedCameraService.run()` puts this streamer and the imported Socket.IO/gimbal controller on the same event loop. Therefore a stalled registration/detection can prevent heartbeat, command handling, cancellation, and cleanup from being scheduled during the blocking call. A stubbed blocking registration held the event loop for its entire duration; AST inspection confirms the synchronous helpers are called directly, not via `await`/`to_thread`.

**Fix:** Use an async HTTP client or `await asyncio.to_thread(...)` for the existing requests/subprocess functions; replace `time.sleep` with `await asyncio.sleep` in async paths. Bound startup discovery independently and make cancellation prompt. The systemd production topology runs controller and streamer separately, reducing normal impact, but `--combined` is explicitly supported and must meet its own contract.

**Test:** Run combined mode with bounded stubs that block longer than one controller tick; assert the controller task continues/cancellation completes within a short deadline.

### Medium — Hub path normalization corrupts valid URLs ending in characters from `/ws`

**Locations:** `camera_stream_service.py:460–464, 510–513`.

`rstrip("/ws")` removes any trailing `/`, `w`, or `s` characters, not the literal suffix `/ws`. A pure-string repro transformed `https://hub.example/news` into `https://hub.example/ne`, so registration/unregistration uses the wrong REST endpoint. The imported SIYI controller correctly uses exact `endswith` suffix removal, illustrating the intended behavior.

**Fix:** Normalize with an exact suffix check, for example remove `/ws` only when `rest_base.endswith("/ws")`, then perform one `rstrip("/")`. Share the normalizer with the controller if both formats must remain accepted.

**Test:** Cover root URL, `/ws`, `/socket.io`, `/news`, a trailing slash, and `ws://`/`wss://` schemes.

### Medium — malformed or unsupported environment ports crash at import or reach a downstream service unvalidated

**Locations:** `camera_stream_service.py:68–89`; `install_camera_services.sh:37–44, 180, 194`.

The target converts environment strings with unguarded `int()` at import. A temporary config with `GO2RTC_API_PORT=not-a-port` caused `--help` itself to exit 1 with a traceback before argparse. Numeric but invalid values also pass: `TAILSCALE_FUNNEL_PORT=22` was accepted and used by the target; the installer’s `require_port` checks only 1–65535 despite its prompt and CLI limiting Funnel to 443/8443/10000. Current Tailscale documentation restricts Funnel to those three ports.[2]

**Fix:** Centralize typed configuration validation before runtime constants are built. Give clear key-specific errors, enforce 1–65535 for go2rtc ports and the three allowed Funnel ports, and apply the same validator to installer-backed and manual execution. Do not rely solely on argparse, because systemd uses environment defaults.

**Test:** Temporary non-`.env` fixtures for non-integer, zero, 65536, and Funnel port 22 should produce a concise controlled configuration error; valid 443/8443/10000 should pass.

## Lower-priority hardening

**Potential — local managed-go2rtc stdout can deadlock.** At `347–366`, local mode creates a child with `stdout=PIPE` and never drains it after the three-second startup check. A harmless child writing 2 MiB remained blocked on the pipe in a temporary reproduction. Whether go2rtc emits enough logs depends on runtime verbosity, so this is not a hardware-confirmed failure. Route output to journald/inherited stdout, a rotating file, or a drain task rather than an unread pipe.

**Potential — local managed-go2rtc configuration has weak file/YAML handling.** `_write_go2rtc_config()` at `317–334` writes a predictable `/tmp/go2rtc/go2rtc.yaml` without restrictive mode/ownership checks; `generate_go2rtc_config()` inserts raw RTSP text at `108`, unlike `companion_config.render_go2rtc_config()` which JSON-quotes it. Direct local mode can expose RTSP credentials or produce malformed YAML for special values. Use a private service-owned runtime directory, 0600 atomic output, and JSON/YAML-safe scalar serialization. The installed external-go2rtc path is better: the shared renderer writes an owner-readable `$INSTALL_DIR/go2rtc.yaml` atomically.

**No Python 3.13 dependency blocker was confirmed.** The installer does use `python3 -m pip ... --break-system-packages` at `204–209`, appropriate for externally managed Debian Python. Current PyPI metadata declares Python 3.13 support for `requests` and `aiohttp`; current `python-socketio` requires Python >=3.8 and provides the `asyncio-client` extra.[3] [4] [5] Dependencies are unpinned, so repeatable releases still need version/pip-resolution tests on aarch64; none were installed in this audit.

**Firmware safety:** this assigned file contains no firmware, flight-controller write, or arm-state operation. No camera, go2rtc, Tailscale, network, package, or real systemd service was started or modified.

## Contracts reviewed

Complete `camera_stream_service.py` (lines 1–781); imported `companion_config.py` and `siyi_camera_controller.py`; `camera-stream.service` and adjacent `siyi-camera.service`; `install_camera_services.sh`, `installer_common.sh`, and repair script; camera installer tests; `companion-config.example`; and camera setup sections in `README.md` and `COMPANION_SERVICES.md`.

[1]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html "systemd.exec EnvironmentFile documentation"
[2]: https://tailscale.com/docs/reference/tailscale-cli/funnel "tailscale funnel command"
[3]: https://pypi.org/pypi/requests/json "requests PyPI metadata"
[4]: https://pypi.org/pypi/aiohttp/json "aiohttp PyPI metadata"
[5]: https://pypi.org/pypi/python-socketio/json "python-socketio PyPI metadata"
