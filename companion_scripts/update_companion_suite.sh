#!/usr/bin/env bash
# Source-only suite refresh. .env/generated configs and unrelated services stay untouched.
set -euo pipefail
INSTALL_DIR=
REF=main
SOURCE_REPO=Pan-Robotics/Arrow-Quiver-Hub
INSTALL_TELEMETRY=false
TEST_RUN=false
TEST_SECONDS=30
NO_START=false
DISABLE_CAN=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --install-dir|--ref|--repo|--test-seconds)
            [ "$#" -ge 2 ] || { echo "$1 requires a value." >&2; exit 2; }
            case "$1" in
                --install-dir) INSTALL_DIR=$2 ;;
                --ref) REF=$2 ;;
                --repo) SOURCE_REPO=$2 ;;
                --test-seconds) TEST_SECONDS=$2 ;;
            esac
            shift ;;
        --install-telemetry) INSTALL_TELEMETRY=true ;;
        --test-run) TEST_RUN=true ;;
        --no-start) NO_START=true ;;
        --disable-uavcan) DISABLE_CAN=true ;;
        --help)
            echo "Usage: sudo bash update_companion_suite.sh --install-dir /chosen/quiver [--ref COMMIT] [--repo OWNER/REPO] [--install-telemetry --test-run --test-seconds 30 --no-start --disable-uavcan]"
            echo "Refreshes all tracked companion source atomically with backups; never downloads .env or restarts unrelated services."
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
[ "$EUID" -eq 0 ] || { echo "Run with sudo; installed source is normally root-owned." >&2; exit 2; }
command -v python3 >/dev/null || { echo "Python3 is required for source download." >&2; exit 2; }
if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR=$(python3 - <<'PY'
import os, pathlib, pwd
user = os.environ.get('SUDO_USER') or pwd.getpwuid(os.getuid()).pw_name
print(pathlib.Path(pwd.getpwnam(user).pw_dir) / 'quiver')
PY
)
fi
case "$TEST_SECONDS" in ''|*[!0-9]*) echo "Test duration must be 1..300 seconds." >&2; exit 2 ;; esac
[ "$TEST_SECONDS" -ge 1 ] && [ "$TEST_SECONDS" -le 300 ] || { echo "Test duration must be 1..300 seconds." >&2; exit 2; }
if [ "$TEST_RUN" = true ] && [ "$INSTALL_TELEMETRY" != true ]; then
    echo "Use --install-telemetry with --test-run." >&2; exit 2
fi

python3 - "$SOURCE_REPO" "$REF" "$INSTALL_DIR" <<'PY'
import ast
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

repo, ref, chosen = sys.argv[1:]
if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or '..' in repo:
    raise SystemExit('Use an OWNER/REPO GitHub repository name.')
if not ref or ref.startswith('-') or any(ord(c) < 32 for c in ref):
    raise SystemExit('Invalid source branch/commit.')
install = Path(chosen)
if not install.is_absolute() or str(install) != chosen.strip() or any(ord(c) < 32 or c in '\\"\'$*?[' for c in chosen):
    raise SystemExit('Choose a dedicated absolute install path without control/quote characters.')
install = Path(os.path.normpath(chosen))
if install in (Path('/'), Path('/home'), Path('/usr'), Path('/etc'), Path('/var'), Path('/opt'), Path('/srv')) or any(install.is_relative_to(Path(p)) for p in ('/usr','/etc','/bin','/sbin','/lib')):
    raise SystemExit('Refusing a system directory as the companion installation.')
for component in (install, *install.parents):
    if component.is_symlink():
        raise SystemExit('Refusing a symlink in the install path.')
if not install.is_dir():
    raise SystemExit('Install folder is missing. Run the Hub bootstrap first, or select your actual installed suite.')
if not all((install / name).is_file() for name in ('companion_config.py', 'raspberry_pi_client.py')):
    raise SystemExit('This is not an installed companion suite. Select the actual quiver folder.')
manifest_path = install / 'companion-suite.manifest.json'
if manifest_path.is_symlink() or (manifest_path.exists() and not manifest_path.is_file()):
    raise SystemExit('Manifest path is not a regular non-symlink file; installed source/config unchanged.')

MAX_ARCHIVE = 128 * 1024 * 1024
MAX_SOURCES = 32 * 1024 * 1024

def read_url(url, maximum=MAX_ARCHIVE):
    request = urllib.request.Request(url, headers={'User-Agent':'Quiver-Suite-Updater','Accept':'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ValueError('Source download exceeds the bounded size limit.')
    return payload

try:
    if re.fullmatch(r'[0-9a-fA-F]{40}', ref):
        commit = ref.lower()
    else:
        detail = json.loads(read_url('https://api.github.com/repos/' + repo + '/commits/' + urllib.parse.quote(ref, safe=''), 1024 * 1024))
        commit = detail['sha']
        if not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise ValueError('Source did not resolve to a complete commit.')
    archive = zipfile.ZipFile(io.BytesIO(read_url('https://codeload.github.com/' + repo + '/zip/' + commit)))
    files = {}
    total = 0
    for entry in archive.infolist():
        parts = PurePosixPath(entry.filename).parts
        if len(parts) < 3 or parts[1] != 'companion_scripts' or entry.is_dir():
            continue
        relative = PurePosixPath(*parts[2:])
        if relative.is_absolute() or '..' in relative.parts or any('\\' in p for p in relative.parts):
            raise ValueError('Unsafe source path in archive.')
        if any(p.startswith('.') or p == '__pycache__' for p in relative.parts):
            continue
        if relative.name in ('forwarder.env','go2rtc.yaml','firmware_puller.param','companion-suite.manifest.json'):
            continue
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValueError('Source archive contains a symlink.')
        if relative.suffix not in ('.sh','.py','.lua','.md','.service','.example','.txt'):
            continue
        if str(relative) in files:
            raise ValueError('Duplicate source path in archive.')
        total += entry.file_size
        if total > MAX_SOURCES:
            raise ValueError('Extracted source exceeds the bounded size limit.')
        files[str(relative)] = archive.read(entry)
    required = ['install_hub_client.sh','install_telemetry_forwarder.sh','installer_common.sh','installer_support.py',
                'companion_config.py','companion-config.example','requirements-companion.txt','telemetry_forwarder.py',
                'raspberry_pi_client.py','logs_ota_service.py','camera_stream_service.py','siyi_camera_controller.py',
                'diagnose_companion.sh','repair_companion_services.sh','update_companion_suite.sh','README.md',
                'firmware_puller.lua','net_webserver_put.lua','telemetry-forwarder.service']
    missing = [name for name in required if name not in files]
    if missing:
        raise ValueError('Incomplete/current suite missing: ' + ', '.join(missing))
    # Validate code syntax and all target paths before replacing any source.
    for name, payload in files.items():
        target = install / name
        for component in (target, *target.parents):
            if component.is_symlink():
                raise ValueError('Refusing a symlink source destination.')
            if component == install:
                break
        if target.exists() and not target.is_file():
            raise ValueError('Source destination is not a regular file.')
        if name.endswith('.py'):
            ast.parse(payload.decode('utf-8'), filename=name)
        if name.endswith('.sh'):
            result = subprocess.run(['bash','-n'], input=payload, capture_output=True)
            if result.returncode:
                raise ValueError('Bash syntax failed: ' + name)
except Exception as error:
    raise SystemExit('Download/validation failed; installed source/config unchanged (' + type(error).__name__ + '). ' + str(error))

changed = [name for name, payload in files.items() if not (install/name).is_file() or (install/name).read_bytes() != payload]
backup = None
created = []
written = []
original_stats = {}
try:
    if changed:
        backup = Path(tempfile.mkdtemp(prefix='.source-backup-', dir=install))
        os.chmod(backup, 0o700)
        for name in changed:
            target = install / name
            if target.is_file():
                previous = target.stat()
                original_stats[name] = (previous.st_uid, previous.st_gid, stat.S_IMODE(previous.st_mode))
                saved = backup / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
            else:
                created.append(name)
        for name in changed:
            target = install / name
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.source-new-', dir=target.parent)
            try:
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(files[name]); handle.flush(); os.fsync(handle.fileno())
                    os.fchmod(handle.fileno(), 0o755 if target.suffix in ('.py','.sh') else 0o644)
                os.replace(temporary, target)
                written.append(name)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
    manifest = {'source_commit':commit,'repository':repo,'files':{name:hashlib.sha256(payload).hexdigest() for name,payload in files.items()}}
    manifest_path = install / 'companion-suite.manifest.json'
    if manifest_path.is_symlink() or (manifest_path.exists() and not manifest_path.is_file()):
        raise ValueError('Manifest path is not a regular non-symlink file.')
    fd, temporary = tempfile.mkstemp(prefix='.suite-manifest-', dir=install)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(manifest, handle, indent=2); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        os.replace(temporary, manifest_path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
except Exception:
    for name in reversed(written):
        target = install / name
        if name in created: target.unlink(missing_ok=True)
        else:
            shutil.copy2(backup / name, target)
            uid, gid, mode = original_stats[name]
            os.chown(target, uid, gid)
            os.chmod(target, mode)
    raise SystemExit('Source update failed; prior source restored. Configuration was not touched. Inspect the source backup.')
print('Suite source commit:', commit)
print('Updated source files:', len(changed), 'of', len(files))
for name in changed: print('  ' + name)
if backup: print('Previous source backup:', backup)
print('Local .env, generated camera/FC configuration and user data were NOT changed.')
print('Running processes still use their previously loaded code until deliberately restarted.')
PY

if [ "$INSTALL_TELEMETRY" = true ]; then
    ARGS=()
    if [ "$TEST_RUN" = true ]; then ARGS+=(--test-run --test-seconds "$TEST_SECONDS"); fi
    if [ "$NO_START" = true ]; then ARGS+=(--no-start); fi
    if [ "$DISABLE_CAN" = true ]; then ARGS+=(--disable-uavcan); fi
    export QUIVER_INSTALL_DIR="$INSTALL_DIR"
    export QUIVER_ENV_FILE="${QUIVER_ENV_FILE:-$INSTALL_DIR/.env}"
    bash "$INSTALL_DIR/install_telemetry_forwarder.sh" "${ARGS[@]}"
else
    echo "Source refresh complete; no package changes or service restarts were performed."
fi
