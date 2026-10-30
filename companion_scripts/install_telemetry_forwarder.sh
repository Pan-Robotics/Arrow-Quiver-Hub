#!/usr/bin/env bash
# Install MAVLink + optional DroneCAN telemetry. Run the hub installer first.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}
if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $SCRIPT_DIR/install_telemetry_forwarder.sh" >&2
    exit 1
fi
source "$SCRIPT_DIR/installer_common.sh"
printf '\nQuiver Telemetry Forwarder installer\n\n'
quiver_configure
quiver_prompt WEB_SERVER_URL "Quiver Hub URL"
quiver_prompt DRONE_ID "Drone ID"
quiver_prompt API_KEY "API key" secret
if [ -z "$(quiver_get API_KEY)" ]; then echo "API_KEY is required." >&2; exit 1; fi
quiver_prompt MAVLINK_URL "MAVLink connection URL"
quiver_prompt ENABLE_UAVCAN "Enable DroneCAN battery monitoring (true/false)"
quiver_prompt CAN_INTERFACE "CAN interface"
quiver_prompt UPDATE_RATE_HZ "Telemetry rate (Hz)"
quiver_validate_config
printf '\nConfiguration: %s\nService user: %s\nInstall directory: %s\n' "$ENV_FILE" "$SERVICE_USER" "$INSTALL_DIR"
read -r -p "Proceed with installation? [Y/n]: " CONFIRM
case "${CONFIRM:-Y}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac

apt-get update
apt-get install -y python3 python3-pip
python3 -m pip install --break-system-packages -r "$SCRIPT_DIR/requirements-companion.txt"
python3 "$SCRIPT_DIR/installer_support.py" sdk-preflight
quiver_copy telemetry_forwarder.py
quiver_install_helpers

mkdir -p -- "$SYSTEMD_DIR"
UNIT_STAGING=$(mktemp -d)
trap 'rm -rf -- "$UNIT_STAGING"' EXIT
cat > "$UNIT_STAGING/telemetry-forwarder.service" <<EOF
[Unit]
Description=Quiver Hub Telemetry Forwarder
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
ExecStart=/usr/bin/python3 $(quiver_systemd_path "$INSTALL_DIR/telemetry_forwarder.py")
Restart=always
RestartSec=5
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telemetry-forwarder
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$(quiver_systemd_path "$INSTALL_DIR")

[Install]
WantedBy=multi-user.target
EOF
quiver_install_units "$UNIT_STAGING"
systemctl daemon-reload
systemctl enable telemetry-forwarder.service
systemctl restart telemetry-forwarder.service
printf '\nTelemetry installed. Settings are read from %s at each start.\n' "$ENV_FILE"
printf 'After editing it: sudo systemctl restart telemetry-forwarder\n'
printf 'Logs: sudo journalctl -u telemetry-forwarder -f\n'
