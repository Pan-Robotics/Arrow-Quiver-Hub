# Companion Suite Consolidated Audit

**Date:** 2026-10-30  
**Scope:** Companion installers, shared configuration and repair tooling, Hub/telemetry/Logs & OTA/camera runtimes, and the two Lua companion applets named in the supplied companion audits.  
**Disposition:** Sections 1–7 preserve the initial read-only audit and pre-fix line references. The final **Parent remediation and target-version validation** section records implemented changes and measured acceptance tests. **Firmware promotion remains blocked** pending a safe target-specific atomic-rename implementation; backend authorization and hardware/protocol gates remain unresolved. No live companion/FC/camera/network state or managed web-app `.env` was changed.

---

## 1. Executive repair decision

The suite has several **verified blockers** that can prevent a fresh companion deployment from working, plus critical OTA/control-plane safety defects. Repair should begin with one bounded installer/systemd hardening change set, validate it on staged files, then separately address MAVSDK compatibility and the OTA security/safety path before deployment to an aircraft or production companion.

### Verified blockers and highest-priority defects

| Priority | Deduplicated root cause | Status | Principal affected locations | Why it matters |
|---|---|---|---|---|
| P0 | **Quoted `EnvironmentFile=` is emitted by the shared systemd formatter.** Systemd treats the quotes as literal filename characters, reports the path non-absolute, and ignores the directive. | **Verified** on temporary systemd 255 fixtures; applies to current generated source. | `companion_scripts/installer_common.sh:31-38`; rendered by `install_hub_client.sh:161-175`, `install_telemetry_forwarder.sh:46`, `install_logs_ota.sh:105`, and `install_camera_services.sh:59,105,127,154`; templates at `siyi-camera.service:15` and `camera-stream.service:16`. | Shared configuration is not loaded directly through the declared unit directive. Funnel expansion is especially exposed. Current tests miss the diagnostic because `systemd-analyze verify` exits zero. |
| P0 | **Fresh MAVSDK installs are API-incompatible with two legacy runtimes.** Unpinned `mavsdk` can install v4 while the telemetry and Logs/OTA code use the legacy `System`/`mavsdk.ftp` API. | **Verified** with import/API checks and package metadata; no target install was performed. | `install_telemetry_forwarder.sh:27`; `telemetry_forwarder.py:36,119-140`; `install_logs_ota.sh:76`; `logs_ota_service.py:86-90`. | A package install can succeed on Trixie/Python 3.13 while the unit fails or loses FC/MAVFTP functionality at runtime. |
| P0 | **Logs & OTA can expose firmware and request reboot without a fresh armed-state interlock.** | **Verified** by source/control-flow and local stubs; physical vehicle effect remains hardware-dependent. | `logs_ota_service.py:1919-2263`, especially `2124-2133`; installer deployment at `install_logs_ota.sh:77,124`; related Lua flow `firmware_puller.lua:233-337`. | Firmware delivery/reboot may proceed when aircraft state is armed or unknown. Must fail closed before operational use. |
| P0 | **Firmware-pull completion is forgeable/premature.** The temporary server is unauthenticated and completion can be inferred from bytes served rather than a validated FC acknowledgement. | **Verified** by static route/control-flow and local stubs; network/FC exploitation was not performed. | `logs_ota_service.py:1349-1429`, `1392-1397`, `1411-1420`, `1476-1496`, `2093-2097`; `firmware_puller.lua:329-337`. | A LAN peer can cause a premature completion/reboot path or the service can stop serving before delivery is proved. |
| P0 | **Hub upload/update jobs permit unsafe file writes.** Client-side paths lack containment/symlink/atomic-write protection, while the server accepts arbitrary upload target paths. | **Verified** with temporary traversal fixture and source-contract trace. | `raspberry_pi_client.py:175-229,248-297`; `server/routers.ts:1117-1191`; installer writable paths at `install_hub_client.sh:175`. | A Hub-controlled job can replace executable/configuration content in the writable install tree and take effect after restart. |
| P0 | **Privileged installer helpers trust service-account-controlled configuration for ownership and copy destinations.** | **Verified** using temporary fixtures only. | `installer_common.sh:53-64`, `75`, `103-126`; direct caller configuration paths as listed below. | Root setup can chown arbitrary existing directories/files or overwrite an external referent through a destination symlink. |
| P1 | **Runtime configuration is insufficiently typed and bounded.** Invalid numeric, URL, and absolute-path fields are accepted by installers or parsed at import time, causing restart loops, busy loops, or inconsistent systemd policy. | **Verified** for the cited inputs. | Hub: `raspberry_pi_client.py:401-405,350-360`; telemetry: `telemetry_forwarder.py:49,77,238-262,439-452`; Logs/OTA: `logs_ota_service.py:1154,2782-2786`; camera: `camera_stream_service.py:68-89`; installers cited in Sections 5–8. | Deployment can complete, enable `Restart=always`, then fail continuously or run an unsafe cadence. |
| P1 | **Service repair validates too weakly and only fixes the old `WorkingDirectory=` issue.** It can report success while leaving an ignored `EnvironmentFile=`, fatal drop-in, or an unloaded post-repair definition. | **Verified** on disposable systemd/`systemctl` stubs. | `repair_companion_services.sh:30-34,41-58,54-55,61-72,77-90,83-90,98-127`. | Repair may give an operator false assurance and leave the live manager on an old definition after reload failure. |

### Important distinction: current source vs. stale deployed units

* **Current source:** quoted `EnvironmentFile=` is reproduced and is a real current-source defect.
* **Reported fatal `bad unit file setting`:** a **quoted `WorkingDirectory=`** produces the fatal parser error in temporary fixtures. Current generators use a literal `WorkingDirectory=`, so audits did **not** reproduce that fatal defect from current source. It remains a **hardware/deployment-dependent stale-unit possibility** that requires direct inspection of installed Pi unit files and drop-ins.
* `EnvironmentFile=` warnings may not themselves stop a unit because valid `Environment=` assignments may still pass `QUIVER_ENV_FILE`; they nevertheless violate the declared unit contract and can prevent features which rely on direct environment-file expansion (notably Funnel) from working.

---

## 2. Audit boundary, confidence, and non-claims

### Evidence used by the supplied audits

The independent audits used static source/AST/control-flow review; Bash/Python syntax and compilation checks; temporary non-`.env` configuration fixtures; Python standard-library stubs; disposable unit trees; and local `systemd-analyze verify` on systemd 255/255.4. Focused repository tests were run where explicitly reported.

No audit installed, enabled, reloaded, started, stopped, or restarted a live unit. No audit modified a project file, production configuration, Git configuration, package state, firmware, or hardware. No real Hub/API request, flight-controller link, CAN/MAVLink device, camera, Tailscale state, go2rtc binary, package installation, or firmware action was run unless a per-finding fixture explicitly says otherwise.

### Classification used in this report

* **Verified blocker/defect** — reproduced on temporary fixtures, confirmed by source/control-flow, or directly demonstrated with a harmless stub. “Verified” does not mean physically validated on the target aircraft or Pi.
* **Potential / hardware-dependent risk** — design/protocol/policy issue with strong code evidence, but its particular field manifestation requires target hardware, a real network, a target OS, installed files, or a safe bench.
* **Not a repair claim** — fixes below are proposed, bounded remediation work only. The parent validation record should be appended after repairs are made.

---

## 3. Deduplicated root-cause register

### RC-01 — Incorrect systemd directive quoting and incomplete unit validation

**Status:** Verified current-source issue.

`quiver_systemd_path` in `companion_scripts/installer_common.sh:31-38` applies shell-like double-quoting to `EnvironmentFile=`. Systemd parses this as a filename including quotes and reports `EnvironmentFile= path is not absolute, ignoring`. Temporary tests showed that unquoted literal absolute paths, including paths with spaces, parse cleanly; systemd 255 can still return exit code zero when emitting the warning.

**Affected render sites / audit citations:**

* `install_hub_client.sh:161-175`.
* `install_telemetry_forwarder.sh:46`.
* `install_logs_ota.sh:104-106` and `105`.
* `install_camera_services.sh:58-59`, `105`, `127`, `154`; all four generated camera units were rendered in the audit.
* `siyi-camera.service:15` and `camera-stream.service:16`.
* Shared helper contract documented by `companion_config.py` audit: `installer_common.sh:31-38`.
* Documentation incorrectly endorsing quote treatment: `README.md:161`, `COMPANION_SERVICES.md:170`.
* Current repair logic leaves this directive unchanged: `repair_companion_services.sh:41-58,77-90`.

**Related input validation defect:** `QUIVER_ENV_FILE` accepts merely-leading-slash input at `installer_common.sh:75,103-120`; it can be unnormalized (`/a/../b`), contain CR/LF, and point at unrelated existing files. A newline can split a rendered directive. Camera path handling similarly accepts quote characters, producing a bad unit setting through render sites at `install_camera_services.sh:57-67,104-110,126-131`; shared path contract is `installer_common.sh:94-104`.

**Required remediation:**

1. Introduce a directive-specific formatter for `EnvironmentFile=` only: require a normalized absolute single-line path, reject NUL/CR/LF and incompatible characters, and emit the systemd literal/escaping form **without outer quotes**. Do not repurpose word quoting intended for `ExecStart=`, `Environment=`, and `ReadWritePaths=`.
2. Canonicalize privileged path inputs with `realpath -m` after an approved-root policy is established; reject a non-approved existing file/directory before ownership changes.
3. Stage every generated unit, run `systemd-analyze verify` on the staged set, and fail when verifier stderr contains relevant diagnostics rather than relying on process exit status alone. Use `--recursive-errors=yes` where supported and define a compatibility policy.
4. Update the repair tool to transform only recognized Quiver-owned units, back them up, repair historical quoted `EnvironmentFile=` safely, validate staged output, and retry/persist a pending `daemon-reload` after a failed reload.
5. Update `README.md:161`, `COMPANION_SERVICES.md:170`, and camera/OTA documentation to describe the actual directive grammar.

**Primary regression cases:** paths with spaces, percent signs, apostrophes/double quotes, `..`, CR/LF, and a scoped stale unit; assert clean verifier output. Add an invalid drop-in case and a simulated failed/retried daemon reload.

### RC-02 — Privileged configuration, ownership, and copy boundary is not safe

**Status:** Verified in disposable fixtures.

The root helper accepts paths resolved from service-account-writable configuration and then creates/chowns them. `quiver_configure` changed a root-owned temporary `CONFIG_DIR`/`PARSERS_DIR` to `daemon:daemon` at `installer_common.sh:122-126`. `quiver_copy` follows an existing destination symlink and overwrites the referent at `installer_common.sh:53-64`. `QUIVER_ENV_FILE` can identify an unrelated existing configuration file and cause it to be merged/chowned at `installer_common.sh:75,103-120`.

A separate verified usability/runtime boundary follows from the same flow: a non-root Hub bootstrap selecting a different `SERVICE_USER` makes the shared file selected-user `0600`, after which unprivileged `quiver_get` fails. Exact cited locations: `installer_common.sh:20,119-124`.

**Required remediation:**

1. Make managed configuration/code destinations root-owned and choose a restricted, installer-owned root (for example, a fixed Quiver state tree) rather than trusting arbitrary configuration paths.
2. Resolve/check parent and target components without following symlinks; reject pre-existing symlinks and unexpected existing directories/files. Stage content in a verified directory and atomically replace only verified regular files.
3. Require root for a cross-account initial bootstrap, or retain privileged reads while ensuring secrets are not exposed. Add a cross-account bootstrap regression.
4. Make all relevant path validators shared and invoke them **before** `mkdir`, `chown`, copying, or unit rendering.

### RC-03 — MAVSDK dependency/API contract is unpinned and incompatible

**Status:** Verified import/API incompatibility; target Trixie/aarch64 execution remains unperformed.

The telemetry and Logs/OTA installers install unbounded `mavsdk` at `install_telemetry_forwarder.sh:27` and `install_logs_ota.sh:76`. Their runtimes use legacy APIs:

* telemetry: `telemetry_forwarder.py:36,119-140`.
* Logs/OTA: `logs_ota_service.py:86-90`, with dependent FC/MAVFTP behavior cited at `900-904`.

Local checks showed current MAVSDK v4 behavior differs: legacy `System()` use fails/is incompatible and `mavsdk.ftp` is unavailable, while current package metadata advertises Python 3.13/aarch64 support. Thus this is not evidence that Python 3.13 is unsupported; it is a major-version/API mismatch.

**Required remediation:** choose and implement exactly one supported path:

* **Compatibility path:** pin a tested legacy stack (including daemon behavior) such as a verified `mavsdk<4` or `mavsdk-grpc`/`mavsdk_grpc` design as appropriate; or
* **Migration path:** port both runtimes to MAVSDK v4 APIs and test all affected functionality.

Use versioned constraints (and preferably a venv/locked hashes where compatible with deployment policy). Before enabling/restarting a unit, invoke the same `/usr/bin/python3` used by `ExecStart` for an import/API smoke test. On an isolated Pi/Trixie aarch64 fixture, test connection setup only against a safe stub/simulator before testing an FC.

### RC-04 — OTA trust, integrity, and state-gating are unsafe

**Status:** Critical code defects verified; vehicle/network consequences require controlled target validation.

This is a single remediation program, not independent cosmetic changes:

1. **Arming gate missing:** Logs/OTA `handle_flash_firmware` does not invoke arm-state checks before serving/updating/rebooting (`logs_ota_service.py:1919-2263`, especially `2124-2133`; audit trace `1919-2244`). Existing arm checks are only in `FCLogSyncer` (`471-489,608,708,754`).
2. **Unauthenticated transfer endpoints / premature completion:** the runtime binds on `0.0.0.0`, exposes status/download/ack paths, accepts arbitrary acknowledgement, and accepts full bytes served as successful receipt (`logs_ota_service.py:1349-1429`, `1411-1420`, `1486-1496`, `1491-1496`). The `firmware_puller.lua` contract makes the same risk visible at `329-337`. A local stub verified bytes-served with no ACK can return completion.
3. **Hash verification optional:** missing `sha256Hash` logs a warning and continues at `logs_ota_service.py:2007-2029`; `server/routers.ts:1547-1552` can produce null hash. This conflicts with documentation’s SHA-256 assurance.
4. **False job success:** reboot/manual timeout paths report completed (90/95%) and return success at `logs_ota_service.py:2220-2244`, completed by the job loop at `2652-2653` (also cited as `2641-2653`).
5. **Lua receiver integrity/I/O defects:** firmware puller overwrites capped size with unvalidated `Content-Length`, succeeds at `>=`, and does not check write/flush/close results (`firmware_puller.lua:219-226,279-304,293-294,302-303,311-313,329-337`). Opening the final bootloader-visible destination before transfer validation can leave partial content (`37,78-83,233-241,329-337`).
6. **Legacy manual PUT endpoint is unsafe if enabled:** `net_webserver_put.lua:734,788-790` writes `/APM/` final paths without an armed-state gate, staging, checksum, or filename restriction. It also accepts surplus body bytes (`318-329,653-668,799-808`) and ignores filesystem errors (`655-658,707,717,804-805`).

**Required remediation:**

* Fail closed unless fresh, bounded telemetry confirms **DISARMED**; recheck immediately before transfer exposure and immediately before reboot. Unknown/timeouts must fail, including no-FC mode.
* Bind/restrict the transfer server to an intentional interface and configured FC peer policy. Use a fresh per-job high-entropy capability on status/download/ack and validate source/peer policy; do not treat local socket bytes written as receiver delivery.
* Require a syntactically valid SHA-256 for unattended jobs; decide/document whether it covers source APJ or final ABIN; verify size/hash before serve and only consider a durable, authenticated acknowledgement with expected size/digest as completion.
* Replace success-on-timeout with a nonterminal/manual-verification or failed state. Only complete the Hub job after explicit post-flash success conditions.
* Download/write to a safe staging name; enforce exact bounded content lengths; check all I/O; remove incomplete output; promote only after verified completion and target-filesystem semantics are bench-validated.
* Default-disable, remove, or explicitly isolate the legacy `net_webserver_put.lua` deployment path. If retained, make it staged, armed-gated, hashed, exact-length, bounded-header, and restricted to a safe filename.

### RC-05 — Hub job control plane permits arbitrary writes and weak artifact handling

**Status:** Verified by temporary traversal fixture and source-contract inspection.

`raspberry_pi_client.py:175-229,248-297` allows download/update paths without containment, symlink, extension, or atomic replacement protections. A stub showed `allowed/../escaped-write.txt` escaping the nominal root. The upstream server upload API accepts unvalidated `targetPath` at `server/routers.ts:1117-1191`. The unit’s allowed writable locations are at `install_hub_client.sh:175`.

Artifact handling also buffers entire bodies, allows unbounded gzip expansion, writes non-atomically without a digest, and can outlive the job timeout: `raspberry_pi_client.py:210-229`. Job response shape validation is absent at `67-98,125-126,166-169,203-205` and malformed valid JSON can terminate the process. Invalid polling configuration is parsed at `401-405` and loop validation at `350-360` accepts zero/negative behavior described in the audits.

**Required remediation:**

1. Require authenticated/authorized upload creation and job dispatch. Permit writes only under dedicated configured data roots; resolve and enforce containment, reject symlink traversal, and prohibit generic writes to executable/configuration roots.
2. Use streamed bounded downloads to a safe temporary file; enforce compressed and decompressed size limits; require server-provided size/SHA-256; verify, `fsync`, then atomically replace a verified regular destination.
3. Validate configuration schemas before accepting `update_config`; align server metadata/job lease timeouts with artifact transfer behavior.
4. Validate response objects, jobs, and per-job failures without terminating the polling loop. Add bounded backoff and tests for shape errors, timeout/503, transfer recovery, concurrency, traversal, symlinks, and checksum mismatch.

### RC-06 — Installer/runtime values are under-validated and error handling causes restart/busy loops

**Status:** Verified for cited fixtures.

Recurring forms:

* **Hub:** installer accepts non-HTTPS `ftp://` URL at `install_hub_client.sh:126-132`, while API key is sent in GET query input; `POLL_INTERVAL` invalid/zero/negative behavior resides in `raspberry_pi_client.py:401-405,343-366` (and `350-360`). `--local` misses the required runtime file at `install_hub_client.sh:34-36,137-182`.
* **Telemetry:** installer accepts blank Hub URL/malformed/nonpositive rate at `install_telemetry_forwarder.sh:13-20,25-27`; runtime accepts malformed/nonfinite rate at `telemetry_forwarder.py:49,77,238-262,439-452`.
* **Logs/OTA:** installer accepts invalid `POLL_INTERVAL`/`DIAGNOSTICS_INTERVAL` at `install_logs_ota.sh:62-63`; runtime performs unguarded port parsing at `logs_ota_service.py:1154,2782-2786`; relative store paths pass installer and are ignored by systemd `ReadWritePaths=` at `install_logs_ota.sh:59,83-85,115` and runtime use at `logs_ota_service.py:432`.
* **Camera:** Funnel ports are accepted at `install_camera_services.sh:180,194` though supported values are 443, 8443, 10000; runtime ports are unguarded at `camera_stream_service.py:68-89`; a whole URL and a separate port can conflict at `317-324,417-444,717-724`.
* **Shared aliases/parser:** blank `HUB_URL` masks a valid `WEB_SERVER_URL` at `companion_config.py:167-175,192-208,255-270`; the same installer-facing bug appears at `install_logs_ota.sh:25`. Parser grammar differs from systemd escapes/continuations at `companion_config.py:29-65`; multi-line quoted values are truncated per the immediate contract at `companion_config.py:29-65,82-94`.

**Required remediation:** make a single typed validation layer used before package work, persistent writes, unit rendering, and runtime construction. Require normalized HTTPS base URLs unless an explicit development-only HTTP flag is deliberately documented; send credentials in an authenticated header/POST design rather than a URL query. Require finite, bounded positive numerical values; require absolute normalized state paths; allow only documented Funnel ports; and provide user-facing errors rather than import-time tracebacks. Treat blank aliases as absent where the peer is nonblank.

### RC-07 — Supervision, retry, and async lifecycle are incomplete

**Status:** Verified by stubs/control-flow; external services/hardware were not used.

* Telemetry worker failures are swallowed and the main process remains alive (`telemetry_forwarder.py:110-149,377-410`; source audit also cites `117-149,404-410`). Consequently systemd does not restart it.
* Telemetry dispatch drops samples on failures/non-200 (`91,238-262,344-369`) and does not create a durable/replay queue despite related documentation.
* Logs/OTA runs blocking `requests`/filesystem work directly in async paths (`logs_ota_service.py:491-525,575-651,1753-1897,2611,2664-2665`) and can starve safety scheduling.
* Camera stream runs blocking subprocess, sleep, and HTTP functions in its async loop (`camera_stream_service.py:139-208,211-258,400-413,446-500,526-603,668-673`).
* Camera external go2rtc mode cannot reach a stable managed state (`camera_stream_service.py:336-346,537-555`; installer setting `install_camera_services.sh:233`).
* Telemetry task and resource shutdown is unmanaged (`telemetry_forwarder.py:135-140,264-271,315-326,404-425`).

**Required remediation:** explicitly choose fail-fast systemd restart versus bounded internal retry for each critical worker; supervise liveness; add exponential bounded backoff and observability; keep blocking operations out of async loops; retain/cancel/gather tasks; close resources; map SIGTERM to idempotent shutdown; and test no-pending-task/resource leak behavior.

### RC-08 — Camera command/control path has verified schema, socket, and safety defects

**Status:** Many source/stub defects verified; protocol framing/control-byte interoperability and physical effect require bench confirmation.

* API key is stored but not sent/verified in Socket.IO; Hub registration has no auth middleware: `siyi_camera_controller.py:509-516,669-704,800-825`, with server contract `server/websocket.ts` as audited.
* UI/Hub command envelope differs from controller expectations: controller `534-586,685-695`.
* Status payload offsets are wrong: `348-360`.
* Socket is made timeout/blocking before `loop.sock_recv`: `235-241,279-282`; installer audit also cites controller `280-282`.
* Stop/disconnect does not ensure zero velocity/cleanup: `250-259,288-293,629-733,791-793,850-859`.
* TCP response handling assumes one receive equals a full frame and accepts corrupt/uncorrelated data: `203-233,261-293,299-306`.
* Send failures can still report photo/record success: `454-470`; zoom float encoding is inaccurate: `439-452`; invalid configuration/commands can throw raw exceptions: `50-52,374-377,392-399,430-452,479-483,534-610`.
* `CTRL=00` vs bundled SDK `CTRL=01` mismatch is a **potential hardware/protocol blocker** at `58-60,173-200,261-285,299-306`; do not change it only from static evidence. Capture/validate a safe exchange first.

**Required remediation:** define a typed authenticated socket contract and test both ends; use fully nonblocking asyncio I/O with timeouts and final cleanup; implement a framed buffered transport with CRC/sequence/command correlation and unsolicited feedback handling; ensure exactly-once best-effort zero-velocity on all shutdown/failure paths; and bench-test the control byte/frame against a non-operational camera.

### RC-09 — Camera service integration and Tailscale invocation are stale/inconsistent

**Status:** Verified from current code/documentation checks; external service behavior not run.

* External `go2rtc` state is repeatedly treated as absent (`camera_stream_service.py:336-346,537-555`).
* Funnel command syntax/proxy target is stale for current CLI documentation: `camera_stream_service.py:211-248`; installed generated Funnel uses the host at `install_camera_services.sh:156`. Default localhost reverse-proxy target is incompatible with cited Funnel documentation.
* Normalization uses `rstrip('/ws')` and corrupts valid paths, e.g. `/news`: `camera_stream_service.py:460-464,510-513`.
* Camera setup guide conflicts with current installer/runtime at `docs/reference/SIYIA8MiniCameraServices.md:47-49,85-98,121-125`.
* Root installs mutable/unverified remote inputs at `install_camera_services.sh:206-209,224-231,244-245`.
* Unit deployment overwrites/restarts without full staged validation/rollback: `install_camera_services.sh:98,116-164,277-296`.

**Required remediation:** use documented current Funnel argv and allowed ports; normalize endpoints once; split external health monitoring from child process supervision; version-pin and verify remote binaries/packages; stage/validate/atomically promote the complete unit set; and rewrite/remove stale executable documentation.

### RC-10 — Telemetry transport, CAN defaults, and URL contract have safety/reliability gaps

**Status:** Mixed: code behavior verified; raw CAN permission and bus impact are hardware-dependent.

* Default `ENABLE_UAVCAN=true` makes an active fixed-ID DroneCAN node (`telemetry_forwarder.py:50-51,282-318`; `companion-config.example:60-62`), not a passive listener. This is a **potential field safety blocker** until a safe virtual/bench bus validates node ID, NodeStatus traffic, collision handling, and shutdown.
* Non-root systemd unit policy has no explicit raw-socket capability for CAN (`install_telemetry_forwarder.sh:41-60`; `telemetry_forwarder.py:282`). This is a **hardware/platform-dependent deployment risk**; sandbox lacked AF_CAN.
* Documentation/example can pass a complete REST endpoint even though runtime appends it, creating a doubled URL: `telemetry_forwarder.py:16,70,354`; `docs/sdk/Quiver_SDK_Developer_Guide_Outline.md:174,1115`.

**Required remediation:** default UAVCAN off until intentionally configured; choose a unique validated node ID and least privilege (or a passive design); validate behavior on an isolated Pi CAN test fixture; standardize a single base-URL format and table-test URL construction.

### RC-11 — Lua applets require hardening if retained

**Status:** Current logical defects verified from source/model; no Lua interpreter/FC hardware was used.

**Firmware puller:** block/wedge risk due to SocketAPM send/partial-write handling and no status deadline at `firmware_puller.lua:97-116,178-195,354-377`; path/data integrity issues are covered in RC-04. It also shares the FC-server unauthenticated route concern at `335-336`.

**Legacy PUT applet:** unbounded header accumulation at `net_webserver_put.lua:303-331`; `content_type` can call `string.lower(nil)` for extensionless files at `560-566`; direct final file PUT risk is in RC-04. Require a strict request/header size cap, safe defaults, exact content-length parsing, filesystem result checks, staging, armed gate, and an explicit enablement policy.

### RC-12 — Documentation/template drift undermines repairability

**Status:** Verified source/document comparisons.

* `logs-ota.service:1-43` is described as installer-rendered but `install_logs_ota.sh:92-121` uses a divergent heredoc.
* `README.md:161` and `COMPANION_SERVICES.md:170` describe unsuitable `EnvironmentFile=` quoting.
* `docs/reference/SIYIA8MiniCameraServices.md:47-49,85-98,121-125` directs legacy FFmpeg/websocket/manual-port workflow.
* Telemetry URL docs at `docs/sdk/Quiver_SDK_Developer_Guide_Outline.md:174,1115` conflict with the current appending runtime.

**Required remediation:** have one authoritative unit-rendering source (or mark illustrative templates explicitly), tie docs/config examples/tests to generated output, and add a drift test that compares rendered units and documented commands to the actual supported contract.

---

## 4. Bounded remediation plan and acceptance tests

The tasks below are intentionally sequenced so that installer correctness is fixed and validated before updating runtime behavior. They are proposals only.

### Task A — Shared installer/systemd hardening (P0)

**Scope:** `installer_common.sh`, all unit writers/templates, `repair_companion_services.sh`, direct docs/tests. Do not combine this task with MAVSDK migration or OTA behavior changes.

**Implement:**

1. Add separate validated renderers for systemd literal `EnvironmentFile=`, word values (`ExecStart=`, `Environment=`), and path lists (`ReadWritePaths=`).
2. Normalize/validate `QUIVER_ENV_FILE`, `CONFIG_DIR`, `PARSERS_DIR`, `LOG_STORE_DIR`, and systemd directory inputs before any privileged action. Reject control characters, relative paths where absolute is required, unapproved roots, pre-existing symlinks, and unsafe files.
3. Replace symlink-following privileged copy with verified staging plus atomic replacement. Enforce root/cross-account bootstrap policy.
4. Stage all generated units and fail on any verifier error **or diagnostic**. Use recursive error checking for drop-ins. Promote only a complete clean set; retain/restorable prior content.
5. Make repair Quiver-owned-unit-only by default; add an explicit opt-in for ambiguous generic `go2rtc.service`/`tailscale-funnel.service`; repair historical `EnvironmentFile=` plus `WorkingDirectory=`; ensure any replacement is followed by a successful/retried reload.

**Acceptance tests:**

* Temporary units with paths containing spaces and percent signs have no `EnvironmentFile= path is not absolute` output.
* CR/LF, `..`, relative, unapproved, quote-containing, and symlink paths fail before writes/chown/render.
* A temporary pre-existing destination symlink cannot alter its referent.
* Cross-account non-root bootstrap fails clearly before it leaves inaccessible state (or works using the approved privileged model).
* A fatal invalid drop-in fails validation; a simulated `daemon-reload` failure is retried on next run.
* Existing focused tests are extended to assert verifier stderr/diagnostics, not only zero exit status.

### Task B — Installer artifact completeness and typed preflight (P0/P1)

**Scope:** Hub, telemetry, Logs/OTA, camera installers and shared validation helpers.

**Implement:**

* Use one complete required-artifact list in Hub download and `--local` modes (`install_hub_client.sh:34-36,97-103,137-182`), checked before configuration/package/unit work.
* Validate HTTPS base URL policy, aliases, API key presence, IDs/interfaces, absolute state paths, supported Funnel port set, and all numeric ranges before write/enable/restart.
* Use a dedicated diagnostic configuration parser/validator so `--help` and CLI overrides do not fail while module import parses invalid environment.
* Treat blank aliases as absent when the peer is nonblank. Document any explicit HTTP development override and move polling credentials out of GET URL query strings.

**Acceptance tests:** invalid/blank URL, FTP/HTTP policy, alias blank/nonblank tie, nonsensical/zero/negative/nonfinite rates and intervals, malformed/out-of-range ports, relative paths, and missing local runtime file; each must fail with concise output before package/unit effects. Valid boundary values must succeed in temporary fixtures.

### Task C — Dependency lock and MAVSDK compatible runtime (P0)

**Scope:** `install_telemetry_forwarder.sh`, `install_logs_ota.sh`, `telemetry_forwarder.py`, `logs_ota_service.py`, deployment requirements/tests.

**Implement:** choose the pinned legacy API stack or a complete v4 migration, lock it, and add pre-enable import/API checks using target `ExecStart` Python. Do not leave a mixed legacy/v4 architecture.

**Acceptance tests:** clean, isolated Trixie/Python 3.13/aarch64 installation of constraints; exact imports; stub/simulator connection lifecycle; no FC connection required. Test both normal service startup and error reporting when the expected API is absent.

### Task D — OTA safety and integrity redesign (P0)

**Scope:** `logs_ota_service.py`, `firmware_puller.lua`, `net_webserver_put.lua`, job/server metadata, OTA docs/tests.

**Implement:** fresh fail-closed arming checks before serving and reboot; authenticated peer/token/digest transfer protocol; required SHA-256 and exact size; staging and verified promotion; distinct nonterminal/manual verification state; no success on reboot timeout. Disable or fully harden the legacy PUT applet. Move blocking HTTP/filesystem operations out of async event loops.

**Acceptance tests:**

* Armed, unknown, timeout, and post-transfer armed states all refuse service/reboot.
* Missing/malformed/mismatched hash, wrong token/source, fake ACK, bytes-served-only, partial/oversize content, I/O failure, and reboot timeout cannot mark success.
* Valid fully acknowledged transfer can reach the defined pending/complete state only after all checks.
* Stubbed event-loop heartbeat remains responsive during a deliberately stalled HTTP/filesystem operation.
* Lua Socket/fs stubs cover partial send, header cap, bad content-length, write/flush/close failures, extensionless GET, and no promotion after failure.

### Task E — Hub job-plane file security and resilience (P0)

**Scope:** `raspberry_pi_client.py`, relevant `server/routers.ts`, schema/metadata, tests.

**Implement:** authorize upload creation/job execution; restrict all writes to configured dedicated data roots; resolve containment with symlink refusal; safe temporary streaming download, size/decompression bounds, SHA-256 verification, `fsync`, and atomic promotion; typed response/job validation and per-job failure isolation.

**Acceptance tests:** path traversal, absolute/relative escape, parent/destination symlink, configuration schema failure, checksum/size mismatch, gzip bomb limit, interrupted transfer, non-JSON/unexpected JSON, individual job error, job lease timeout, and recovery. Confirm scripts/configuration cannot be targeted.

### Task F — Runtime supervision and service lifecycle (P1)

**Scope:** telemetry, Logs/OTA, camera stream/controller runtimes.

**Implement:** decisive retry/fail-fast policy; worker liveness supervision; bounded backoff; `asyncio.to_thread`/async client conversion for blocking I/O; retained tasks, cancellation/gathering, resource closure, and SIGTERM cleanup. Separate external go2rtc health state from child-process state.

**Acceptance tests:** failed first-N telemetry connects followed by success; malformed job response does not kill poller; 503/timeout/recovery behavior; stalled operations preserve an async heartbeat; SIGTERM/cancel leaves no pending tasks and closes stubs; external go2rtc has a stable healthy state without `Popen` attempts.

### Task G — Camera control contract and protocol bench validation (P1)

**Scope:** `siyi_camera_controller.py`, Socket.IO server/UI adapter, camera stream integration/tests.

**Implement:** authenticated typed Socket.IO envelope; envelope adapter or UI schema update; correct status offsets; nonblocking framed command transport with CRC/sequence correlation and feedback handler; finite/range validation; idempotent zero-velocity shutdown/dead-man behavior.

**Acceptance tests:** end-to-end stubbed authentication/authorization, cross-drone rejection, command schema cases, fragmented/coalesced/corrupt frames, feedback, send failure, shutdown and zero-velocity. Only after these pass, bench-test control-byte choice (`CTRL=00`/`CTRL=01`) and physical command behavior on a safe non-operational camera.

### Task H — Tailscale/go2rtc/docs/template reconciliation (P1/P2)

**Scope:** camera service/installer/docs, stale templates, README/service docs.

**Implement:** current direct Funnel syntax with supported ports and appropriate proxy target; single endpoint normalizer; pinned/verified downloads; one authoritative Logs/OTA unit source; update/remove legacy camera and URL instructions.

**Acceptance tests:** mocked Tailscale argv; URL normalization table (`/`, `/ws`, `/socket.io`, `/news`, trailing slash, ws/wss); rendered-template equality/drift test; doc command lint/checked examples as feasible.

### Task I — Isolated Pi/vehicle bench validation (P1, hardware-dependent gate)

**Scope:** no production aircraft.

**Validate only after Tasks A–H:** actual Raspberry Pi OS Debian Trixie/aarch64/Python 3.13 package/runtime state, installed unit/drop-ins, systemd manager parse/load/start behavior, explicit capability policy for SocketCAN, isolated CAN/DroneCAN traffic and node-ID policy, MAVLink simulator/bench FC, safe camera, safe Tailscale/go2rtc setup, and firmware workflow with inert/test artifacts. Capture installed unit text to determine whether historic quoted `WorkingDirectory=` remains in deployment.

---

## 5. Per-file audit coverage and finding traceability

All 14 supplied audits completed their stated coverage. No audit entry was marked failed. The following preserves the coverage declaration for every assigned file and maps all identified findings to exact supplied source locations.

### 5.1 `companion_scripts/installer_common.sh`

**Coverage achieved:** Audited every line of `installer_common.sh`; traced direct callers, shared config parser/example, generated/template units, repair path, immediate runtime configuration entry points, and companion setup docs. Used temporary non-`.env` fixtures, Bash/Python syntax checks, local systemd-analyze verify, and primary systemd/Debian Trixie documentation.

**Finding traceability:**

1. Quoted `EnvironmentFile=` renderer — `installer_common.sh:31-38`; docs `README.md:161`, `COMPANION_SERVICES.md:170`. **High, confirmed.** See RC-01.
2. Root `chown` of config/parser directories resolved from shared configuration — `installer_common.sh:122-126`. **High, confirmed.** See RC-02.
3. Privileged copy follows destination symlink — `installer_common.sh:53-64`. **High, confirmed.** See RC-02.
4. Cross-account non-root bootstrap fails after selected-user `0600` ownership — `installer_common.sh:20,119-124`. **High, confirmed.** See RC-02.
5. `QUIVER_ENV_FILE` accepts unnormalized/newline/unrelated absolute paths — `installer_common.sh:75,103-120;31-38`. **Medium, confirmed.** See RC-01/RC-02.
6. Claimed EnvironmentFile compatibility differs for multi-line quoted values — `installer_common.sh:8-10`; immediate parser contract `companion_config.py:29-65,82-94`. **Low, confirmed compatibility gap.** See RC-06.

**Audit limits:** no Raspberry Pi, FC, serial/CAN, camera, Tailscale, firmware, live service, network request, package install, or dependency-wheel install. Local systemd was 255; Trixie metadata identified systemd 257.13 and Python 3.13.5 arm64, not live target execution.

### 5.2 `companion_scripts/install_hub_client.sh`

**Coverage achieved:** Read-only audit of all 189 lines and immediate contracts: `installer_common.sh`, `companion_config.py`, `raspberry_pi_client.py`, Hub unit template, setup/OTA docs, focused tests, and server job API schema. Normal rendered Hub units were verified with systemd 255.4 and focused installer tests; only isolated temporary non-`.env` fixtures/stubs were exercised.

**Finding traceability:**

1. `--local` checks helpers but not `raspberry_pi_client.py` — `install_hub_client.sh:34-36,137-182`; download list `97-103`. **High.** See Task B.
2. `QUIVER_ENV_FILE`/`CONFIG_DIR`/`PARSERS_DIR` not uniformly absolute single-line before writes/render — `install_hub_client.sh:103-105,163-175`. **Medium.** See RC-01/RC-06.
3. URL gate accepts non-HTTPS and API key is in polling query string — `install_hub_client.sh:126-132`; matching server `server/routers.ts` was audited. **Medium.** See RC-06.
4. `POLL_INTERVAL` invalid/zero/negative runtime behavior — installed runtime from `137`; `raspberry_pi_client.py:401-405,343-366`; unit `Restart=always` at installer line `166`. **Medium.** See RC-06.
5. Unvalidated successful JSON/job shapes terminate poller — runtime executed by `install_hub_client.sh:165`; `raspberry_pi_client.py:74-98,306-366`. **Medium.** See RC-05/RC-07.

**Audit limits:** no Pi Trixie/aarch64 or Python 3.13 install; no real systemd install/reload/enable/start/restart; no download/package/network/interface/camera/FC/firmware side effect.

### 5.3 `companion_scripts/install_telemetry_forwarder.sh`

**Coverage achieved:** Audited every installer line plus immediate shared config/parser, runtime, service template, repair path, focused regression, setup docs, REST ingest contract, and current Trixie/PyPI compatibility. Used temporary units/stubs and systemd-analyze only.

**Finding traceability:**

1. Unpinned MAVSDK installs incompatible v4 legacy binding — `install_telemetry_forwarder.sh:27`; runtime `telemetry_forwarder.py:36,119-140`. **Critical.** See RC-03.
2. Quoted `EnvironmentFile=` — `install_telemetry_forwarder.sh:46`. **High.** See RC-01.
3. Worker failure is swallowed while main stays active — installer line `50`; runtime `telemetry_forwarder.py:117-149,404-410`. **High.** See RC-07.
4. Blank URL/malformed or nonpositive update rate accepted by prompts — `install_telemetry_forwarder.sh:13-20,25-27`; runtime validation path. **Medium.** See RC-06.
5. Default active DroneCAN monitoring/fixed node ID — `install_telemetry_forwarder.sh:18-19`; runtime `telemetry_forwarder.py:50-51,282-290`. **Medium in this installer audit; field safety concerns are hardware-dependent.** See RC-10.
6. Newline in `QUIVER_ENV_FILE` not rejected before rendering — `install_telemetry_forwarder.sh:5`; shared `installer_common.sh:103-105,31-38`. **Low, potential.** See RC-01.

**Audit limits:** no Pi/aarch64 Python/apt/pip target, MAVLink/Hub/FC/SocketCAN/DroneCAN, real systemd, or firmware operation.

### 5.4 `companion_scripts/install_logs_ota.sh`

**Coverage achieved:** Audited all 129 installer lines and immediate contracts: `installer_common.sh`, `companion_config.py`, `logs_ota_service.py`, `logs-ota.service`, `firmware_puller.lua`, `net_webserver_put.lua`, repair script, configuration example, and OTA/service documentation. Used temporary non-`.env` fixtures, exact temporary unit rendering with systemd-analyze verify, Python compile/stubs, and authoritative documentation.

**Finding traceability:**

1. Quoted `EnvironmentFile=` — `install_logs_ota.sh:105`. **Medium.** See RC-01.
2. Unbounded MAVSDK incompatible with legacy imports — `install_logs_ota.sh:76`; runtime `logs_ota_service.py:85-90`. **Critical.** See RC-03.
3. Invalid `POLL_INTERVAL`/`DIAGNOSTICS_INTERVAL` accepted then restarts — `install_logs_ota.sh:62-63`; `Restart=always` `109`; runtime parse `logs_ota_service.py:2782`. **High.** See RC-06.
4. Relative `LOG_STORE_DIR` created in invocation cwd and ignored in `ReadWritePaths=` — `install_logs_ota.sh:59,83-85,115`. **Medium.** See RC-06.
5. No armed-state gate before serving/reboot — deployment `install_logs_ota.sh:77,124`; runtime `logs_ota_service.py:1919-2244,2123-2132`. **Critical.** See RC-04.
6. Unauthenticated endpoint permits spoofed completion — `install_logs_ota.sh:77,124`; runtime `logs_ota_service.py:1368-1428,1486-1496`. **Critical.** See RC-04.
7. Hash is optional — deployment `install_logs_ota.sh:77,124`; runtime `logs_ota_service.py:2007-2029`. **High.** See RC-04.
8. Timeout path reports success — installer `124`; runtime `logs_ota_service.py:2227-2244,2641-2653`. **High.** See RC-04.
9. Blocking `requests` in async service — installer `77`; runtime `logs_ota_service.py:491-525`. **Medium.** See RC-07.
10. Blank `HUB_URL` masks valid `WEB_SERVER_URL` — `install_logs_ota.sh:25`; parser/config behavior. **Medium.** See RC-06.

**Audit limits:** no Pi/FC/serial/UDP/TCP/FC web server/Lua/firmware transfer/reboot; no real unit lifecycle, package install, or runtime Hub/FC request. A prior quoted-WorkingDirectory source defect was not reproduced; stale installed units were unavailable.

### 5.5 `companion_scripts/install_camera_services.sh`

**Coverage achieved:** Reviewed all 326 lines plus immediate shared installer/config contracts, rendered units, camera/SIYI runtimes, example configuration, repair logic, existing mocked integration test, and setup docs. Temporary fixtures covered Bash syntax, systemd 255 parsing/verification, config validation, asyncio socket behavior, and runtime state stubs.

**Finding traceability:**

1. All four rendered units quote `EnvironmentFile=` — `install_camera_services.sh:59,105,127,154`. **High.** See RC-01.
2. Unsupported Funnel ports accepted — `install_camera_services.sh:180,194,156-157`. **Medium.** See RC-06/RC-09.
3. External go2rtc never reaches stable “started” state — `install_camera_services.sh:233`; runtime `camera_stream_service.py:339-345,537-555,610-619`. **Medium.** See RC-07/RC-09.
4. SIYI controller changes async socket mode before `sock_recv` — installer `271,279,295`; runtime `siyi_camera_controller.py:280-282`. **High.** See RC-08.
5. Quote-containing accepted installation paths cause bad unit setting — shared `installer_common.sh:94-104`; renderer `install_camera_services.sh:57-67,104-110,126-131`. **Low.** See RC-01.
6. Root installer uses mutable/unverified remote artifacts/scripts — `install_camera_services.sh:206-209,224-231,244-245`. **Medium.** See RC-09.
7. Units overwritten/restarted without complete staged validation/rollback — `install_camera_services.sh:98,116-164,277-296`. **Medium.** See RC-09.
8. Stale executable camera documentation — `docs/reference/SIYIA8MiniCameraServices.md:47-49,85-98,121-125`. **Low.** See RC-12.

**Audit limits:** no Pi Trixie/aarch64/Python 3.13, SIYI/RTSP/Tailscale/go2rtc/live systemd/package/network/FC/firmware. Current literal `WorkingDirectory=` passed normal-path syntax; installed historic errors require direct inspection.

### 5.6 `companion_scripts/repair_companion_services.sh`

**Coverage achieved:** Audited all 132 lines and immediate contracts: installer formatter, all companion unit templates/service writers, shared config/runtime, repair docs, focused tests, and checkpoint parent `6c3420a^`. Validated with disposable systemd-analyze fixtures, stubbed systemctl, syntax checks, and focused tests.

**Finding traceability:**

1. Repairs `WorkingDirectory=` but leaves quoted `EnvironmentFile=` and reports success — `repair_companion_services.sh:41-58,77-90`. **High, confirmed.** See RC-01.
2. Named-unit verification misses fatal drop-in unless recursive errors used — `83-90`. **Medium, confirmed.** See RC-01.
3. Generic go2rtc/Funnel candidates lack Quiver ownership check — `30-34,61-72`. **Medium, confirmed.** See RC-01.
4. Reload failure after replacement is not retried by later no-change run — `98-127`. **Medium, confirmed.** See RC-01.
5. Malformed quoted relative path leaks Python traceback — `54-55`. **Low, confirmed.** See RC-01/Task A.

**Audit limits:** no target Pi/systemd manager/hardware/firmware/network/packages/live services. Parser checks used systemd 255.4; Python 3.13 portability was static review.

### 5.7 `companion_scripts/companion_config.py`

**Coverage achieved:** Read every line and cross-checked shared config template, all installer unit generators, unit templates, repair tool, runtime import paths, focused tests, setup documentation, and firmware parameter contract. Used temporary non-`.env` fixtures, Python compilation, and systemd-analyze verify.

**Finding traceability:**

1. Shared quoted `EnvironmentFile=` contract — immediate `installer_common.sh:31-38`; installer render sites through `QUIVER_ENV_FILE`. **High.** See RC-01.
2. Parser does not implement systemd unquoted backslash escape or continuations — `companion_config.py:29-65`. **Medium.** See RC-06.
3. Blank `HUB_URL` overrides nonempty legacy alias — `167-175,192-208,255-270`. **Medium.** See RC-06.
4. Firmware parameter renderer accepts loopback companion IP — `400-411`. **Medium.** Requires target network validation before operational use.
5. Repeated environment loads retain stale managed keys in `os.environ` — `231-244,462-466`. **Low.** Add the specified two-load regression.

**Audit limits:** no Pi Trixie/aarch64/Python 3.13, hardware, endpoint, package install, real service/reload, firmware. Current source no longer quotes `WorkingDirectory=`; current `EnvironmentFile=` warning was reproduced.

### 5.8 `companion_scripts/raspberry_pi_client.py`

**Coverage achieved:** Audited all 447 lines plus immediate contracts: `companion_config.py`, Hub unit/template rendering, Hub installer, shared installer helpers, companion configuration/example/docs, repair script, related installers, server drone-job/file APIs, schema, UI target-path producer, and relevant tests. Safe validation used Python compilation/stubs, temporary non-`.env` configs, exact systemd-analyze repros, and existing local companion suite (30/30 passed).

**Finding traceability:**

1. Arbitrary payload write/path traversal through upload/config jobs — `raspberry_pi_client.py:175-229,248-297`; server `server/routers.ts:1117-1191`; writable installer roots `install_hub_client.sh:175`. **Critical.** See RC-05.
2. Quoted shared `EnvironmentFile=` service contract — `install_hub_client.sh:161-175`; `installer_common.sh:31-38`. **High.** See RC-01.
3. Poll interval parse/zero/negative defect — `raspberry_pi_client.py:401-405,350-360`. **Medium.** See RC-06.
4. Unexpected valid JSON shape causes uncaught error — `67-98,125-126,166-169,203-205`. **Medium.** See RC-05/RC-07.
5. Unbounded/non-atomic/no-digest artifact downloads — `210-229`. **Medium.** See RC-05.

**Audit limits:** no Pi, live Hub/systemd/network/hardware/package/camera/FC/firmware. Systemd 255/Python 3.12 only; stale deployed units unavailable.

### 5.9 `companion_scripts/telemetry_forwarder.py`

**Coverage achieved:** Audited all 468 lines plus immediate contracts: shared configuration loader/template, telemetry installer/helpers/unit template, repair/setup docs, REST ingestion receiver, and regression tests. Used Python compilation, isolated stubbed runtime/CLI tests, and systemd-analyze 255 against temporary rendered units.

**Finding traceability:**

1. Quoted `EnvironmentFile=` through installer `install_telemetry_forwarder.sh:46`, helper `installer_common.sh:31-39`. **High.** See RC-01.
2. MAVSDK v4 mismatch — `telemetry_forwarder.py:36,119-140`; installer `install_telemetry_forwarder.sh:25-27`. **Critical.** See RC-03.
3. Collector failure leaves process alive — `110-149,377-410`. **High.** See RC-07.
4. Default active fixed-ID UAVCAN node — `50-51,282-318`; config example `companion-config.example:60-62`. **High in runtime audit; hardware field impact not bench-tested.** See RC-10.
5. Missing explicit CAP_NET_RAW policy — installer `install_telemetry_forwarder.sh:41-60`; runtime `282`. **High design/policy risk; target test required.** See RC-10.
6. NaN/infinity/malformed rate behavior — `49,77,238-262,439-452`. **Medium.** See RC-06.
7. HTTP loss/no durable resend — `91,238-262,344-369`. **Medium.** See RC-07.
8. Base URL/doc endpoint mismatch — `16,70,354`; `docs/sdk/Quiver_SDK_Developer_Guide_Outline.md:174,1115`. **Medium.** See RC-10/RC-12.
9. Unmanaged task/resource/SIGTERM lifecycle — `135-140,264-271,315-326,404-425`. **Medium.** See RC-07.

**Audit limits:** no Pi Trixie/Python 3.13, FC/MAVLink/CAN/DroneCAN/Hub. Sandbox had Python 3.12/systemd 255 and no AF_CAN; deployed unit unavailable.

### 5.10 `companion_scripts/logs_ota_service.py`

**Coverage achieved:** Reviewed all 2,869 lines plus direct contracts: shared config/parser, installer/rendered unit/template, firmware puller, setup docs, and focused tests. Used temporary non-`.env` fixtures, systemd-analyze verify, Python compile/import checks, and local stubs.

**Finding traceability:**

1. MAVSDK legacy `mavsdk.ftp` incompatible with v4 — installer `install_logs_ota.sh:76`; runtime `logs_ota_service.py:86-90`. **Critical.** See RC-03.
2. No armed interlock — `1919-2263,2124-2133`. **Critical.** See RC-04.
3. Unauthenticated server/ACK/full-byte completion — `1349-1429,1411-1415,1491-1496`. **Critical.** See RC-04.
4. Optional hash — `2007-2029`; server `server/routers.ts:1547-1552`. **High.** See RC-04.
5. Success on manual/reboot timeout — `2220-2244,2652-2653`. **High.** See RC-04.
6. Blocking work in async tasks — `491-525,575-651,1753-1897,2611,2664-2665`. **High.** See RC-07.
7. Directory listing path traversal — `350-375,581-584,1769,1794-1812`. **High.** Restrict filenames and resolved path containment.
8. Quoted `EnvironmentFile=` — `install_logs_ota.sh:104-106`; `installer_common.sh:31-39`. **Medium.** See RC-01.
9. Import-time numeric configuration crash — `1154,2782-2786`. **Medium.** See RC-06.
10. `--no-fc` still runs FC work/reconnect path — `2765-2770,2688-2705,2630-2635,476-489`. **Medium.** Must not treat no-system state as safe.
11. Relative `LOG_STORE_DIR`/ignored `ReadWritePaths=` — `install_logs_ota.sh:83-85,115`; runtime `432`. **Medium.** See RC-06.
12. Divergent unused/distributed template — `logs-ota.service:1-43`; installer heredoc `install_logs_ota.sh:92-121`. **Low.** See RC-12.

**Audit limits:** no Pi/FC/serial/Hub/FC HTTP, real unit lifecycle, or package install. Python 3.13/aarch64 evidence was metadata/API documentation, not target execution. Installed source of immediate failure remained unknown.

### 5.11 `companion_scripts/siyi_camera_controller.py`

**Coverage achieved:** Audited all 885 controller lines plus immediate shared-config, service-template/installer, setup-doc, Hub Socket.IO/UI, bundled SIYI SDK, and relevant test contracts. Used temporary fixtures, Python stdlib stubs, PDF extraction, compilation, and systemd-analyze verify.

**Finding traceability:**

1. API key never sent/verified and Hub registration lacks auth — `509-516,669-704,800-825`. **Critical, confirmed.** See RC-08.
2. Command schema incompatibility — `534-586,685-695`. **High, confirmed.** See RC-08.
3. Wrong status offsets — `348-360`. **High, confirmed.** See RC-08.
4. Control byte mismatch to bundled examples — `58-60,173-200,261-285,299-306`. **High, potential hardware/protocol blocker.** See RC-08.
5. Async socket mode is broken — `235-241,279-282`. **High, confirmed.** See RC-08.
6. Stop/disconnect lacks fail-safe movement stop/cleanup — `250-259,288-293,629-733,791-793,850-859`. **High lifecycle confirmed; physical consequence untested.** See RC-08.
7. Command success claims despite failed transmit — `454-470`. **Medium.** See RC-08.
8. Decimal zoom encoding off by one tenth — `439-452`. **Medium.** See RC-08.
9. Frame parsing/correlation/CRC defects — `203-233,261-293,299-306`. **High, potential field reliability failure.** See RC-08.
10. Invalid configuration/commands throw raw exceptions — `50-52,374-377,392-399,430-452,479-483,534-610`. **Medium.** See RC-08.

**Audit limits:** no SIYI/Pi/live service/package/network/firmware. CTRL acceptance and physical link-loss effect cannot be claimed until safe hardware testing; deployed units unavailable.

### 5.12 `companion_scripts/camera_stream_service.py`

**Coverage achieved:** Audited all 781 target lines plus direct contracts: shared config/imported controller runtime, camera unit template, camera installer/common renderer, repair script, configuration example, camera installer tests, and camera setup docs. Used temporary non-`.env` fixtures, Python/AST stubs, and systemd-analyze verify; reviewed current systemd, Tailscale, go2rtc, and dependency metadata.

**Finding traceability:**

1. Quoted `EnvironmentFile=` — `camera-stream.service:16`; `install_camera_services.sh:59,71-95`; `installer_common.sh:31-38`. **High.** See RC-01.
2. External go2rtc unstable state — `camera_stream_service.py:336-346,537-555`. **High.** See RC-07/RC-09.
3. Stale Funnel invocation/default proxy host — `211-248`; installer `install_camera_services.sh:156`. **High.** See RC-09.
4. Whole URL override conflicts with port — `317-324,417-444,717-724`. **Medium.** See RC-06/RC-09.
5. Blocking calls inside async loop — `139-208,211-258,400-413,446-500,526-603,668-673`. **Medium.** See RC-07.
6. `rstrip('/ws')` corrupts paths — `460-464,510-513`. **Medium.** See RC-09.
7. Port parsing/Funnel restrictions incomplete — `68-89`; installer `install_camera_services.sh:37-44,180,194`. **Medium.** See RC-06.

**Audit limits:** no camera/gimbal/RTSP/go2rtc/Tailscale/live unit/network/package/FC/firmware. Systemd was sandbox 255, not Pi Trixie/aarch64; dependency conclusion metadata-only.

### 5.13 `companion_scripts/firmware_puller.lua`

**Coverage achieved:** Read all 384 Lua lines and immediate contracts: `companion_config.py`/example, Logs/OTA runtime/installer, common systemd formatter, service templates, setup/repair docs, installer tests, checkpoint history, and upstream ArduPilot SocketAPM API/source. Used temporary non-`.env` fixtures, systemd-analyze 255, syntax checks, and a Python stub.

**Finding traceability:**

1. Bytes served is treated as completion before FC ACK — `firmware_puller.lua:329-337`; `logs_ota_service.py:1392-1397,1476-1496,2093-2097`. **Critical.** See RC-04.
2. No armed-state gate in flash path — `logs_ota_service.py:1919-2244`; Lua `233-337`. **Critical.** See RC-04.
3. Shared quoted `EnvironmentFile=` sites — `installer_common.sh:31-38`; `install_hub_client.sh:161-165`; `install_telemetry_forwarder.sh:45-49`; `install_logs_ota.sh:104-108`. **High.** See RC-01.
4. `Content-Length` cap/equality/completion flaws — `firmware_puller.lua:219-226,279-304,329-337`. **High.** See RC-04.
5. Unchecked file write/flush/close — `293-294,302-303,311-313,329-336`. **High.** See RC-04.
6. Unauthenticated LAN route — `335-336`; `logs_ota_service.py:1411-1420`. **High.** See RC-04.
7. SocketAPM partial-send/blocking/deadline issue — `97-116,178-195,354-377`. **Medium.** See RC-11.
8. Final bootloader file is truncated before transfer validation — `37,78-83,233-241,329-337`. **Medium.** See RC-04.

**Audit limits:** no Pi/FC/MAVSDK/SD/firmware/reboot. No Lua interpreter was locally available; logic/source/API inspection was used. Target Trixie/Python 3.13 claim was not operationally tested; deployed units were unavailable.

### 5.14 `companion_scripts/net_webserver_put.lua`

**Coverage achieved:** Audited all 1,007 lines plus immediate contracts: companion config aliases/path handling, Logs & OTA runtime/Python dependency install/API compatibility, current and stale generated systemd units, installers/repair script, firmware puller, setup docs, upstream ArduPilot socket/runtime behavior, and existing tests. Used temporary configs/unit fixtures, systemd-analyze 255, import-only Python checks, and targeted tests.

**Finding traceability:**

1. Quoted `EnvironmentFile=` and stale quoted `WorkingDirectory=` distinction — `installer_common.sh:31-39`; `install_hub_client.sh:162`; `install_telemetry_forwarder.sh:46`; `install_logs_ota.sh:105`. **High, confirmed current EnvironmentFile; quoted WorkingDirectory stale-unit possibility.** See RC-01.
2. MAVSDK v4 disables legacy Logs/OTA FC/MAVFTP import — `install_logs_ota.sh:76`; `logs_ota_service.py:86-90,900-904`. **High, confirmed.** See RC-03.
3. PUT writes coalesced surplus body before enforcing `Content-Length` — `net_webserver_put.lua:318-329,653-668,799-808`. **High, confirmed.** See RC-04.
4. Filesystem write/flush/close failures ignored — `655-658,707,717,804-805`. **High, confirmed.** See RC-04.
5. Direct final manual PUT without arm/checksum/staging/name restriction — `734,788-790`. **High, confirmed direct behavior; operational impact hardware-dependent.** See RC-04.
6. Unbounded header accumulation — `303-331`. **Medium, confirmed.** See RC-11.
7. Extensionless GET can call `string.lower(nil)` — `560-566`; accepted PUT path `734-790`. **Medium, confirmed.** See RC-11.

**Audit limits:** no FC/SD/bootloader/Pi/serial/network/live systemd/package. MAVSDK package metadata/API was checked, not target Python 3.13/aarch64 runtime. Socket behavior came from authoritative source, not a target FC.

---

## 6. Audit coverage status, successes, missing files, and failures

### Successfully completed audit assignments

The following assigned files were audited to the full stated coverage in the supplied records:

1. `/home/ubuntu/rplidar_web_server/companion_scripts/installer_common.sh`
2. `/home/ubuntu/rplidar_web_server/companion_scripts/install_hub_client.sh`
3. `/home/ubuntu/rplidar_web_server/companion_scripts/install_telemetry_forwarder.sh`
4. `/home/ubuntu/rplidar_web_server/companion_scripts/install_logs_ota.sh`
5. `/home/ubuntu/rplidar_web_server/companion_scripts/install_camera_services.sh`
6. `/home/ubuntu/rplidar_web_server/companion_scripts/repair_companion_services.sh`
7. `companion_scripts/companion_config.py`
8. `/home/ubuntu/rplidar_web_server/companion_scripts/raspberry_pi_client.py`
9. `/home/ubuntu/rplidar_web_server/companion_scripts/telemetry_forwarder.py`
10. `/home/ubuntu/rplidar_web_server/companion_scripts/logs_ota_service.py`
11. `/home/ubuntu/rplidar_web_server/companion_scripts/siyi_camera_controller.py`
12. `/home/ubuntu/rplidar_web_server/companion_scripts/camera_stream_service.py`
13. `/home/ubuntu/rplidar_web_server/companion_scripts/firmware_puller.lua`
14. `/home/ubuntu/rplidar_web_server/companion_scripts/net_webserver_put.lua`

Focused test successes explicitly reported by the supplied audits include: the repair focused regression **5/5**, `companion_config.py` focused Vitest **32/32**, the local companion suite **30/30**, and `server/companion-installers.test.ts` **20/20**. These successes do **not** clear the defects above: specifically, existing systemd tests typically accept `systemd-analyze verify` exit status zero without failing on its `EnvironmentFile=` diagnostics.

### Explicit missing files / failed audits

* **Missing audited files:** None were declared in the supplied audit set. The audit assignment consists of the 14 files above, all with a coverage record.
* **Audit execution failures:** None. The supplied `Failures` list is empty.
* **Unavailable deployment artifacts:** installed Pi unit files, drop-ins, stale historical units, target Raspberry Pi OS Trixie/aarch64 interpreter/package state, actual systemd manager state, and target hardware were not provided for inspection. These are missing **validation inputs**, not missing source-file audits.

### Hardware- and deployment-dependent validation still required

Before declaring a production repair complete, validate on isolated equipment: Raspberry Pi OS Debian Trixie/aarch64 and Python 3.13; actual installed base units/drop-ins; systemd manager load/start behavior; MAVSDK package/API; safe MAVLink/FC simulator; SocketCAN/DroneCAN permissions and traffic; SIYI control protocol and link-loss fail-safe; go2rtc/Tailscale operation; FC Lua SocketAPM/file semantics; and test firmware transfer/reboot behavior using non-operational artifacts. Do not use an operational aircraft as the initial validation target.

---

## 7. Parent validation append-only section

**Intentionally blank.** This report records audit findings and proposed repair tasks only. The parent workflow should append actual code changes, commands run, test outputs, target-device checks, remaining exceptions, and repair acceptance decisions here after implementation.


---

## Parent remediation and target-version validation

**Measured acceptance: 1,079 tests passed across 36 Vitest files.** The final full suite ran with native ARM64 Python 3.13.17 and privately extracted Debian Trixie systemd 257.13 tooling on PATH. Ubuntu systemd 255 checks, TypeScript, production build, Bash syntax, Python AST compilation, and real Lua 5.3 syntax parsing also passed. Dependencies were installed only into a private compatibility environment. No user Pi, live systemd services, network interfaces, FC, CAN bus, camera, or firmware was accessed.

### Applied repairs versus remaining gates

| Audit root cause | Applied change | Remaining limitation |
|---|---|---|
| RC-01 / RC-12: unit quoting and drift | Literal `WorkingDirectory`/`EnvironmentFile` paths are separated from word quoting. Full unit sets are staged and validated; warnings and invalid drop-ins fail before enable/restart. Definitions have backup/rollback handling. All five retained templates render and parse cleanly; illustrative references are labeled. | The screenshots do not identify the exact installed rejected directive. Diagnose `/etc` units and drop-ins; editing source-folder units does not edit the live definition. |
| RC-02: privileged paths/copies | Normalize/restrict roots, reject control characters, unsafe existing ownership and symlinks, and atomically replace approved regular files. Cross-account bootstrap requires root. Installer-owned code is separated from writable data. | Review prior filesystem ownership and deliberately selected external data roots on the actual companion. |
| RC-03: MAVSDK major-version break | Pin `mavsdk==3.17.4` and compatible direct dependencies. Run actual `System()` / `FtpResult` preflight with the service Python before enablement. | This is a verified legacy compatibility pin, not a v4 migration. The old package name receives no further updates. |
| RC-04: OTA state/integrity | Require original-artifact SHA-256 and a fresh boolean `False` armed sample. Missing/unknown/timeout/armed samples deny firmware exposure and reboot. Permit only the configured FC peer and an exact-size download ACK. Buffered bytes, failed reboot, timeout, or unverifiable version cannot succeed. | Peer IP restriction is not cryptographic authentication. Per-transfer capability/digest authentication and trusted/isolated FC networking remain follow-up. |
| RC-04 / RC-11: Lua partial firmware | Exact Content-Length, capped writes, checked filesystem operations, inert `.part` staging, and arming checks. Legacy PUT is default-disabled and restricted to one firmware target; extensionless MIME and header-cap errors are corrected. | **Firmware promotion is blocked in both applets (`RENAME_SUPPORTED=false`).** Inspected current ArduPilot source does not expose an OS sandbox library or establish atomic rename. A target-specific atomic promotion port and non-operational bench verification are required. This is not usable, flight-approved OTA. |
| RC-05: Hub job writes | Remote writes default off. Opt-in bounded streaming/hash/decompression/atomic operations are confined to data roots, exclude executable/`.env` locations, and reject symlink/traversal paths. Malformed job/poll responses no longer terminate the client. | Backend job creation and Socket.IO authorization remain unresolved. Client hardening does not fix server auth. Existing opt-in `.env` flags are preserved and require review. |
| RC-06: configuration | Typed installer validation, numeric bounds, alias migration, supported Funnel ports, import-safe camera defaults, concise errors, and HTTPS base-URL policy with a loopback-only development exception. | Review existing config explicitly; installers do not silently reset hardware/network choices. |
| RC-07 / RC-10: telemetry/lifecycle | Supervised retry/reconnect, bounded backoff/drop counters, cleanup and async offload. UAVCAN defaults off with an explicitly configured unique node ID. Documentation no longer promises durable replay. | Raw CAN privileges, bus traffic/node-ID collisions, and real MAVLink/daemon behavior require a safe target bench. |
| RC-08 / RC-09: camera | Typed UI command adapter; nonblocking framed TCP/CRC/sequence handling; corrected status offsets and decimal zoom; bounded zero-motion cleanup; current Funnel argv; exact `/ws` normalization; stable external-go2rtc monitoring. | SIYI CTRL-byte interoperability, completion feedback, and physical stop on link loss remain bench gates. Photo/record results mean transmission acceptance, not confirmed completion. |
| RC-09: remote artifacts | go2rtc v1.9.15 is pinned and checked against official SHA-256; the real ARM64 asset checksum passed. Removed root curl-to-shell Tailscale installation; signed OS repository installation/authentication is a prerequisite. | Real Tailscale/go2rtc networking was not exercised. |

### Deployment diagnosis and recovery

Use the **new** delivered diagnostic and repair scripts, not an older installed copy:

```bash
bash /path/to/new-suite/diagnose_companion.sh --install-dir /your/installed/quiver
sudo bash /path/to/new-suite/repair_companion_services.sh --check
sudo bash /path/to/new-suite/repair_companion_services.sh
```

The diagnostic redacts credentials and reports installed source hashes/version, exact parser errors, unit paths/directories, and read-only states. Repair backs up recognized Quiver units, fixes both historical quoted single-path directives, validates drop-ins/warnings, and retries `daemon-reload`. It never edits `.env` or starts/restarts services.

For a complete upgrade, use the new suite's `install_hub_client.sh --local` or its commit-pinned GitHub download flow, then use the secondary installers copied into the selected installation folder. Read `AUDITED_UPGRADE_NOTES.md` before enabling services. Do not enable FC firmware promotion on an aircraft.

The bundled `audit/` directory retains the 14 per-source audits, primary-source evidence, and machine-readable validation record. Historical pre-fix line references above are not line numbers in the repaired files.
