# Audit — `companion_scripts/companion_config.py`

## Confirmed findings

### High — quoted `EnvironmentFile=` paths are ignored by systemd, so current generated units do not receive `.env` variables directly

**Affected contract:** `installer_common.sh:31-38`; `install_hub_client.sh:162`; `install_telemetry_forwarder.sh:46`; `install_logs_ota.sh:105`; `install_camera_services.sh:59,105,127,154`. The configuration helper itself does not generate units, but all installers select its shared `.env` using this formatter.

`quiver_systemd_path()` always emits a double-quoted word. That is appropriate for `ExecStart=`, `Environment=`, and `ReadWritePaths=`, but not for `EnvironmentFile=`. A temporary unit using `EnvironmentFile="/tmp/.../config.test"` produced:

```text
EnvironmentFile= path is not absolute, ignoring: "/tmp/.../config.test"
```

on `systemd-analyze verify` 255. An unquoted absolute path containing spaces verified cleanly. The upstream manual requires the `EnvironmentFile=` argument itself to be an absolute filename; quotes are not a path-list quoting mechanism.[1]

The three Python services still have `Environment="QUIVER_ENV_FILE=/absolute/.env"`; therefore their `load_environment()` fallback will usually load the file. This is nevertheless a real deployment defect: the unit’s advertised `EnvironmentFile=` is ignored, and `tailscale-funnel.service` depends on it for `${TAILSCALE_FUNNEL_PORT}`, `${GO2RTC_API_HOST}`, and `${GO2RTC_API_PORT}` before it executes a Python helper. It will therefore expand these to empty values. Existing tests incorrectly treat verifier exit code 0 as success and do not fail on this warning.

**Fix:** split the formatter by directive type. Emit a literal validated absolute `EnvironmentFile=<path>` (escape `%` for systemd specifiers if required, but do not surround the path with quotes); retain `quiver_systemd_path()` for word-list directives. Add an integration assertion that `systemd-analyze verify` stderr/stdout has no `EnvironmentFile= path is not absolute` warning and a fixture with a space-containing config path.

**Evidence/test:** safe temporary unit repro with systemd 255; focused repository test run passed 32/32 because verify returned zero despite the warning. This is source/contract evidence, not a run on Raspberry Pi OS.

### Medium — parser is not EnvironmentFile-compatible for unquoted backslash escapes

**Lines:** `companion_config.py:29-65`, especially `43-44`; used by `parse_environment_file()` at `82-94`, and installer `get` calls at `installer_common.sh:8-10,77,91,122-123`.

The module describes its parser as EnvironmentFile-compatible, but for an unquoted line `KEY=one\ two`, `companion_config.py get ... KEY` returns the literal seven-character form `one\ two`. systemd’s documented unquoted EnvironmentFile rules treat the backslash as escaping the following character, so the value is `one two`.[1] Systemd also supports quoted multi-line values and continuation that this line-oriented parser does not accept.

This matters even though `set` writes safe double-quoted values: retained legacy/operator files are accepted as input, and the installers obtain `INSTALL_DIR`, `CONFIG_DIR`, `PARSERS_DIR`, and `LOG_STORE_DIR` using `get`. Such a file can make installer-rendered paths differ from systemd/runtime interpretation.

**Fix:** either implement the documented systemd EnvironmentFile grammar for input, including unquoted escapes and continuations, or explicitly define and enforce a narrower accepted format: reject noncanonical unquoted backslashes/multiline forms with a clear migration error. Add a test for `KEY=one\ two` and a quoted continuation.

**Evidence/test:** temporary non-`.env` fixture and `python3 companion_config.py get`; upstream grammar confirms the expected systemd result.[1]

### Medium — alias resolution drops a non-empty legacy URL when the canonical alias is present but blank

**Lines:** `companion_config.py:167-175`, `192-208`, `255-270`.

`_synchronize_aliases()` only adds a counterpart when it is absent, not when it is blank. `_normalize_hub_aliases()` then selects `HUB_URL` on a same-source tie, regardless of whether it is empty. Reproduction with:

```dotenv
HUB_URL=
WEB_SERVER_URL=https://legacy.example
```

returned empty for both `get ... HUB_URL` and `get ... WEB_SERVER_URL`; `init` left the conflicting assignments unchanged. This contradicts the nearby claim that `init` prevents the ambiguous state. A migrated/template-initialized file subsequently updated only through a legacy `WEB_SERVER_URL` edit can make all Hub clients receive an empty URL.

**Fix:** treat a blank alias as absent when its peer is non-empty, then rewrite both aliases during `init`; preserve the documented `HUB_URL` tie-breaker only when both competing values are non-empty. Add this exact regression fixture.

**Evidence/test:** safe temporary `alias-only.test` fixture against the shipped helper.

### Medium — firmware parameter renderer permits loopback as a “companion” target

**Lines:** `companion_config.py:400-411`.

`render_fc_params()` accepts `COMPANION_IP=127.0.0.1` because it rejects only first octet 0 and 224–255. It generated `FWPULL_PI_IP0 127 ... FWPULL_PI_IP3 1`; the FC-side `firmware_puller.lua:140-152` applies the same incomplete check. On the flight controller, that address targets its own loopback rather than the Pi, so the generated parameter file cannot express the stated companion endpoint safely.

The renderer correctly omits `FWPULL_ENABLE`, so importing the file alone does not initiate a firmware transfer. No flight controller was exercised.

**Fix:** reject at least `IPv4Address.is_loopback` in addition to the current range checks; preferably validate a usable unicast companion LAN address against `NETWORK_SUBNET` when supplied. Add renderer tests for 127.0.0.1, 0.0.0.0, multicast, and a valid configured companion address.

**Evidence/test:** safe temporary render; checked emitted parameter names against `firmware_puller.lua:26-32` and its runtime validation at `140-152`.

### Low — repeated `load_environment()` calls leave removed managed variables in `os.environ`

**Lines:** `companion_config.py:231-244`, `462-466`.

The intent is to avoid a previous load becoming a user override. `_process_environment()` does skip values that still match `_MANAGED_ENVIRONMENT`, so the second returned mapping is correct. However, `os.environ.update(values)` never deletes keys no longer present. In a same-interpreter repro, loading an overlay containing `EXTRA_A=first`, then loading another overlay without it, returned no `EXTRA_A` on the second call while `os.environ['EXTRA_A']` remained `first`.

Current services load once at module import, so this is not a startup blocker. It becomes observable for in-process reloads or another imported component that reads `os.environ` directly.

**Fix:** before `os.environ.update(values)`, remove keys tracked in the prior `_MANAGED_ENVIRONMENT` that are absent from the newly resolved mapping, while preserving actual caller-provided overrides. Add a two-load regression test.

**Evidence/test:** isolated one-interpreter temporary-overlay repro; no service runtime imported.

## Reported “bad unit file setting” versus current source

This assigned file contains no systemd unit writer and no `WorkingDirectory=` generation. Its immediate installer contract now calls `quiver_systemd_directory()` for every current `WorkingDirectory=` (`install_hub_client.sh:161`, telemetry `45`, Logs/OTA `104`, camera `126`), which emits a literal absolute path. Repository integration tests rendered Hub, telemetry, Logs/OTA, and camera units in temporary directories and ran `systemd-analyze verify`; the focused run passed 32 tests.

Accordingly, the fatal earlier `WorkingDirectory="/path"` defect is **not reproduced by the checked-in current generators**. The supplied repair script specifically detects and removes this stale installed quoting. Without the affected Pi’s installed files, it is not possible to attribute the user’s reported fatal directive to `WorkingDirectory`, `EnvironmentFile`, or another deployed/stale unit. The current quoted-`EnvironmentFile` defect is confirmed separately above; on systemd 255 it is warned and ignored rather than fatal, so it does not by itself explain a `bad unit file setting` report.

## Checked non-findings and limits

- The helper imports only Python standard-library modules and compiles under the available Python 3.12.3. Its syntax and APIs are compatible with Python 3.13; no package dependency is required by this file. Service dependencies are installed separately with `--break-system-packages` in the installers. Python 3.13 on Raspberry Pi OS was not available here, so that exact runtime was not executed.
- `companion_config.py` is intentionally synchronous. It performs no network or hardware I/O and no async work. Its file/validation errors propagate to import callers (fail-closed for a missing explicit `QUIVER_ENV_FILE`) and are converted to concise exit-2 errors in its direct CLI entry point (`525-530`).
- `_write_atomic()` uses same-directory temporary files, `fsync` on the file, atomic `os.replace`, and 0600 output. Renderer output intentionally excludes Hub API credentials. The firmware renderer intentionally does not output `FWPULL_ENABLE`.
- No packages were installed, no network endpoint, hardware, firmware transfer, or real service was started. All repros used temporary config filenames other than `.env`.

## References

[1]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html "systemd.exec EnvironmentFile and path settings"
