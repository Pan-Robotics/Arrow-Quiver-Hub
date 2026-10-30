# `installer_common.sh` audit

## Confirmed findings

### High — `EnvironmentFile=` is rendered with literal quotes and systemd ignores it

**Subject:** `installer_common.sh:31-38`, used as `EnvironmentFile=$(quiver_systemd_path "$ENV_FILE")` by `install_hub_client.sh:162`, `install_telemetry_forwarder.sh:46`, `install_logs_ota.sh:105`, and camera-generated units through `install_camera_services.sh:59,105,127,154`.

`quiver_systemd_path` emits `"/absolute/path"`. That is correct for a word-list argument such as `ExecStart=`, `Environment=`, or `ReadWritePaths=`, but not for `EnvironmentFile=`. In a disposable unit on local systemd 255, `systemd-analyze verify` reported:

```
EnvironmentFile= path is not absolute, ignoring: "/tmp/.../settings.conf"
```

A raw absolute `EnvironmentFile=/tmp/path with spaces/config.conf` produced no parser diagnostic in the same test. Current Debian Trixie ships systemd 257.13, so the target is newer, not an old-suite exception [2]. The systemd manual requires an absolute filename and says a missing, unreadable, or invalid environment file causes startup failure [1]. `verify` returned zero after the parser warning locally, so the precise observed behavior is **ignore the `EnvironmentFile` directive**, not an assertion that `verify` itself fails.

All three reported installers therefore generate a current bad setting independently of stale installed definitions. `Environment="QUIVER_ENV_FILE=..."` remains syntactically valid and lets Python services dynamically reload the file, which can mask the defect for Python-only settings. It does not restore variables expanded by systemd itself: `tailscale-funnel.service` expands `${TAILSCALE_FUNNEL_PORT}`, `${GO2RTC_API_HOST}`, and `${GO2RTC_API_PORT}` from the ignored file. The current README and companion-services guide compound the issue by saying quotes remain appropriate for `EnvironmentFile=` (`README.md:161`, `COMPANION_SERVICES.md:170`). The repair script only unquotes `WorkingDirectory=` and will not repair this new defect.

**Fix:** Split the formatter by directive type. Keep the current word quoting for `ExecStart=`, `Environment=`, and `ReadWritePaths=`, but introduce an `EnvironmentFile` formatter that emits a normalized absolute filename without surrounding literal quotes (using systemd escaping only where required). Generate temporary units for every installer and fail the installer if `systemd-analyze verify` emits any diagnostic for them. Update both documentation statements and extend the repair script to correct quoted `EnvironmentFile=` values after validating the resulting units.

### High — a service-account-controlled config can make a root installer `chown` arbitrary directories

**Subject:** `installer_common.sh:122-126`.

`CONFIG_DIR` and `PARSERS_DIR` are read from the shared environment file, which is deliberately owned by `SERVICE_USER` at mode `0600` (`quiver_set`, lines 13-15). Neither value is required to be absolute, normalized, beneath the install directory, or a newly-created safe path. A later root installer executes:

```bash
mkdir -p -- "$config_dir" "$parsers_dir"
chown "$SERVICE_USER:$SERVICE_GROUP" "$config_dir" "$parsers_dir"
```

A safe temporary reproduction supplied a root-owned existing directory as both values in a disposable `*.conf`; invoking `quiver_configure` as root changed it from `root:root` to `daemon:daemon`. This is an install-time privilege boundary: a service user can alter its own shared configuration and an administrator rerunning telemetry, camera, or Logs & OTA then transfers ownership of an arbitrary pre-existing directory.

**Fix:** Do not use mutable runtime configuration as a privileged ownership target. Derive these locations from the canonical `INSTALL_DIR`, or accept only canonical, absolute, normalized paths under an explicitly allowed root-owned prefix; reject symlinks and existing directories not created/owned by the installer. Do validation before `mkdir`/`chown`, and do not grant the service account ownership of code or configuration roots that root installers later trust.

### High — `quiver_copy` follows an existing destination symlink while running privileged

**Subject:** `installer_common.sh:53-64`.

`quiver_configure` gives `INSTALL_DIR` to the service account (`line 106`). On a rerun performed as root, `quiver_copy` invokes `cp -- "$source" "$target"` and then `chown` without rejecting a destination symlink or unsafe parent components. GNU `cp` follows a destination symlink in this form. A temporary fixture made `INSTALL_DIR/companion-config.example` a symlink to a separate file; `quiver_copy companion-config.example` replaced the referent with the shipped template and preserved the symlink. This is not a same-file-copy issue: the `realpath` comparison merely decides whether the dangerous copy is needed.

The affected helper is used by all installers and by the hub bootstrap's recursive copy. A writable service-owned install directory therefore lets that account prepare a target that a later root installer overwrites and `chown`s.

**Fix:** Keep privileged program files in a root-owned directory not writable by the runtime account. Before every privileged copy, reject a symlink target and any symlinked parent component (including nested relative paths); copy into a root-owned staging directory and atomically replace a verified regular destination without dereferencing it. Do not treat `realpath` equality as a symlink-safety check.

### High — documented non-root bootstrap fails if the selected service user differs from the invoking user

**Subject:** `installer_common.sh:20, 119-124`; contract: `install_hub_client.sh:2,18-24` and `README.md:13`.

The hub bootstrap advertises non-root execution and allows the operator to select the service account. `quiver_set` creates the selected account's `0600` file under sudo, but subsequent `quiver_get` calls run unprivileged. `quiver_configure` itself calls `quiver_get CONFIG_DIR` and `quiver_get PARSERS_DIR` immediately after the `chown`. With `set -e` in the hub installer, this exits before installation completes if the invoker cannot read the selected account's configuration.

A disposable reproduction ran the helper as `ubuntu`, selected existing user `daemon`, and used a temporary `shared.conf`: `quiver_configure` exited 2 after `companion_config: [Errno 13] Permission denied`, leaving the file `daemon:daemon 0600`. This is a direct contradiction of the documented bootstrap flow, not a hardware-dependent condition.

**Fix:** Define one coherent access model. Either require root when the selected service account differs from the invoking user, or make configuration reads performed by installer code privileged while avoiding secret echo to an unauthorized terminal. Preserve `0600`; do not solve this by making API keys world/group-readable. Add a test that runs the bootstrap as one non-root account and selects another valid account.

### Medium — external `QUIVER_ENV_FILE` is insufficiently validated before privileged rewrite and unit emission

**Subject:** `installer_common.sh:75,103-105,108-120`; formatter at `31-38`.

The documented override accepts any string beginning with `/`. It is not normalized and rejects neither carriage returns nor line feeds, unlike `INSTALL_DIR` (`lines 99-102`). The helper then invokes privileged `init`/`set` and changes the target's ownership and mode. A disposable run against an unrelated temporary `unrelated.conf` changed that pre-existing root-owned file to `daemon:daemon 0600`; `initialize_environment` also merges template defaults into existing content by design.

Separately, systemd 255 rejected a raw `EnvironmentFile=/tmp/a/../b/config.conf` as “path is not normalized”. A newline passed through `quiver_systemd_path` physically split a generated directive; a parser-only fixture showed it could add a following `ExecStartPre=` line after a closing quote. This requires a hostile/malformed explicit environment override, not a normal value written by `companion_config.py`, but the common helper advertises and directly consumes the override.

**Fix:** Canonicalize `QUIVER_ENV_FILE` with `realpath -m`, require an absolute normalized regular-file location within an intended managed configuration root (or require an explicit safe creation confirmation for a new custom path), reject `\r`, `\n`, and control characters before every renderer, and refuse to change ownership/mode of an existing unrecognized file. Use the canonical result in both the file operations and the unit.

### Low — the immediate `.env` helper is not fully compatible with the systemd syntax it claims to parse

**Contract:** `companion_config.py:2-5,29-65,82-94`; used by `quiver_get` at `installer_common.sh:8-10`.

The helper describes itself as an `EnvironmentFile`-compatible parser, but `parse_environment_file` first applies `splitlines()`. Systemd accepts a double-quoted `EnvironmentFile` value spanning multiple physical lines [1]; the helper truncates the value at the first line and ignores the continuation. A temporary `*.conf` containing a multiline quoted `HUB_URL` returned only `https://first.example` from `companion_config.py get`, although systemd would treat the quoted value as one value. The helper also ignores `;` comment syntax recognized by systemd, though that case is benign because it is simply not an assignment.

This is a compatibility defect rather than a normal installer path: the helper's writer intentionally rejects newlines (`companion_config.py:104-106`), so installer-created files do not trigger it. It becomes material for operator-maintained or externally generated shared configuration and can make installer prompt defaults diverge from the unit's environment once `EnvironmentFile=` is fixed.

**Fix:** Either implement systemd's quoted/multiline EnvironmentFile grammar (and test it against target systemd), or explicitly enforce a stricter single-line subset on input with a clear error instead of silently parsing a different value.

## Checks that did not produce a finding

- `quiver_systemd_directory` correctly emits an unquoted absolute `WorkingDirectory`; a disposable space-containing directory passed `systemd-analyze verify`. This fixes the earlier quoted-working-directory defect. The current issue is specifically the reuse of word quoting for `EnvironmentFile=`.
- `HUB_URL`/`WEB_SERVER_URL` alias handling is consistent in the immediate helper: `set` synchronizes both aliases and resolution gives `HUB_URL` the documented same-source tie-breaker. No alias regression was reproduced.
- `installer_common.sh` passed `bash -n`; the helper passed local Python 3.12 `py_compile`. The common file itself installs no packages and its Python calls use only the standard-library `companion_config.py`. Debian Trixie `python3` is 3.13.5 and is available for arm64 [3]; dependency-wheel availability and runtime async behavior belong to the individual installers/runtimes and were not exercised (no package install, network call, service start, or hardware test was performed).

[1]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile= "systemd.exec EnvironmentFile documentation"
[2]: https://packages.debian.org/trixie/systemd "Debian Trixie systemd package"
[3]: https://packages.debian.org/trixie/python3 "Debian Trixie default Python 3 package"
