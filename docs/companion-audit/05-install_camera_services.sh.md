# Audit — `companion_scripts/install_camera_services.sh`

## Findings

### High — Confirmed: the fresh installer writes quoted `EnvironmentFile=` directives that systemd ignores

**Lines:** `install_camera_services.sh:59, 105, 127, 154`; direct helper contract `installer_common.sh:31–38`; rendered templates `camera-stream.service:16`, `siyi-camera.service:15`.

`unit_path()` calls `quiver_systemd_path()`, which emits a double-quoted systemd word. The installer uses that output for `EnvironmentFile=`, producing, for example, `EnvironmentFile="/path/to/.env"`. On systemd 255, `systemd-analyze verify` reports `EnvironmentFile= path is not absolute, ignoring: "..."`. The exit code remains zero, which is why the existing mocked regression passes: it asserts only exit status and not verifier diagnostics.

This is not the earlier quoted-`WorkingDirectory` failure. Current source correctly emits a literal `WorkingDirectory`; a clean normal-path render had no bad-unit-setting error. However, the quoted `EnvironmentFile` defect is still real and materially breaks the Funnel unit: `tailscale-funnel.service` expands `${TAILSCALE_FUNNEL_PORT}`, `${GO2RTC_API_HOST}`, and `${GO2RTC_API_PORT}` solely from that file at lines 154–157. With the file ignored, it invokes Tailscale with empty endpoint values. The Python camera and SIYI services partly mask the defect because the separate valid `Environment="QUIVER_ENV_FILE=…"` assignment lets `companion_config.py` load the file itself; go2rtc also passes the config filename explicitly to its renderer.

**Reproduction:** Rendered all four units from the actual functions into a temporary directory with a normal executable `go2rtc` stub. `systemd-analyze verify` returned `0` but emitted the quoted-`EnvironmentFile` diagnostic for every unit. A minimal systemd 255 fixture showed that `EnvironmentFile=/absolute/path with spaces/file.conf` is accepted while `EnvironmentFile="/absolute/path with spaces/file.conf"` is ignored.

**Fix:** Do not use the generic ExecStart/Environment word formatter for `EnvironmentFile=`. Add a directive-specific formatter for an absolute EnvironmentFile path (no outer quotes; preserve/escape `%` for specifier parsing and reject control characters), then use it at lines 59 and 105. Re-render the templates and generated units. Extend each installer integration test to fail if `systemd-analyze verify` emits `EnvironmentFile= path is not absolute` (not merely on a nonzero exit code).

Systemd documents `EnvironmentFile=` as a filename directive and its `Environment=` quoting example separately; the observed parser behavior is therefore not a test-harness artifact. [1]

### Medium — Confirmed: installer accepts Funnel ports that both the runtime CLI and Tailscale reject

**Lines:** `install_camera_services.sh:180, 194`, with generated use at `156–157`; runtime contract `camera_stream_service.py:699–701`.

The installer calls only `require_port`, so `TAILSCALE_FUNNEL_PORT=12345` passes. A noninteractive temporary config fixture confirmed `configure_camera_environment` exits `0` and preserves `12345`. The installed camera runtime’s `argparse` independently restricts `--funnel-port` to `443`, `8443`, or `10000`, and its own help text documents those values. Tailscale’s official Funnel documentation likewise limits Funnel to exactly those three ports. [2]

**Impact:** Even after the EnvironmentFile defect is fixed, the installer can persist a configuration that makes `tailscale-funnel.service` fail at first start.

**Fix:** Replace the generic port predicate for `TAILSCALE_FUNNEL_PORT` with a `case` allowing only `443|8443|10000`, before any package/download work. Keep the same allowed set in the example config, runtime CLI, and documentation. Add a mocked installer regression that supplies `12345` and expects an early error.

### Medium — Confirmed: `GO2RTC_EXTERNAL=true` causes the async camera manager to repeatedly “start” an externally managed process

**Lines:** installer sets the mode at `install_camera_services.sh:233`; deployed runtime behavior is `camera_stream_service.py:339–345`, `537–555`, and `610–619`.

The installer deliberately sets `GO2RTC_EXTERNAL=true` and starts a separate `go2rtc.service`. In that mode `_start_go2rtc()` does not spawn a duplicate process, but it also never assigns `self.go2rtc_process`. The main loop nevertheless treats `self.go2rtc_process is None` as a reason to call `_start_go2rtc()` every loop iteration. The method synchronously performs a `requests.get(..., timeout=3)` and logs “Starting go2rtc”; `get_status()` permanently reports `go2rtc_running=False` because it only considers a local `Popen` object.

**Reproduction:** With a temporary named config, in-memory HTTP stub, and patched async sleep (no process or network), two loop iterations produced two external API probes, left `go2rtc_process is None`, and returned `reported_go2rtc_running=False`.

**Impact:** It does not launch a second listener, but it creates misleading logs/status and blocks the async event loop for up to three seconds per retry during local API failure. This weakens the health/retry behavior that the installer is meant to deploy.

**Fix:** Branch the startup state machine: when `GO2RTC_EXTERNAL` is true, never gate progress on `self.go2rtc_process`; health-check the systemd-owned API with a nonblocking client or `asyncio.to_thread`, and report that health as external-go2rtc state. Keep the owned-process path unchanged. Add a regression asserting no `_start_go2rtc()` calls after external mode is established and a truthful status result.

### High — Confirmed immediate runtime contract failure: the installed SIYI controller turns an asyncio socket into a blocking socket before `sock_recv`

**Lines:** installer deploys/starts this runtime at `install_camera_services.sh:271, 279, 295`; deployed controller defect is `siyi_camera_controller.py:235–242`, `261–293`, especially `280–282`.

`connect()` correctly sets the socket nonblocking. `_send_command()` then calls `self.socket.settimeout(timeout)` immediately before `await loop.sock_recv(...)`. In CPython, a positive timeout puts the socket in timeout/blocking mode. `loop.sock_recv()` requires a nonblocking socket. The intended restoration at line 282 happens only after a successful receive, so a timeout/error leaves subsequent operations in the wrong mode too.

**Reproduction:** A Python stdlib-only `socket.socketpair()` was set nonblocking, then given `settimeout(2.0)` exactly as the controller does. `await loop.sock_recv()` blocked until and raised `TimeoutError`; no hardware or network was used. Python documents the nonblocking precondition explicitly. [3]

**Impact:** A SIYI command that expects a reply can block this service’s event loop and time out rather than awaiting readiness correctly. That directly affects gimbal status/control behavior deployed by this installer. This is confirmed source/runtime behavior, not a claim that a camera was tested.

**Fix:** Leave the socket nonblocking and apply `await asyncio.wait_for(loop.sock_recv(self.socket, 256), timeout)`; restore nonblocking state in a `finally` if legacy paths need it. Use `get_running_loop()`. Add socketpair tests for both response and timeout paths, including a follow-up send/receive after timeout.

### Low — Confirmed: accepted installation paths containing a quote produce a systemd bad-unit-setting failure

**Lines:** install-directory acceptance is in the immediate shared contract `installer_common.sh:94–104`; rendering consumers are `install_camera_services.sh:57–67, 104–110, 126–131`.

The prompt accepts any absolute `INSTALL_DIR` except newline/CR. A path containing `'` or `"` is then embedded in executable paths. Actual-renderer temporary fixtures on systemd 255 produced `Executable name contains special characters` followed by `Unit configuration has fatal error` / `bad unit file setting` for `go2rtc.service`. Ordinary spaces and percent signs worked; literal quotes did not.

**Fix:** Before directory creation or service writes, reject quote characters (and any other systemd-incompatible command-path characters validated by a focused fixture) with a clear prompt error. Retain supported spaces. Add quote-path negative tests and assert full verifier diagnostics, not status alone.

### Medium — Confirmed: elevated installation executes mutable, unverified remote artifacts

**Lines:** `install_camera_services.sh:206–209, 224–231, 244–245`.

The script runs as root, calls `apt-get`, installs unpinned Python packages directly into the system interpreter with `--break-system-packages`, downloads the moving GitHub `releases/latest` go2rtc asset without a version pin, checksum, signature, or architecture/file-format verification, and pipes Tailscale's current remote installer directly into `sh`. This is confirmed by the exact command paths; no download or package install was performed during this audit.

**Impact:** A compromised/replaced release asset, package index response, or installer endpoint runs with root authority during provisioning. Availability also becomes nondeterministic when a latest asset or Python dependency changes; the `aarch64 → arm64` selection itself is correct, but it is not integrity validation.

**Fix:** Use an approved versioned go2rtc release plus a maintained checksum/signature manifest; fetch then verify before `install`. Prefer the distribution/vendor signed Tailscale repository over `curl | sh`, and use a versioned virtual environment or pinned/hashes Python requirements rather than mutating the OS interpreter. Preserve the `--break-system-packages` path only if that system-wide installation is an explicit operational requirement.

### Medium — Potential safety/recovery concern: service definitions are overwritten before a full preflight validation or rollback point

**Lines:** writes at `install_camera_services.sh:98, 116–164, 277–286`; activation at `289–296`.

The installer overwrites four system units directly (`tee` for two generated units, `install` for two rendered templates), then reloads/enables/restarts them. It neither stages and verifies the full unit set nor preserves an installed-unit backup. The standalone repair script has the stronger pattern—stage all units, run `systemd-analyze verify`, and only then replace—but this installer does not use it.

**Impact:** A malformed selected path, template regression, or future systemd compatibility issue can replace an otherwise working installation and leave services failed when the first `systemctl restart` aborts under `set -e`.

**Fix:** Render/stage all four files in one private temporary directory, run `systemd-analyze verify` with a suitable unit search path and a `tailscaled.service` dependency available, then atomically install them; keep one non-overwritten backup or leave prior definitions untouched on validation failure. This is particularly important because the current quoted-EnvironmentFile warning returns verifier status zero.

### Low — Confirmed stale setup documentation conflicts with the deployed camera runtime

**Files/lines:** `docs/reference/SIYIA8MiniCameraServices.md:47–49, 85–98, 121–125` versus installer/runtime `install_camera_services.sh:204–209` and `camera_stream_service.py:685–715`.

The legacy reference still describes FFmpeg, `websockets`, RTSP endpoints `/video1` and `/video2`, `python-socketio[client]`, and a `camera_stream_service.py --port 8080` command. The current installer installs go2rtc, `requests`, `python-socketio[asyncio_client]`, and `aiohttp`; the current parser has no `--port` option and derives the `/main.264` or `/sub.264` source. Following that manual section will fail or configure the wrong pipeline.

**Fix:** Replace it with the current companion-suite README/service reference, or mark it historical and remove executable instructions. The current `companion_scripts/README.md` and `COMPANION_SERVICES.md` correctly describe the shared configuration and corrected literal `WorkingDirectory` model.

## Scope notes and validation

All 326 lines of the assigned shell file were reviewed, along with its shared installer/configuration contract, both rendered templates, camera/SIYI runtimes, example config, current companion setup docs, repair script, and the mocked installer test. `bash -n` and the existing mocked integration test passed; that test uses real `systemd-analyze verify` but misses diagnostics because quoted `EnvironmentFile=` is a warning with exit code zero. Python compile and CLI-help paths passed under the sandbox’s Python 3.12; the installer’s `python3 -m pip install --break-system-packages` correctly targets the selected Debian system `python3`, but Python 3.13 itself was not available here, so no Python-3.13 runtime execution is claimed.

No project file, Git configuration, package, network service, actual systemd unit, Tailscale state, SIYI camera, go2rtc binary, or firmware/flight-controller operation was changed or tested. The assigned installer contains no firmware flashing or FC parameter command; accordingly, no hardware/firmware-operation claim is made. Current source no longer emits quoted `WorkingDirectory`; if Raspberry Pi units still report that exact error, they are likely installed stale definitions and should be inspected directly rather than inferred from the source suite.

## References

[1]: https://www.freedesktop.org/software/systemd/man/systemd.exec.html "systemd.exec manual"

[2]: https://tailscale.com/kb/1223/funnel "Tailscale Funnel documentation"

[3]: https://docs.python.org/3/library/asyncio-eventloop.html "asyncio event loop documentation"
