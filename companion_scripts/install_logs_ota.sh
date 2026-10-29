#!/usr/bin/env bash
# Logs, diagnostics, and Approach C OTA: the FC pulls firmware from the Pi.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICE_NAME=logs-ota
SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}
SERVICE_FILE="$SYSTEMD_DIR/logs-ota.service"
if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $SCRIPT_DIR/install_logs_ota.sh" >&2
    exit 1
fi
if [ "${1:-}" = --uninstall ]; then
    read -r -p "Stop and remove logs-ota (keep configuration and cached logs)? [y/N]: " CONFIRM
    case "$CONFIRM" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    echo "Service removed. Configuration, scripts, and cached logs were retained."
    exit 0
fi
source "$SCRIPT_DIR/installer_common.sh"
printf '\nQuiver Logs & OTA installer\n\n'
quiver_configure
quiver_prompt WEB_SERVER_URL "Quiver Hub URL"
quiver_prompt DRONE_ID "Drone ID"
quiver_prompt API_KEY "API key" secret
if [ -z "$(quiver_get API_KEY)" ]; then echo "API_KEY is required." >&2; exit 1; fi

printf '\nFC connection (blank keeps the existing FC_CONNECTION):\n'
printf '  1) Serial (TELEM)\n  2) Ethernet/TCP\n  3) Ethernet/UDP\n  4) No FC (diagnostics only)\n'
read -r -p "Choose [keep existing]: " FC_CHOICE
case "$FC_CHOICE" in
    1)
        read -r -p "Serial device [/dev/ttyAMA1]: " SERIAL_DEV
        read -r -p "Baud rate [921600]: " BAUD_RATE
        quiver_set FC_CONNECTION "serial://${SERIAL_DEV:-/dev/ttyAMA1}:${BAUD_RATE:-921600}" NO_FC false
        ;;
    2)
        quiver_prompt FC_IP "Flight controller IP"
        quiver_prompt FC_MAVLINK_TCP_PORT "FC MAVLink TCP port"
        # Do not pin the IP into FC_CONNECTION: derive it from FC_IP on startup.
        quiver_set FC_CONNECTION tcp NO_FC false
        ;;
    3)
        quiver_prompt MAVLINK_BIND_IP "MAVLink UDP listen address"
        quiver_prompt MAVLINK_UDP_PORT "MAVLink UDP port"
        quiver_set FC_CONNECTION udp NO_FC false
        ;;
    4) quiver_set NO_FC true ;;
    '') ;;
    *) echo "Invalid FC connection choice." >&2; exit 1 ;;
esac
if [ "$(quiver_get NO_FC)" != true ]; then
    quiver_prompt FC_IP "FC HTTP server IP"
    quiver_prompt FC_WEBSERVER_PORT "FC HTTP server port"
    echo "Resolved HTTP endpoint: $(quiver_get FC_WEBSERVER_URL)"
    echo "If needed, set FC_WEBSERVER_URL in .env to explicitly override this endpoint."
    quiver_prompt LOG_STORE_DIR "Local FC log cache directory"
fi
quiver_prompt FIRMWARE_SERVER_PORT "Pi firmware HTTP port (match FC FWPULL_PORT)"
quiver_prompt POLL_INTERVAL "Job poll interval (seconds)"
quiver_prompt DIAGNOSTICS_INTERVAL "Diagnostics interval (seconds)"
read -r -p "Run logs-ota as root for full diagnostics/journal access? [Y/n]: " ROOT_CHOICE
case "${ROOT_CHOICE:-Y}" in y|Y|yes|YES) RUN_AS_ROOT=true; quiver_set ALLOW_NON_ROOT false ;;
    *) RUN_AS_ROOT=false; quiver_set ALLOW_NON_ROOT true ;;
esac
printf '\nInstall directory: %s\nShared configuration: %s\n' "$INSTALL_DIR" "$ENV_FILE"
printf 'FC endpoint: %s\n' "$(quiver_get FC_WEBSERVER_URL)"
read -r -p "Proceed with installation? [Y/n]: " CONFIRM
case "${CONFIRM:-Y}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac

apt-get update
apt-get install -y python3 python3-pip
# pipefail is enabled: a dependency failure must not appear to succeed.
python3 -m pip install --break-system-packages mavsdk requests psutil 'python-socketio[asyncio_client]' aiohttp
quiver_copy logs_ota_service.py
quiver_copy firmware_puller.lua
quiver_copy net_webserver_put.lua
quiver_install_helpers
python3 "$INSTALL_DIR/companion_config.py" render-fc-params "$ENV_FILE" "$INSTALL_DIR/firmware_puller.param"
chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/firmware_puller.param"
LOG_STORE_DIR=$(quiver_get LOG_STORE_DIR)
mkdir -p -- "$LOG_STORE_DIR"
chown "$SERVICE_USER:$SERVICE_GROUP" "$LOG_STORE_DIR"
if [ "$RUN_AS_ROOT" = false ]; then
    usermod -aG dialout "$SERVICE_USER"
    usermod -aG systemd-journal "$SERVICE_USER"
fi

mkdir -p -- "$SYSTEMD_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Quiver Hub Logs & OTA Service
Documentation=https://github.com/Pan-Robotics/Arrow-Quiver-Hub
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
$(if [ "$RUN_AS_ROOT" = false ]; then printf 'User=%s\nGroup=%s\n' "$SERVICE_USER" "$SERVICE_GROUP"; fi)
WorkingDirectory=$(quiver_systemd_path "$INSTALL_DIR")
EnvironmentFile=$(quiver_systemd_path "$ENV_FILE")
Environment=$(quiver_systemd_path "QUIVER_ENV_FILE=$ENV_FILE")
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $(quiver_systemd_path "$INSTALL_DIR/logs_ota_service.py")
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=logs-ota
ProtectSystem=strict
ReadWritePaths=$(quiver_systemd_path "$INSTALL_DIR") $(quiver_systemd_path "$LOG_STORE_DIR") /tmp
PrivateTmp=true
NoNewPrivileges=$([ "$RUN_AS_ROOT" = true ] && echo false || echo true)

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"
printf '\nLogs & OTA installed. Restart after editing %s:\n' "$ENV_FILE"
printf '  sudo systemctl restart logs-ota\n  sudo journalctl -u logs-ota -f\n'
printf 'Changing LOG_STORE_DIR also requires rerunning this installer to update ReadWritePaths.\n'
printf 'FC Lua parameters must match COMPANION_IP/FIRMWARE_SERVER_PORT. See OTA_Setup_Guide.md.\n'
