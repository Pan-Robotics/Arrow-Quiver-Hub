#!/usr/bin/env bash
# Fix the quoted WorkingDirectory defect in previously installed Quiver units.
# Usage: sudo bash repair_companion_services.sh [--check]
# No downloads, package installs, credential edits, or service starts/restarts.
set -euo pipefail

CHECK=false
case "${1:-}" in
    --check) CHECK=true ;;
    '') ;;
    *) echo "Usage: sudo bash $0 [--check]" >&2; exit 2 ;;
esac
if [ "$CHECK" = false ] && [ "$EUID" -ne 0 ]; then
    echo "Run with sudo to repair installed units, or use --check for a read-only check." >&2
    exit 1
fi

python3 - "${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}" "$CHECK" <<'PY'
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

unit_dir = Path(sys.argv[1])
check_only = sys.argv[2] == 'true'
names = (
    'quiver-hub-client.service', 'telemetry-forwarder.service',
    'logs-ota.service', 'camera-stream.service', 'siyi-camera.service',
    'go2rtc.service', 'tailscale-funnel.service',
)
if not unit_dir.is_absolute() or not unit_dir.is_dir():
    raise SystemExit('The systemd unit directory must be an existing absolute directory.')
if not shutil.which('systemd-analyze'):
    raise SystemExit('systemd-analyze is required to verify units before any repair.')


def corrected(content):
    """Undo only the previous formatter's surrounding quotes and escapes."""
    output = []
    in_service = False
    for line in content.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            in_service = stripped == '[Service]'
        match = re.fullmatch(r'(\s*WorkingDirectory=)"((?:[^"\\]|\\.)*)"[ \t]*(\r?\n)?', line)
        if in_service and match:
            # Percent specifiers were already escaped by the original installer;
            # keep them escaped. Only undo the formatter's slash/quote escaping.
            value = re.sub(r'\\([\\"])', r'\1', match[2])
            if not value.startswith('/') or any(c in value for c in '\r\n\0'):
                raise ValueError('Refusing a quoted WorkingDirectory that is not an absolute single path.')
            line = match[1] + value + (match[3] or '')
        output.append(line)
    return ''.join(output)


candidates = []
for name in names:
    path = unit_dir / name
    if path.is_symlink():
        raise SystemExit(f'Refusing to modify symlink {path}; inspect its target manually.')
    if not path.is_file():
        continue
    original = path.read_text(encoding='utf-8')
    if re.search(r'^[^#\n]*\b[A-Z_]+_PLACEHOLDER\b', original, re.MULTILINE):
        raise SystemExit(f'{path} is an unrendered source template. Rerun the corrected installer; do not copy templates directly.')
    fixed = corrected(original)
    candidates.append((path, original, fixed))

if not candidates:
    raise SystemExit('No installed Quiver companion units were found; no files changed.')

with tempfile.TemporaryDirectory(prefix='quiver-unit-repair-') as stage:
    paths = []
    for path, original, fixed in candidates:
        target = Path(stage) / path.name
        target.write_text(fixed, encoding='utf-8')
        paths.append(str(target))
    environment = os.environ.copy()
    # Staging all installed companion units together lets systemd validate their
    # dependencies against the corrected versions before replacing any file.
    default_path = '/etc/systemd/system:/run/systemd/system:/usr/local/lib/systemd/system:/usr/lib/systemd/system:/lib/systemd/system'
    environment['SYSTEMD_UNIT_PATH'] = stage + ':' + str(unit_dir) + ':' + environment.get('SYSTEMD_UNIT_PATH', default_path)
    result = subprocess.run(['systemd-analyze', 'verify', '--man=no', *paths], env=environment)
    if result.returncode:
        raise SystemExit('Unit validation failed; no installed units or configuration files were changed.')

changed = [(p, before, after) for p, before, after in candidates if before != after]
if check_only:
    for path, _, _ in changed:
        print(f'Needs repair: {path}')
    print(f'Validation passed for {len(candidates)} unit(s); {len(changed)} need repair. Read-only check: no files changed.')
else:
    for path, original, fixed in changed:
        metadata = path.stat()
        backup = path.with_name(path.name + '.pre-working-directory-fix')
        # Never overwrite an earlier backup. A successful rerun is idempotent.
        try:
            fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, stat.S_IMODE(metadata.st_mode))
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(original)
                stream.flush()
                os.fsync(stream.fileno())
            os.chown(backup, metadata.st_uid, metadata.st_gid)
        fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=unit_dir)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(fixed)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
                os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f'Repaired: {path}\nBackup: {backup}')
    if changed:
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
    print(f'Validation passed for {len(candidates)} unit(s); repaired {len(changed)}.')
    print('Your .env, credentials, scripts, and enablement were not changed. No service was started or restarted.')
    print('When ready: sudo systemctl reset-failed quiver-hub-client')
    print('            sudo systemctl enable --now quiver-hub-client')
    print('            sudo systemctl status quiver-hub-client --no-pager -l')
PY
