#!/usr/bin/env python3
"""Privileged installer preflight helpers; never start services or touch credentials."""
import argparse
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


def safe_path(value):
    if not value.startswith('/') or value != value.strip() or any(ord(c) < 32 or c in '\"\'\\$*?[' for c in value):
        raise ValueError('Use an absolute path without control characters or quotes (spaces are supported).')
    path = Path(os.path.normpath(value))
    if path == Path('/'):
        raise ValueError('The filesystem root is not a companion directory.')
    for component in [path, *path.parents]:
        if component.is_symlink():
            raise ValueError('Refusing a symlink path: ' + str(component))
    return path


def verify_units(stage, destination):
    paths = sorted(stage.glob('*.service'))
    if not paths:
        raise ValueError('No staged service units to validate.')
    for path in paths:
        text = path.read_text()
        if re.search(r'^[^#\n]*[A-Z_]+_PLACEHOLDER', text, re.MULTILINE):
            raise ValueError('Unrendered template: ' + path.name)
    if not shutil.which('systemd-analyze'):
        raise ValueError('systemd-analyze is required before installing any service unit.')
    environment = os.environ.copy()
    environment['SYSTEMD_UNIT_PATH'] = str(stage) + ':' + str(destination) + ':' + environment.get('SYSTEMD_UNIT_PATH', '/etc/systemd/system:/run/systemd/system:/usr/local/lib/systemd/system:/usr/lib/systemd/system:/lib/systemd/system')
    result = subprocess.run(['systemd-analyze','verify','--man=no','--recursive-errors=one',*[str(p) for p in paths]], capture_output=True, text=True, env=environment)
    diagnostics = result.stdout + result.stderr
    if diagnostics:
        print(diagnostics, end='', file=sys.stderr)
    if result.returncode:
        raise ValueError('Unit validation failed BEFORE replacement/enable/restart. Inspect the exact diagnostics above; installed units are unchanged.')
    print('Validated staged units:', ', '.join(p.name for p in paths))
    return paths


def install_units(stage, destination):
    stage = safe_path(str(stage))
    destination = safe_path(str(destination))
    paths = verify_units(stage, destination)
    destination.mkdir(parents=True, exist_ok=True)
    for source in paths:
        target = destination / source.name
        if target.is_symlink():
            raise ValueError('Refusing a symlink unit destination: ' + str(target))
        if target.exists() and not target.is_file():
            raise ValueError('Unit destination is not a regular file: ' + str(target))
    # Only write after the entire proposed unit set has parsed successfully.
    for source in paths:
        target = destination / source.name
        if target.is_file():
            backup = target.with_name(target.name + '.before-quiver-update')
            if backup.is_symlink():
                raise ValueError('Refusing a symlink backup destination.')
            if not backup.exists():
                shutil.copy2(target, backup)
        fd, temporary = tempfile.mkstemp(prefix='.quiver-unit-', dir=destination)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(source.read_bytes())
                handle.flush()
                os.fsync(handle.fileno())
                os.fchmod(handle.fileno(), 0o644)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print('Installed validated units; prior definitions backed up when present.')


def copy_source(source, target):
    source, target = Path(source), safe_path(target)
    if source.is_symlink() or not source.is_file():
        raise ValueError('Source must be a regular non-symlink file: ' + str(source))
    if source.resolve() == target:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.quiver-source-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(source.read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o755 if target.suffix in {'.py','.sh'} else 0o644)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sdk_preflight():
    from importlib.metadata import version
    installed = version('mavsdk')
    if installed != '3.17.4':
        raise ValueError('This suite requires mavsdk==3.17.4; found ' + installed +
                         '. Run the updated installer with its pinned requirements. Native v4 is incompatible.')
    import requests, aiohttp
    import mavsdk
    from mavsdk import System
    from mavsdk.ftp import FtpResult
    try:
        System()  # No connect(), process start, or hardware operation.
    except Exception as error:
        raise ValueError('MAVSDK System API does not match legacy 3.17.4 (' +
                         type(error).__name__ + '); reinstall the pinned requirements.') from None
    print('Legacy MAVSDK/FTP API preflight passed:', installed)
    print('Interpreter:', sys.executable)
    print('MAVSDK module:', getattr(mavsdk, '__file__', 'unknown'))


def service_run(env_file, command):
    """Execute checks with literal service settings; never source shell data."""
    from companion_config import parse_environment_file
    env_file = safe_path(str(env_file))
    if not env_file.is_file():
        raise ValueError('Service configuration file is missing.')
    if not command or not os.path.isabs(command[0]):
        raise ValueError('An absolute service interpreter/command is required.')
    environment = os.environ.copy()
    environment.update(parse_environment_file(env_file))
    environment['QUIVER_ENV_FILE'] = str(env_file)
    os.execve(command[0], command, environment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    path = commands.add_parser('path'); path.add_argument('value')
    copy = commands.add_parser('copy'); copy.add_argument('source'); copy.add_argument('target')
    units = commands.add_parser('install-units'); units.add_argument('stage',type=Path); units.add_argument('destination',type=Path)
    commands.add_parser('sdk-preflight')
    service = commands.add_parser('service-run')
    service.add_argument('env_file', type=Path)
    service.add_argument('program', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'path': print(safe_path(args.value))
    elif args.command == 'copy': copy_source(args.source,args.target)
    elif args.command == 'install-units': install_units(args.stage,args.destination)
    elif args.command == 'sdk-preflight': sdk_preflight()
    elif args.command == 'service-run': service_run(args.env_file, args.program)

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, ImportError, TypeError, RuntimeError) as error:
        print('Quiver installer preflight:', error, file=sys.stderr)
        raise SystemExit(2)
