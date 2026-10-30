# `raspberry_pi_client.py` audit

## Confirmed findings

### Critical — Hub jobs can write attacker-selected paths, including future service code

**Client:** `raspberry_pi_client.py:215-229`, `248-260`, `282-297`  
**Immediate contract:** `server/routers.ts:1117-1191` exposes `droneJobs.uploadFile` as `publicProcedure` and accepts arbitrary `targetPath`; generic `createJob` accepts arbitrary type/payload at `1098-1115`.

The client trusts `payload.targetPath` and `payload.configFile`, creates parent directories, then writes directly. It does not require an absolute path inside a narrow data directory, resolve/reject symlinks, restrict filenames/extensions, or write atomically. This is exploitable before considering a UI: `uploadFile` requires no authenticated web user, creates a job for the selected drone, and the authenticated companion later fetches and writes the file.

The generated Hub unit intentionally permits writes to `INSTALL_DIR`, `CONFIG_DIR`, and `PARSERS_DIR` (`install_hub_client.sh:175`). Therefore a public upload job can replace a Python service script within `INSTALL_DIR`; that code runs on a later service restart. The client does not directly flash firmware, and no FC/hardware action was tested, but changing companion scripts/configuration is still a material flight-system integrity boundary.

Safe stub repro: a job target of `allowed/../escaped-write.txt` succeeded and wrote outside the nominal subdirectory. This did not use the network or a real service.

**Fix:** make `uploadFile` a protected, authorized operation and authorize the selected drone. In the client, permit only a small set of configured, dedicated data roots; use `Path.resolve(strict=False)` plus parent containment checks and reject symlink traversal. Do not allow arbitrary script/config filenames through generic file jobs. Download into a same-directory temporary file, enforce size/hash/type policy, `fsync`, set explicit ownership/mode as appropriate, and atomically replace only approved non-executable targets. Apply the same containment and schema rules to `update_config`.

### High — The quote fix left `EnvironmentFile=` invalid; systemd ignores the generated configuration file

**Client immediate service contract:** `install_hub_client.sh:161-175`, `installer_common.sh:31-38`, `quiver-hub-client.service:16`; the same formatter is used by telemetry, Logs & OTA, and camera renderers.

`quiver_systemd_path` emits a double-quoted word. That is appropriate for `ExecStart=` arguments and `Environment=`, but not for `EnvironmentFile=`. An exact temporary rendering with a space/percent-containing installation path produced:

```ini
WorkingDirectory=/tmp/.../companion 100%% ready
EnvironmentFile="/tmp/.../companion 100%% ready/client-config"
```

`systemd-analyze verify` (systemd 255) reported: `EnvironmentFile= path is not absolute, ignoring: "..."`. Replacing only that line with an unquoted path removed the diagnostic. `\ ` and `\x20` escaped whitespace also verified cleanly. `systemd-analyze verify` still returned zero for the ignored directive, which explains why the current installer regression that asserts only exit status misses it.

This is **not sufficient by itself to prove the Pi’s reported “bad unit file setting”**: the Hub unit also passes a correctly quoted `Environment=QUIVER_ENV_FILE=...`, and this Python client subsequently loads that file itself. Thus the Hub client can retain its own configuration despite the ignored `EnvironmentFile`. The obsolete quoted `WorkingDirectory` defect remains a likely explanation for a truly stale installed unit; no Pi installed unit was supplied. However, the checked-in suite and its documentation currently make the false claim that quoting is appropriate for `EnvironmentFile` and that units load it. The defect is worse for non-Python consumers such as the generated Tailscale Funnel unit, which relies on shell-style `$TAILSCALE_*` variables from `EnvironmentFile` and has no Python loader fallback.

**Fix:** split the formatter by directive. Preserve word quoting for `ExecStart=`, `Environment=`, and `ReadWritePaths=`. For `EnvironmentFile=`, emit one unquoted absolute filename with systemd escaping for whitespace/backslash (for example `\\x20`), `%` escaped as needed, and reject newline/NUL. Update the renderer tests to fail on verifier diagnostics, not only a zero exit code. Extend `repair_companion_services.sh`: it presently changes only `WorkingDirectory` (lines 40-58), so it will not correct already-installed `EnvironmentFile` lines. Correct README/COMPANION_SERVICES wording that currently says retaining `EnvironmentFile` quoting is appropriate.

The systemd documentation says `EnvironmentFile=` requires an absolute filename and that `ReadWritePaths=` is a space-separated path list; the parser distinction is observable in the local verifier. [1]

### Medium — A malformed configured poll interval crashes before CLI parsing; zero/negative intervals are accepted

**Client:** `raspberry_pi_client.py:401-405`, `350-360`.

The parser constructs `default=int(CONFIG.get('POLL_INTERVAL', '5'))` before `parse_args()`. With `POLL_INTERVAL=not-an-integer`, even `--help` exits 1 with an uncaught `ValueError`; an explicit valid `--poll-interval` cannot override the bad file value. Stubbed CLI runs also constructed clients with `--poll-interval 0` and `--poll-interval -1`. Zero causes an unthrottled polling loop; a negative value causes `time.sleep()` to raise, after which systemd will continually restart the service.

**Fix:** parse/validate the configured default with a user-facing `argparse.ArgumentTypeError` or a safe default path, then enforce a positive bounded interval after parsing. Ensure an explicit CLI value can supersede an invalid environment default if that precedence is intended.

### Medium — A syntactically valid but wrongly shaped Hub response terminates the service instead of becoming one failed poll

**Client:** `raspberry_pi_client.py:85-98`, with analogous unchecked `.get()` chains at `125-126`, `166-169`, and `203-205`.

`requests` JSON decode errors are `RequestException`s and are caught. However, a valid JSON list (or another unexpected JSON shape) makes `data.get(...)` raise `AttributeError`; it escapes `get_pending_jobs`, then `run()` logs a fatal error and exits 1. The exact isolated repro returned `valid-json-wrong-shape-propagates: AttributeError 'list' object has no attribute 'get'`. Similar malformed success responses in acknowledgement/completion can escape their narrow exception handling.

This is availability rather than data corruption: systemd restarts the client, but it creates restart churn and leaves an acknowledged job for the server reaper (default timeout is 300 seconds in `drizzle/schema.ts:206-216`).

**Fix:** validate response objects and `jobs` as a list before use; convert unexpected shape/JSON/value errors to a logged failed poll or failed request. Treat acknowledgement/completion response schemas similarly. Add direct `QuiverHubClient` unit tests; the current checked-in companion tests inspect configuration and installer text but do not exercise `QuiverHubClient`, `download_file`, `handle_update_config_job`, or poll-interval behavior.

### Medium — Downloads are unbounded, non-atomic, and not integrity checked

**Client:** `raspberry_pi_client.py:210-229`.

The client loads the full response into memory (`file_response.content`), optionally expands it with `gzip.decompress`, and writes directly to the destination. There is no maximum compressed/decompressed size, streaming limit, content hash/signature, temporary file, `fsync`, or cleanup/rollback for a partial target. The immediate file metadata contract contains URL, name, MIME type, and size, but no digest (`drizzle/schema.ts:223-247`). A network interruption or disk-full condition can therefore leave a partially overwritten approved target; a malicious or oversized compressed object can exhaust memory/disk. Long transfers can also outlive the server job timeout and be retried concurrently because the client does not renew its lock.

**Fix:** define an artifact size and SHA-256 in the server metadata/job; stream to a bounded temporary file under the approved root, verify compressed and output limits plus digest, `fsync`, then atomically rename. Make timeout/retry semantics match maximum transfer/decompression duration, or add a lease renewal protocol.

## Checked behavior that is not a confirmed defect

- The current source no longer quotes `WorkingDirectory`; a real systemd 255 verifier accepted the literal directory, including a space and escaped percent. The earlier quote defect in checkpoint `6c3420a` can nevertheless persist in a **stale installed** unit. Inspect `/etc/systemd/system/*.service`, not only the source tree, before attributing the Pi failure to a directive.
- `load_environment()` correctly supports the `HUB_URL`/`WEB_SERVER_URL` alias and `QUIVER_ENV_FILE` overlay for this client. The generated `Environment=QUIVER_ENV_FILE=...` is parsed correctly, which mitigates the ignored `EnvironmentFile` for this Python process only.
- The script compiles cleanly under the available Python 3.12. Python 3.13 was not installed in the sandbox, so it was not executed there. The assigned file uses standard Python 3.9+ syntax and no apparent removed API; the installer requests Debian’s `python3`, `python3-pip`, and installs `requests` with `--break-system-packages` (`install_hub_client.sh:23-24,137`). No Python-3.13-specific incompatibility was confirmed.
- The assigned file is synchronous; it has no asyncio/coroutine behavior to validate. Job handling is intentionally serial. No hardware, network endpoint, package installation, real systemd service, firmware transfer, or flight-controller operation was run.

## Coverage and evidence

Reviewed every line of `companion_scripts/raspberry_pi_client.py` (1-447), its import/config loader, Hub unit template, Hub installer, shared renderer, companion configuration template, related service installers, repair script, setup documentation, and the Hub tRPC job/file contract. Safe checks used Python byte compilation, stubbed request sessions, temporary non-`.env` configuration files, and `systemd-analyze verify`; no project file or Git configuration was modified. The sandbox had systemd 255 and Python 3.12, not the reported Raspberry Pi OS Trixie/Python 3.13 environment.

**References**

[1]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html "systemd.exec manual"
