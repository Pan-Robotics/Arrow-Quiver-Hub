#!/usr/bin/env bash
# Read-only diagnostics: no installs, reloads, restarts, networking, or .env output.
set -euo pipefail
INSTALL_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [ "${1:-}" = --install-dir ] && [ "$#" -eq 2 ]; then
    INSTALL_DIR=$2
elif [ "$#" -ne 0 ]; then
    echo "Usage: bash $0 [--install-dir /absolute/companion/folder]" >&2
    exit 2
fi
python3 - "$INSTALL_DIR" "${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

install = Path(sys.argv[1])
units = Path(sys.argv[2])
if not install.is_absolute() or not install.is_dir():
    raise SystemExit('Choose an existing absolute companion installation directory.')
names = ('quiver-hub-client.service','telemetry-forwarder.service','logs-ota.service','go2rtc.service','tailscale-funnel.service','camera-stream.service','siyi-camera.service')

def redact(text):
    # Never emit API keys/tokens if another tool includes an unexpected command.
    text = re.sub(r'(?i)((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)(\S+)', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)(--(?:api-key|token|password)\s+)(\S+)', r'\1[REDACTED]', text)
    return re.sub(r'(https?://)[^/@\s]+@', r'\1[REDACTED]@', text)

print('Quiver companion diagnostics (read-only; no credentials/config contents)')
print('Architecture:', platform.machine())
print('Python:', platform.python_version())
print('Install directory:', install)
os_release = Path('/etc/os-release')
if os_release.is_file():
    for line in os_release.read_text().splitlines():
        if line.startswith(('PRETTY_NAME=', 'VERSION_CODENAME=')):
            print(line)
manifest = install / 'companion-suite.manifest.json'
expected = {}
if manifest.is_file():
    try:
        data = json.loads(manifest.read_text())
        print('Installed source commit:', data.get('source_commit', 'unknown/local bundle'))
        expected = data.get('files', {})
    except (ValueError, OSError):
        print('WARNING: source manifest is unreadable or invalid.')
else:
    print('WARNING: no installed source manifest; this may be an older/unversioned suite.')
print('\nInstalled source hashes (compare these with the published bundle):')
for name in ('installer_common.sh','install_hub_client.sh','install_telemetry_forwarder.sh','install_logs_ota.sh','install_camera_services.sh','companion_config.py'):
    path = install / name
    if not path.is_file():
        print(name, 'MISSING')
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    state = 'MATCH' if expected.get(name) == digest else ('MODIFIED' if name in expected else 'UNVERSIONED')
    print(name, digest, state)
config = Path(os.environ.get('QUIVER_ENV_FILE', str(install / '.env')))
if config.is_file():
    print('\nConfiguration file exists:', config, 'mode:', oct(config.stat().st_mode & 0o777))
else:
    print('\nWARNING: configuration file missing:', config)
print('\nInstalled unit directives:')
found = []
for name in names:
    path = units / name
    if not path.is_file():
        print(name, 'NOT INSTALLED')
        continue
    found.append(str(path))
    print(name, 'sha256:', hashlib.sha256(path.read_bytes()).hexdigest())
    for line in path.read_text().splitlines():
        if line.startswith(('WorkingDirectory=', 'EnvironmentFile=')):
            print(' ', redact(line))
        if '_PLACEHOLDER' in line and not line.lstrip().startswith('#'):
            print(' WARNING: unrendered template marker in installed unit.')
if shutil.which('systemd-analyze') and found:
    version = subprocess.run(['systemd-analyze', '--version'], capture_output=True, text=True)
    print('\nSystemd parser:', version.stdout.splitlines()[0] if version.stdout else 'unknown')
    result = subprocess.run(['systemd-analyze','verify','--man=no','--recursive-errors=no',*found], capture_output=True, text=True)
    print('Unit verification exit:', result.returncode)
    print(redact(result.stdout + result.stderr) or 'No unit errors reported.')
else:
    print('WARNING: systemd-analyze unavailable or no companion units installed.')
if shutil.which('systemctl'):
    print('\nRead-only service states:')
    result = subprocess.run(['systemctl','show','--no-pager','--property=Id,LoadState,FragmentPath,UnitFileState,ActiveState,SubState,Result,ExecMainStatus',*names], capture_output=True, text=True)
    print(redact(result.stdout + result.stderr))
print('Diagnostics complete. No configuration, unit, or service state was changed.')
PY
