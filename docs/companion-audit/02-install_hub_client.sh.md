# Read-only audit — `companion_scripts/install_hub_client.sh`

**Scope.** Entire assigned installer (lines 1–189) plus immediate contracts: `installer_common.sh`, `companion_config.py`, `raspberry_pi_client.py`, generated/template unit, focused docs, OTA parameter flow, and installer/runtime tests. Reviewed at `6c3420a`; no project files, Git configuration, services, packages, network endpoints, or hardware were changed/accessed.

## Result on the reported systemd failure

**No current normal-path reproduction of the old quoted-`WorkingDirectory` defect.** The installer now uses `quiver_systemd_directory` (line 161), which emits a literal absolute directory, rather than `quiver_systemd_path`. The focused integration test generated the Hub unit in a path containing spaces and passed `systemd-analyze verify` on systemd 255. A manual fixture also verified the actual current formatter for spaces, `%`, quotes, and backslashes. `EnvironmentFile`, `Environment`, `ExecStart`, and `ReadWritePaths` are appropriately word-quoted by `quiver_systemd_path`; `StartLimit*` placement in `[Unit]` and the hardening directives are accepted by systemd 255.

Therefore, an observed `WorkingDirectory= path is not absolute` on a Pi is consistent with a stale installed `/etc/systemd/system/*.service` from before checkpoint `6c3420a`, as the adjacent repair documentation states; it is **not** reproduced from this installer’s ordinary inputs. The installed unit, not the source template, remains authoritative. This does not prove behavior on the reporting Pi/systemd release.

## Findings

| Severity | Status | Lines | Finding |
|---|---|---:|---|
| High | Confirmed | 33–36, 137–182 | `--local` accepts an incomplete suite and can successfully install a Hub unit whose runtime script is absent. |
| Medium | Confirmed | 103–105, 163–175; shared 31–38, 121–126 | `QUIVER_ENV_FILE`, `CONFIG_DIR`, and `PARSERS_DIR` are insufficiently constrained before use in generated unit directives / privileged mkdir-chown paths. |
| Medium | Confirmed | 126–132; runtime 75–83 | Hub URL validation permits non-HTTPS URLs even though the client sends the API key in a GET query parameter. |
| Medium | Confirmed | runtime 401–405, 343–366 | Invalid/zero/negative `POLL_INTERVAL` causes startup traceback, restart looping, or an unthrottled polling loop. |
| Medium | Confirmed | runtime 74–98, 306–366 | Unexpected successful HTTP JSON/job shapes are not contained; a malformed response can terminate the service and trigger `Restart=always`. |

### 1. High — `--local` completeness check omits the Hub runtime

**Evidence.** In local mode, lines 34–36 require only `companion_config.py`, `companion-config.example`, and `installer_common.sh`. The network downloader’s required set at lines 97–103 does include `raspberry_pi_client.py`, but local mode never applies that list. The copy loop at lines 139–144 silently copies only files that exist, then lines 165 and 181 create/install a unit hard-coded to execute `$INSTALL_DIR/raspberry_pi_client.py`.

A disposable local-suite copy with only `raspberry_pi_client.py` removed was installed using mocked `apt-get`, `pip`, and `systemctl` commands. It exited **0**, generated `quiver-hub-client.service`, and its `ExecStart` named the missing file. The test fixture currently exercises a complete local suite, so it misses this path.

**Impact.** The documented offline/controlled-release path can report success, write configuration and many files, and leave a service guaranteed to fail at start. It also runs package installation before discovering the missing runtime.

**Fix.** Define one required-artifact list (at least the Hub runtime, config helper/template, common helper, FC renderer/Lua/docs and all installers promised by the bootstrap) and call it in both local and downloaded modes **before** configuration, package work, or installation. Alternatively validate every file referenced by generated units after copy and fail before writing/reloading the unit. Add a regression that removes `raspberry_pi_client.py` from a temporary `--local` suite and expects a pre-install failure.

### 2. Medium — Unit and write-path inputs lack uniform path validation

**Evidence.** `quiver_configure` rejects a non-absolute/newline-containing `INSTALL_DIR` (shared lines 97–102), but it accepts any absolute `QUIVER_ENV_FILE` at shared lines 103–105, including CR/LF. It also obtains `CONFIG_DIR`/`PARSERS_DIR` from the config and uses them at lines 121–126 without requiring absolute, single-line paths. The Hub installer renders all three through `quiver_systemd_path` at lines 163–175.

Safe temporary reproduction: setting an absolute `QUIVER_ENV_FILE` containing a newline produced:

```ini
EnvironmentFile="/tmp/.../chosen
Restart=always"
```

`systemd-analyze verify` (systemd 255) diagnosed `EnvironmentFile= path is not absolute, ignoring` and parsed the next text as a damaged service directive. A relative `CONFIG_DIR=config` rendered `ReadWritePaths="config"`, which systemd diagnosed as `path is not absolute, ignoring`. `quiver_configure` would meanwhile invoke privileged `mkdir -p` and `chown` on that relative path in the installer’s current directory.

**Impact.** A malformed override can yield an unusable/misparsed unit or remove the intended write exception under `ProtectSystem=strict`; relative configured paths can create/chown unexpected locations. This is a configuration/path-validation defect, not the normal quoted-`WorkingDirectory` regression.

**Fix.** Introduce a shared `quiver_validate_absolute_path` and apply it before any mkdir/chown/rendering to `QUIVER_ENV_FILE`, resolved `CONFIG_DIR`, and `PARSERS_DIR`: require absolute, reject CR/LF (and preserve the existing no-NUL invariant), normalize with `realpath -m`, and preferably reject unsafe symlink/file-type cases for the config file. Keep `quiver_systemd_path` as escaping only, not validation. Add integration cases for newline `QUIVER_ENV_FILE` and relative/newline config/parser directories; assert rejection before apt/pip/unit write.

### 3. Medium — installer accepts cleartext Hub endpoints while API key goes in GET URL

**Evidence.** The line 129 gate checks only blank values and one placeholder. A temporary config with `WEB_SERVER_URL=ftp://hub.invalid` passed the exact gate (`accept`), demonstrating no scheme validation. Runtime `get_pending_jobs` (lines 75–83) embeds `apiKey` in JSON encoded in GET parameter `input`; a stdlib request stub confirmed the API key is present in that query string. The server contract at `server/routers.ts:1033–1043` indeed defines `getPendingJobs` as a query with `apiKey`, so the client/server call shape itself matches.

**Impact.** A mistakenly configured `http://` Hub URL transmits the API credential in cleartext URL material (and URLs are frequently logged by proxies/access logs). The docs’ security section says to use HTTPS, but this bootstrap does not enforce it. Non-HTTP schemes instead fail repeatedly at runtime.

**Fix.** Parse and require an `https` URL with a hostname before accepting the Hub URL, or require an explicit, prominently unsafe local-development opt-in for HTTP. Longer-term, make the poll endpoint authenticate without query-string secrets (e.g., a POST/header design coordinated with the server). Test rejection of `http`, `ftp`, malformed URLs, queries/fragments/userinfo as policy dictates, and acceptance of ordinary HTTPS URLs.

### 4. Medium — `POLL_INTERVAL` can crash or spin the installed client

**Evidence.** The runtime computes argparse’s default eagerly at line 404 with `int(CONFIG.get('POLL_INTERVAL', '5'))`. With a temporary non-`.env` fixture containing `POLL_INTERVAL=not-a-number`, even `raspberry_pi_client.py --help` exited 1 with an uncaught `ValueError`. In stdlib-only request-stub runs, `POLL_INTERVAL=-1` reached `time.sleep(-1)`, then logged `Fatal error: sleep length must be non-negative` and exited 1; `POLL_INTERVAL=0` performed an unthrottled loop until the safe one-second test timeout. The installed unit uses `Restart=always` (line 166), turning invalid values into restart cycling.

**Impact.** One editable shared setting can make the Hub service unavailable or cause needless Hub/network load. The bootstrap does not prompt for or validate this value, but initializes/preserves it through the shared configuration contract.

**Fix.** Use an argparse type function or pre-parser validator that reports a clean configuration error and requires a bounded positive integer (e.g., `1..3600`); consider a retry backoff/jitter after repeated request failures. Add runtime tests for nonnumeric, zero, negative, and valid values.

### 5. Medium — response/job shape errors terminate the synchronous polling process

**Evidence.** `get_pending_jobs` catches only `requests.exceptions.RequestException` (lines 96–98), not JSON decoding or schema/shape errors. It assumes nested mappings and then `run` assumes each `jobs` entry supports `.get` (lines 353–357, 313–314). A stdlib-only stub returning `[None]` caused `process_job` to raise `AttributeError`; outer `run` logged `Fatal error: 'NoneType' object has no attribute 'get'` and called `sys.exit(1)`. This client is synchronous (`requests` and `time.sleep`), not async; one slow request/job also serially blocks the polling loop until its timeout/completion.

**Impact.** A malformed but HTTP-200 Hub response, schema rollout mismatch, or one unexpected job can take down the whole service and cause systemd restart looping instead of safely retrying the next poll. No hardware behavior is implicated.

**Fix.** Catch `ValueError`/JSON errors and validate the response/job list before iterating; reject/record malformed jobs without exiting the poller. Wrap processing per job so one bad item does not abort the batch. Retain bounded request timeouts and add backoff. Add tests for invalid JSON, missing `result/data/json/jobs`, non-list jobs, and non-mapping job entries.

## Other verified contract observations

- `bash -n install_hub_client.sh` and `python3 -m py_compile` of the config/runtime contracts passed.
- Focused `server/companion-installers.test.ts` passed: **20/20**, including its normal space-containing-folder Hub unit verification on systemd 255. It does not test the incomplete-local-suite or malformed-path cases above.
- The installer’s `python3 -m pip install --break-system-packages requests` is correctly scoped to the Hub runtime’s direct third-party import. The current sandbox has Python 3.12; no Raspberry Pi OS Trixie/Python 3.13 package install was attempted, so Py3.13 availability was not hardware/OS tested.
- Alias handling is internally consistent for maintained files: `quiver_set WEB_SERVER_URL ...` synchronizes `HUB_URL`, and runtime canonicalizes aliases. Existing `.env`/legacy `forwarder.env` are parsed as literal data rather than sourced. No alias defect was confirmed in the assigned installer path.
- The bootstrap generates only `FWPULL_PI_IP*` and `FWPULL_PORT`; the helper deliberately excludes `FWPULL_ENABLE`. It copies the parameter file but does not contact or alter the flight controller. This matches the safety language in `OTA_Setup_Guide.md`; no firmware, FC, network, or hardware operation was tested.

## Test limitations

All reproduction used temporary non-`.env` files and temporary units, stubs, or mocked commands. `systemd-analyze verify` was systemd **255.4** in this sandbox, not a live Raspberry Pi OS Debian Trixie host. No actual service start, `daemon-reload`, package installation, GitHub download, HTTP request, camera, flight controller, firmware update, or network interface change occurred.
