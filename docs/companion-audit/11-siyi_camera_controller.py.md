# Read-only audit — `companion_scripts/siyi_camera_controller.py`

**Scope:** all 885 lines of the assigned file, plus its direct contracts: `companion_config.py`, `companion-config.example`, `siyi-camera.service`, `install_camera_services.sh`, `installer_common.sh`, setup docs, Hub Socket.IO handler, CameraFeed UI, bundled SIYI SDK PDF, and relevant tests. Repository files and Git configuration were not modified. No hardware, real network service, package install, or system service was used.

## Systemd conclusion for the reported failure

The current source has the earlier **`WorkingDirectory=` quote fix**: `installer_common.sh:41-50` renders a literal absolute directory, and a temporary rendered `siyi-camera.service` passed that directive on local systemd 255. Therefore this source alone does **not** establish that the Pi's reported `WorkingDirectory= path is not absolute` came from the current suite; installed files may indeed be stale as the docs say. Inspect the Pi's actual `/etc/systemd/system/*.service` files and run `systemd-analyze verify` there.

However, the current camera template has a separate, confirmed systemd-255 parsing flaw: it quotes `EnvironmentFile=`. A generated unit with a space-containing temporary install path produced: `EnvironmentFile= path is not absolute, ignoring: "…/companion-runtime.conf"`. `systemd-analyze verify` still exits zero, which explains why the existing regression only checking exit status misses it. This is a source bug after checkpoint `6c3420a`, but it is a warning/ignored setting in the local reproduction rather than proof of the Pi's exact fatal message.

## Findings

### 1. Critical — confirmed: required API key is never sent or checked for the camera Socket.IO bridge
**Lines:** controller 509-516, 669-704, 800-825; immediate Hub contract `server/websocket.ts:87-144`.

`api_key` is required by the CLI and stored, but has no subsequent use: `AsyncClient.connect()` receives only URL and `transports`. The controller docstring says authentication is passed as a query parameter, but none is passed. The Hub Socket.IO server also has no connection middleware and accepts `register_companion` solely by arbitrary `droneId`/`type`; it forwards an arbitrary `camera_command` to that room.

**Impact:** an unauthenticated Socket.IO peer can register/subscribe against a chosen drone ID, inject commands through the Hub routing path, and spoof status/response messages. This is not just a missing hardening recommendation: the command path has no credential use at either end.

**Fix:** define one authenticated Socket.IO contract. For example, bridge `connect(..., auth={"apiKey": self.api_key, "droneId": self.drone_id})`; add server middleware that validates the key and binds an immutable authorized drone ID to `socket.data`; reject mismatched `register_companion`, command, status, and response events. Do not rely on a client-supplied room name.

**Evidence/test:** static search found the only `api_key` controller occurrences are initialization/CLI; local inspection of `websocket.ts` shows no `io.use()`/auth validation.

### 2. High — confirmed: generated `EnvironmentFile=` is quoted and systemd ignores it
**Lines:** template `siyi-camera.service:15`; renderer `install_camera_services.sh:58, 105`; quoting helper `installer_common.sh:31-39`.

The installer renders `EnvironmentFile="/path with space/.env"`. In a temporary rendered SIYI unit, local `systemd-analyze verify` (systemd 255) emitted `EnvironmentFile= path is not absolute, ignoring: "…"`. Raw and backslash-escaped paths both produced no diagnostic. The same helper affects all camera-generated units, so it is relevant to the all-installer report.

The subsequent `Environment="QUIVER_ENV_FILE=…"` happens to let `companion_config.load_environment()` load the file itself, but systemd's advertised environment-file behavior is broken and can diverge from the runtime loader.

**Fix:** add a directive-specific EnvironmentFile formatter (separate from word-quoting `ExecStart`/`Environment`) and emit an absolute path without surrounding double quotes; retain percent escaping and reject line breaks. Update all unit templates/generators consistently. Make tests fail on `systemd-analyze verify` diagnostics, not only non-zero status, with an install directory containing spaces and `%`.

**Evidence/test:** local temporary fixture tested quoted/raw/backslash/`\\x20` forms; only quoted produced the warning. Existing `companion-camera-install.test.ts:35-45` asserts only verifier status and therefore passes despite stderr.

### 3. High — confirmed: UI/Hub command envelope does not match this controller's command parser
**Lines:** controller 534-586, 685-695; Hub relay `server/websocket.ts:58-62, 131-136`; UI `client/src/components/apps/CameraFeedApp.tsx:600-626`.

The controller requires top-level `action` plus `params` containing `yaw`/`pitch`, `direction`, etc. The current UI emits `{ droneId, command: { type: "rotate", yawSpeed, pitchSpeed } }`; it similarly sends `recordToggle` and zoom `level`. The Hub relays that object unchanged. Thus `handle_command()` receives no `action`, selects `""`, and returns `Unknown action:`. Even after an envelope adapter, UI names and field names differ (`rotate.yawSpeed` vs `rotate.yaw`, `zoom.level` vs `set_zoom.level`, `recordToggle` vs `record`/`stop_record`).

**Fix:** choose and document one typed protocol. Either adapt the controller at ingress to validate and translate `{command:{type,…}}`, or change the UI to emit the controller's documented `action`/`params` schema. Add an end-to-end stubbed Socket.IO contract test for every action and a rejection test for malformed payloads.

**Evidence/test:** direct comparison of the cited code paths; no hardware inference required.

### 4. High — confirmed: `get_camera_status()` reads the wrong bytes
**Lines:** 348-360.

The bundled SDK PDF's 0x0A ACK defines payload fields as: byte 0 reserved, byte 1 `hdr_sta`, byte 2 reserved, byte 3 `record_sta`. The controller uses bytes 0 and 1 as HDR/recording and requires only two bytes. A local `_send_command` stub returning the valid payload `[0, 1, 0, 2]` yielded `CameraStatus(hdr_enabled=False, recording=True, tf_card_present=True)`, whereas it means HDR on, no TF card, not recording.

**Fix:** require at least four payload bytes, parse `hdr_sta=response[1]` and `record_sta=response[3]`, and unit-test off/on/no-card payloads from the SDK table.

### 5. High — potential hardware/protocol blocker: outbound control byte conflicts with every bundled SDK request example
**Lines:** 58-60, 173-200, 261-285, 299-306.

The code's normal command path calls `_build_frame(..., need_ack=True)`, which emits CTRL `00`; the hard-coded heartbeat emits `01`. The bundled SDK's textual field description calls `00` “need_ack,” but all published **outbound** samples—including firmware request, manual zoom, photo, rotation, absolute zoom, and heartbeat—use CTRL `01`. Local construction shows the mismatch exactly: controller firmware request `55 66 00 00 00 00 00 01 c4 81` versus SDK sample `55 66 01 00 00 00 00 01 64 c4`; controller's 4.5x absolute zoom likewise differs while using the same payload/sequence. CRC16 itself matches the sample when CTRL is `01`.

This is a confirmed code/documentation discrepancy with high operational risk, but whether the camera accepts CTRL `00` cannot be confirmed without a device capture. Do **not** blindly invert the constant based solely on this audit; reconcile against SIYI's authoritative current protocol or a safe captured exchange, then make `need_ack` and response expectations consistent and test exact known-good frames.

### 6. High — confirmed: “async” socket I/O blocks the event loop and leaves timeout mode enabled
**Lines:** 235-241, 279-282.

`connect()` performs blocking `socket.connect()` inside an `async def` after setting a five-second socket timeout. More seriously, `_send_command()` changes the nonblocking socket to a positive timeout and then calls `loop.sock_recv`. The initial `recv` can synchronously wait for that timeout; it is not an asyncio timeout. A local socketpair reproduction with a 0.10s command timeout showed a concurrent 10ms ticker stalled for 0.106s and the socket retained `gettimeout()==0.1` after the command. Repeated commands retain that state. Python's selector-loop source confirms `sock_recv` expects nonblocking sockets (and rejects any nonzero timeout under debug mode).

**Fix:** set sockets nonblocking once; use `await asyncio.wait_for(loop.sock_connect(...), 5)` and `await asyncio.wait_for(loop.sock_recv(...), timeout)` rather than `settimeout`. Ensure cancellation/error paths close the socket and clear `connected`.

### 7. High — confirmed for lifecycle; potential physical consequence: no fail-safe gimbal stop on shutdown, disconnect, or camera I/O failure
**Lines:** 250-259, 288-293, 629-733, 791-793, 850-859.

SDK 0x07 explicitly requires a `(0, 0)` command after release to stop velocity motion. `stop()` merely sets a flag, but `run()` is blocked in `await self.sio.wait()` and does not call Socket.IO disconnect, camera zero-velocity, or camera disconnect. A local fake Socket.IO client confirmed that after `bridge.stop()`, `run()` remained pending and neither Socket.IO nor camera `disconnect()` was called. `_send_command()` also logs a broken socket but retains `connected=True`; the outer loop therefore does not reconnect. `--test` actively centers then rotates at speed 30 but lacks a `finally` that stops motion/disconnects if interrupted.

The exact camera behavior after TCP loss was not hardware-tested, so continued physical motion is a safety risk rather than a hardware-confirmed result.

**Fix:** create an idempotent async shutdown path that cancels/awaits tasks, disconnects Socket.IO to unblock `wait`, makes a bounded best-effort zero-velocity command when connected, then closes/clears the camera socket. Invoke it on SIGTERM/SIGINT, Hub disconnect, I/O failure, and test-mode `finally`. Add a timeout/dead-man policy so a lost Hub/client cannot sustain velocity indefinitely.

### 8. Medium — confirmed: photo/record calls report success even when no command was sent; recording outcome is not tracked
**Lines:** 454-470; protocol feedback 0x0B/0x0C.

`capture_photo()` and `start_recording()` discard `_send_command()`'s return and always return `True`. A local subclass whose send routine returned `None` still logged “command sent” and returned `True` for both methods. The SDK says 0x0C has no direct ACK and exposes actual photo/record outcomes through 0x0B function feedback (including recording failure, started, stopped), which the controller never consumes. SDK compatibility tables describe func type 2 as start/stop; `stop_recording()` sends it again, so success cannot be asserted without feedback/status.

**Fix:** return false when send fails; separate “accepted for transmission” from completed camera outcome. Parse and dispatch 0x0B feedback, reconcile recording state, and only expose a confirmed result after feedback/status. Prefer an explicit state machine rather than a UI toggle inferred as start/stop.

### 9. Medium — confirmed: absolute zoom decimal conversion is wrong for common decimal values
**Lines:** 439-452.

`int((level - integer_part) * 10)` truncates binary floating-point artifacts. Local standard-Python repro: `1.2` encodes `[1, 1]` (1.1x) and `4.1` encodes `[4, 0]` (4.0x). This is deterministic under the current runtime and produces a legitimate but incorrect camera command.

**Fix:** validate a finite numeric range, quantize with `Decimal(str(level))` (or integer tenths from the API) using an explicit rounding policy, then `divmod(tenths, 10)`. Test all one-decimal levels and boundary clamping.

### 10. High — potential protocol reliability failure: no TCP frame reassembly, no strict CRC rejection, and no response correlation
**Lines:** 203-233, 261-293, 299-306.

TCP is a byte stream, but one `sock_recv(256)` is treated as one complete frame. The header length is not checked before CRC slice/unpack; a partial locally generated frame produced `struct.error`. Multiple frames are also collapsed to the first payload. CRC mismatch only logs and returns payload—local corruption of one CRC byte still returned `(cmd_id=7, payload=b'\\x01')`. The parser discards sequence/command identity, so asynchronous 0x0B function feedback following no-ACK photo/video can be consumed as the next command's response.

Fragmentation/coalescing and camera feedback ordering are standard TCP/protocol risks; they were not exercised against hardware, hence this finding is potential in field but confirmed by implementation and local parser repro.

**Fix:** maintain a receive buffer; extract only complete length-delimited frames; reject bad CRC/invalid control values; match expected command and sequence; dispatch unsolicited function feedback separately. Serialize heartbeat through the same transport lock or make it part of one writer task.

### 11. Medium — confirmed: malformed config or command values cause opaque service errors rather than controlled validation
**Lines:** 50-52, 374-377, 392-399, 430-452, 479-483, 534-610.

`SIYI_SDK_PORT=int(...)` executes at import, so a bad shared-config value aborts service startup with a raw traceback; local `SIYI_SDK_PORT=not-a-port` reproduced this. Incoming command fields are untyped: invalid strings/coordinates raise TypeError/`struct.error` and become an error response only after reaching control code. Focus coordinates are documented as `0-1000` but are neither clamped nor validated; negative values cause pack failure.

**Fix:** validate config ports (integer 1–65535) with a concise startup message before bridge creation, and validate/normalize every action's schema and finite/range constraints before invoking camera methods. Return stable `invalid_params` errors without logging untrusted values as exceptions.

## Additional verified notes

- Python syntax compiles on local Python 3.12 and parses with the Python 3.13 grammar setting. `install_camera_services.sh` installs `python3`, `python3-pip`, `python-socketio[asyncio_client]`, and `aiohttp` using `--break-system-packages`, so no Python-3.13-specific dependency-install blocker was confirmed by static/local checks. Python 3.13 itself was not installed in this sandbox.
- The shared loader is literal-only and the current service `Environment="QUIVER_ENV_FILE=…"` overlay supplies the intended canonical path, but the quoted systemd `EnvironmentFile=` defect must still be fixed.
- `load_environment()` alias normalization works for normal one-alias source precedence. An explicitly supplied config containing conflicting `HUB_URL=` and nonblank `WEB_SERVER_URL=` resolves both to blank because `HUB_URL` wins ties; installers synchronize aliases, so this is a lower-priority manual-config edge case rather than a principal blocker.
- The controller does not perform firmware flashing or firmware writes. Hardware behavior, actual SIYI acceptance of CTRL `00`, physical gimbal stop behavior after link loss, and Pi-installed unit contents were not tested.
