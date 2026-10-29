#!/usr/bin/env bash
# Quiver companion-suite bootstrap. Run this installer first, with or without sudo.
# Downloads source files only; never imports a remote .env or rewrites live config.
set -euo pipefail

SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}
DEFAULT_SOURCE="https://github.com/Pan-Robotics/Arrow-Quiver-Hub/tree/main/companion_scripts"
ORIGINAL_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
printf '\nQuiver Hub companion-suite installation\n\n'
if [ "${1:-}" = --local ]; then
    SOURCE_URL="$ORIGINAL_DIR"
else
    read -r -p "Companion source folder [$DEFAULT_SOURCE]: " SOURCE_URL
    SOURCE_URL=${SOURCE_URL:-$DEFAULT_SOURCE}
fi
printf 'Source: %s\nDownload and review only code you trust.\n' "$SOURCE_URL"

if [ "${EUID}" -eq 0 ]; then
    privileged() { "$@"; }
else
    privileged() { sudo "$@"; }
fi
privileged apt-get update
privileged apt-get install -y python3 python3-pip ca-certificates

STAGING_DIR=$(mktemp -d)
trap 'rm -rf -- "$STAGING_DIR"' EXIT
# The bootstrap needs only stdlib Python, so a single downloaded .sh is sufficient.
if [ "${1:-}" = --local ]; then
    # Useful for an offline/local source bundle. Package installation still needs
    # repositories or an existing package cache; no GitHub download is attempted.
    cp -a -- "$ORIGINAL_DIR/." "$STAGING_DIR/"
    rm -f -- "$STAGING_DIR/.env" "$STAGING_DIR/forwarder.env"
    for required in companion_config.py companion-config.example installer_common.sh; do
        [ -f "$STAGING_DIR/$required" ] || { echo "Local suite is missing $required" >&2; exit 1; }
    done
else
python3 - "$SOURCE_URL" "$STAGING_DIR" <<'PY'
import json
import pathlib
import sys
import urllib.parse
import urllib.request

source, destination = sys.argv[1:]
url = urllib.parse.urlparse(source)
parts = [urllib.parse.unquote(p) for p in url.path.strip('/').split('/')]
if url.scheme != 'https' or url.query or url.fragment:
    raise SystemExit('Use an HTTPS GitHub tree-folder URL without a query or fragment.')
if url.hostname == 'github.com' and len(parts) >= 5 and parts[2] == 'tree':
    owner, repo, _, ref, *folder_parts = parts
elif url.hostname == 'raw.githubusercontent.com' and len(parts) >= 4:
    owner, repo, ref, *folder_parts = parts
else:
    raise SystemExit('Expected https://github.com/OWNER/REPO/tree/REF/companion_scripts')
if any(p in ('', '.', '..') or '/' in p or '\\' in p for p in [owner, repo, *folder_parts]):
    raise SystemExit('Invalid repository folder path.')
folder = '/'.join(folder_parts)
root = pathlib.Path(destination)


def read_url(address):
    request = urllib.request.Request(address, headers={'User-Agent': 'Quiver-Companion-Installer',
                                                     'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


try:
    # Pin a single commit so the complete suite cannot mix versions mid-download.
    base = 'https://api.github.com/repos/' + urllib.parse.quote(owner) + '/' + urllib.parse.quote(repo)
    commit = json.loads(read_url(base + '/commits/' + urllib.parse.quote(ref, safe='')))
    sha = commit['sha']
    tree = json.loads(read_url(base + '/git/trees/' + sha + '?recursive=1'))
    if tree.get('truncated'):
        raise ValueError('Repository tree is truncated; use a smaller source repository.')
    count = 0
    for entry in tree.get('tree', []):
        path = entry.get('path', '')
        if not path.startswith(folder + '/') or entry.get('type') != 'blob':
            continue
        relative = pathlib.PurePosixPath(path[len(folder) + 1:])
        if relative.is_absolute() or '..' in relative.parts or any('\\' in p for p in relative.parts):
            raise ValueError('Unsafe source path: ' + path)
        if entry.get('mode') == '120000':
            raise ValueError('Symlink source files are not supported: ' + path)
        # Secrets and local generated configuration are never downloaded.
        if relative.name in ('.env', 'forwarder.env', 'go2rtc.yaml'):
            continue
        raw_url = ('https://raw.githubusercontent.com/' + urllib.parse.quote(owner) + '/' +
                   urllib.parse.quote(repo) + '/' + sha + '/' + urllib.parse.quote(path, safe='/'))
        payload = read_url(raw_url)
        target = root.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        count += 1
    required = ['raspberry_pi_client.py', 'telemetry_forwarder.py', 'logs_ota_service.py',
                'siyi_camera_controller.py', 'camera_stream_service.py', 'firmware_puller.lua',
                'net_webserver_put.lua', 'install_hub_client.sh', 'install_telemetry_forwarder.sh',
                'install_logs_ota.sh', 'install_camera_services.sh', 'installer_common.sh',
                'companion_config.py', 'companion-config.example', 'quiver-hub-client.service',
                'telemetry-forwarder.service', 'logs-ota.service', 'siyi-camera.service',
                'camera-stream.service', 'COMPANION_SERVICES.md', 'OTA_Setup_Guide.md']
    missing = [name for name in required if not (root / name).is_file()]
    if missing:
        raise ValueError('Source is missing updated suite files: ' + ', '.join(missing) +
                         '. Publish the updated companion_scripts folder to this repository first.')
    print(f'Downloaded {count} files from commit {sha[:12]}.')
except Exception as error:
    raise SystemExit(f'Download failed; the installed suite was not changed: {error}')
PY
fi

# Only begin installation after the entire download has succeeded.
SCRIPT_DIR="$STAGING_DIR"
source "$SCRIPT_DIR/installer_common.sh"
# Preserve config discovery when an installed bootstrap is run again.
if [ -z "${QUIVER_ENV_FILE:-}" ] && [ -f "$ORIGINAL_DIR/.env" ]; then
    export QUIVER_CONFIG_PROBE="$ORIGINAL_DIR/.env"
fi
# Legacy standalone deployments can migrate their existing credentials too.
if [ -f "$ORIGINAL_DIR/forwarder.env" ]; then
    cp -- "$ORIGINAL_DIR/forwarder.env" "$SCRIPT_DIR/forwarder.env"
fi
quiver_configure
quiver_prompt WEB_SERVER_URL "Quiver Hub URL"
quiver_prompt DRONE_ID "Drone ID"
quiver_prompt API_KEY "API key" secret
if [ -z "$(quiver_get API_KEY)" ] || [ -z "$(quiver_get WEB_SERVER_URL)" ] || [ -z "$(quiver_get DRONE_ID)" ] || [ "$(quiver_get WEB_SERVER_URL)" = "https://your-quiver-hub-server.com" ]; then
    echo "Set the Hub URL, DRONE_ID, and API_KEY in $ENV_FILE before installing the service." >&2
    exit 1
fi
quiver_set COMPANION_SOURCE_URL "$SOURCE_URL"
printf '\nNetwork defaults are in %s. Edit them for your hardware before starting services.\n' "$ENV_FILE"
printf 'No DHCP server or host network interface configuration will be installed.\n'

privileged python3 -m pip install --break-system-packages requests
# Install every fetched file, including shell/Python/Lua/service/Markdown files.
while IFS= read -r -d '' file; do
    relative=${file#"$SCRIPT_DIR/"}
    case "$relative" in forwarder.env|.env|go2rtc.yaml|firmware_puller.param|__pycache__/*|*.pyc) continue ;; esac
    privileged mkdir -p -- "$INSTALL_DIR/$(dirname "$relative")"
    quiver_copy "$relative"
done < <(find "$SCRIPT_DIR" -type f -print0)

privileged python3 "$INSTALL_DIR/companion_config.py" render-fc-params "$ENV_FILE" "$INSTALL_DIR/firmware_puller.param"
privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/firmware_puller.param"

cat > "$STAGING_DIR/hub-client.unit" <<EOF
[Unit]
Description=Quiver Hub Companion Client
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$(quiver_systemd_path "$INSTALL_DIR")
EnvironmentFile=$(quiver_systemd_path "$ENV_FILE")
Environment=$(quiver_systemd_path "QUIVER_ENV_FILE=$ENV_FILE")
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $(quiver_systemd_path "$INSTALL_DIR/raspberry_pi_client.py")
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=quiver-hub-client
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$(quiver_systemd_path "$INSTALL_DIR") $(quiver_systemd_path "$(quiver_get CONFIG_DIR)") $(quiver_systemd_path "$(quiver_get PARSERS_DIR)")

[Install]
WantedBy=multi-user.target
EOF
privileged mkdir -p -- "$SYSTEMD_DIR"
privileged install -m 644 "$STAGING_DIR/hub-client.unit" "$SYSTEMD_DIR/quiver-hub-client.service"
privileged systemctl daemon-reload
printf '\nInstalled the complete companion suite in %s\n' "$INSTALL_DIR"
printf 'Shared configuration: %s\n' "$ENV_FILE"
printf '\nStart the hub client when ready:\n  sudo systemctl enable --now quiver-hub-client\n'
printf '\nInstall the remaining services (same folder/config):\n'
printf '  sudo bash %q\n' "$INSTALL_DIR/install_telemetry_forwarder.sh" "$INSTALL_DIR/install_logs_ota.sh" "$INSTALL_DIR/install_camera_services.sh"
printf '\nLua files must be copied to the flight controller separately; see OTA_Setup_Guide.md.\n'
