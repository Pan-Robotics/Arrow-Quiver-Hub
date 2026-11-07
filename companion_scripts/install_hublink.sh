#!/usr/bin/env bash
# Install the HubLink stream service (pull mode): the drone becomes a tailnet /
# drone-subnet service that one or more Hubs connect to and pull from.
# No network-interface or Tailscale changes are made here.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}
SERVICE_NAME=hublink
NO_START=false
REWIRE_TELEMETRY=true
while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-start) NO_START=true ;;
        --keep-telemetry-push) REWIRE_TELEMETRY=false ;;
        --uninstall)
            [ "$EUID" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
            source "$SCRIPT_DIR/installer_common.sh"
            quiver_confirm "Stop and remove hublink (keep configuration)?" N || { echo "Aborted."; exit 0; }
            systemctl stop "$SERVICE_NAME.service" 2>/dev/null || true
            systemctl disable "$SERVICE_NAME.service" 2>/dev/null || true
            rm -f "$SYSTEMD_DIR/$SERVICE_NAME.service"
            systemctl daemon-reload
            echo "Service removed. Configuration and scripts were retained; TELEMETRY_HUB_URL is unchanged."
            exit 0 ;;
        --help)
            echo "Usage: sudo bash install_hublink.sh [--no-start] [--keep-telemetry-push] [--uninstall]"
            echo "Installs hublink.service listening on STREAM_HOST:STREAM_PORT (default 0.0.0.0:8765)."
            echo "By default the telemetry forwarder is re-pointed at the local HubLink bridge"
            echo "(TELEMETRY_HUB_URL=http://127.0.0.1:STREAM_PORT) so telemetry is pulled by Hubs"
            echo "instead of pushed; --keep-telemetry-push leaves it pushing to WEB_SERVER_URL."
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $SCRIPT_DIR/install_hublink.sh" >&2
    exit 1
fi
for required in installer_common.sh installer_support.py companion_config.py companion-config.example requirements-companion.txt hublink_service.py; do
    [ -f "$SCRIPT_DIR/$required" ] || { echo "Missing $required. Download the complete current suite." >&2; exit 2; }
done
source "$SCRIPT_DIR/installer_common.sh"
printf '\nQuiver HubLink (pull-mode stream service) installer\n\n'
quiver_configure
quiver_prompt DRONE_ID "Drone ID"
quiver_prompt API_KEY "API key (Hubs must present it to subscribe)" secret
if [ -z "$(quiver_get API_KEY)" ]; then echo "API_KEY is required: without it any Hub could subscribe." >&2; exit 1; fi
quiver_prompt STREAM_HOST "HubLink bind address (0.0.0.0 = tailnet + drone subnet)"
quiver_prompt STREAM_PORT "HubLink port (the Hub's 'stream port')"
STREAM_PORT_VALUE=$(quiver_get STREAM_PORT)
case "$STREAM_PORT_VALUE" in ''|*[!0-9]*) echo "STREAM_PORT must be 1..65535" >&2; exit 2 ;; esac
[ "$STREAM_PORT_VALUE" -ge 1 ] && [ "$STREAM_PORT_VALUE" -le 65535 ] || { echo "STREAM_PORT must be 1..65535" >&2; exit 2; }
if [ "$REWIRE_TELEMETRY" = true ]; then
    # The forwarder keeps working unchanged: it just POSTs to the local bridge,
    # which fans the samples out to every subscribed Hub.
    quiver_set TELEMETRY_HUB_URL "http://127.0.0.1:$STREAM_PORT_VALUE"
    echo "Telemetry forwarder will post to the local HubLink bridge (TELEMETRY_HUB_URL=http://127.0.0.1:$STREAM_PORT_VALUE)."
else
    echo "Telemetry forwarder keeps pushing to WEB_SERVER_URL (--keep-telemetry-push)."
fi
quiver_validate_config
printf '\nInstall directory: %s\nShared configuration: %s\n' "$INSTALL_DIR" "$ENV_FILE"
echo "The Hub must be switched to pull mode for this drone (Drone Configuration -> Data Plane & Control),"
echo "with this Pi's tailnet MagicDNS name or drone-subnet address and port $STREAM_PORT_VALUE."
quiver_confirm "Proceed with installation?" Y || { echo "Aborted."; exit 0; }

apt-get update
apt-get install -y python3 python3-pip
python3 -m pip install --break-system-packages -r "$SCRIPT_DIR/requirements-companion.txt"
quiver_copy hublink_service.py
quiver_install_helpers
# Offline configuration check with the service account and interpreter settings.
runuser --user "$SERVICE_USER" -- /usr/bin/python3 -s "$INSTALL_DIR/installer_support.py" service-run "$ENV_FILE" /usr/bin/python3 -s "$INSTALL_DIR/hublink_service.py" --check

mkdir -p -- "$SYSTEMD_DIR"
UNIT_STAGING=$(mktemp -d)
trap 'rm -rf -- "$UNIT_STAGING"' EXIT
cat > "$UNIT_STAGING/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Quiver HubLink stream service (pull mode: Hubs subscribe to this drone)
Documentation=https://github.com/Pan-Robotics/Arrow-Quiver-Hub
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$(quiver_systemd_directory "$INSTALL_DIR")
EnvironmentFile=$(quiver_systemd_environment_file "$ENV_FILE")
Environment=$(quiver_systemd_path "QUIVER_ENV_FILE=$ENV_FILE")
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONNOUSERSITE=1
ExecStart=/usr/bin/python3 -s $(quiver_systemd_path "$INSTALL_DIR/hublink_service.py")
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hublink
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF
quiver_install_units "$UNIT_STAGING"
systemctl daemon-reload
if [ "$NO_START" = true ]; then
    printf '\nHubLink installed but not started (--no-start).\n'
else
    systemctl enable "$SERVICE_NAME.service"
    systemctl restart "$SERVICE_NAME.service"
    if [ "$REWIRE_TELEMETRY" = true ] && systemctl is-active --quiet telemetry-forwarder.service; then
        # Only the forwarder is restarted, and only because its Hub URL changed.
        systemctl restart telemetry-forwarder.service
        echo "Restarted telemetry-forwarder so it posts to the local HubLink bridge."
    fi
fi
printf '\nHubLink installed. Status and logs:\n  sudo systemctl status hublink\n  sudo journalctl -u hublink -f\n  curl -s http://127.0.0.1:%s/api/rest/health\n' "$STREAM_PORT_VALUE"
printf 'Switch the drone to pull mode on the Hub (Drone Configuration -> Data Plane & Control).\n'
