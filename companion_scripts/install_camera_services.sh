#!/usr/bin/env bash
# =============================================================================
# Quiver Hub Camera Services Installer
# =============================================================================
# Installs the SIYI camera controller, go2rtc, and a persistent Tailscale Funnel
# service for a Quiver companion computer. Configuration belongs in the shared
# .env file and is never sourced by this shell script.
#
# Run from a downloaded companion_scripts suite:
#   sudo bash /chosen/folder/install_camera_services.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=installer_common.sh
source "$SCRIPT_DIR/installer_common.sh"
SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

fail() {
    echo -e "${RED}Error: $*${NC}" >&2
    exit 1
}

require_value() {
    local key="$1" value
    value=$(quiver_get "$key")
    [ -n "$value" ] || fail "$key must be set in $ENV_FILE"
}

require_port() {
    local key="$1" value
    value=$(quiver_get "$key")
    case "$value" in
        ''|*[!0-9]*) fail "$key must be a numeric TCP/UDP port (got '$value')" ;;
    esac
    [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || fail "$key must be between 1 and 65535"
}

unit_path() {
    quiver_systemd_path "$1"
}

render_template() {
    # Render only fixed unit paths/users. Hub URLs and credentials remain runtime
    # environment variables, not generated unit-file content.
    local template="$1" destination="$2" temporary
    local install_dir_unit working_directory_unit env_file_unit env_assignment_unit service_user service_group
    local camera_stream_unit siyi_controller_unit hub_client_unit telemetry_unit logs_ota_unit

    install_dir_unit=$(unit_path "$INSTALL_DIR")
    working_directory_unit=$(quiver_systemd_directory "$INSTALL_DIR")
    env_file_unit=$(unit_path "$ENV_FILE")
    env_assignment_unit=$(unit_path "QUIVER_ENV_FILE=$ENV_FILE")
    service_user="$SERVICE_USER"
    service_group="$SERVICE_GROUP"
    camera_stream_unit=$(unit_path "$INSTALL_DIR/camera_stream_service.py")
    siyi_controller_unit=$(unit_path "$INSTALL_DIR/siyi_camera_controller.py")
    hub_client_unit=$(unit_path "$INSTALL_DIR/raspberry_pi_client.py")
    telemetry_unit=$(unit_path "$INSTALL_DIR/telemetry_forwarder.py")
    logs_ota_unit=$(unit_path "$INSTALL_DIR/logs_ota_service.py")
    temporary=$(mktemp)

    python3 - "$template" "$temporary" \
        "$install_dir_unit" "$working_directory_unit" "$env_file_unit" "$env_assignment_unit" "$service_user" "$service_group" \
        "$camera_stream_unit" "$siyi_controller_unit" "$hub_client_unit" \
        "$telemetry_unit" "$logs_ota_unit" <<'PY'
from pathlib import Path
import sys

(template, output, install_dir, working_directory, env_file, env_assignment, service_user, service_group,
 camera_stream, siyi_controller, hub_client, telemetry, logs_ota) = sys.argv[1:]
replacements = {
    "INSTALL_DIR_PLACEHOLDER": install_dir,
    "WORKING_DIRECTORY_PLACEHOLDER": working_directory,
    "ENV_FILE_PLACEHOLDER": env_file,
    "ENV_ASSIGNMENT_PLACEHOLDER": env_assignment,
    "SERVICE_USER_PLACEHOLDER": service_user,
    "SERVICE_GROUP_PLACEHOLDER": service_group,
    "CAMERA_STREAM_SCRIPT_PLACEHOLDER": camera_stream,
    "SIYI_CONTROLLER_SCRIPT_PLACEHOLDER": siyi_controller,
    "HUB_CLIENT_SCRIPT_PLACEHOLDER": hub_client,
    "TELEMETRY_FORWARDER_SCRIPT_PLACEHOLDER": telemetry,
    "LOGS_OTA_SCRIPT_PLACEHOLDER": logs_ota,
}
content = Path(template).read_text(encoding="utf-8")
for marker, value in replacements.items():
    content = content.replace(marker, value)
Path(output).write_text(content, encoding="utf-8")
PY

    quiver_privileged install -m 644 "$temporary" "$destination"
    rm -f "$temporary"
}

write_generated_units() {
    local install_dir_unit env_file_unit env_assignment_unit go2rtc_bin_unit go2rtc_config_unit config_helper_unit tailscale_bin_unit
    install_dir_unit=$(quiver_systemd_directory "$INSTALL_DIR")
    env_file_unit=$(unit_path "$ENV_FILE")
    env_assignment_unit=$(unit_path "QUIVER_ENV_FILE=$ENV_FILE")
    go2rtc_bin_unit=$(unit_path "$GO2RTC_BIN")
    go2rtc_config_unit=$(unit_path "$INSTALL_DIR/go2rtc.yaml")
    config_helper_unit=$(unit_path "$INSTALL_DIR/companion_config.py")
    tailscale_bin_unit=$(unit_path "$TAILSCALE_BIN")

    quiver_privileged mkdir -p "$SYSTEMD_DIR"

    # go2rtc.yaml is regenerated from the shared .env before each start. This
    # makes RTSP host/port/stream edits take effect after `restart go2rtc`.
    quiver_privileged tee "$SYSTEMD_DIR/go2rtc.service" >/dev/null <<EOF
[Unit]
Description=go2rtc WebRTC Streaming Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${install_dir_unit}
EnvironmentFile=${env_file_unit}
Environment=${env_assignment_unit}
Environment=PYTHONUNBUFFERED=1
ExecStartPre=/usr/bin/python3 ${config_helper_unit} render-go2rtc ${env_file_unit} ${go2rtc_config_unit}
ExecStart=${go2rtc_bin_unit} -config ${go2rtc_config_unit}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=go2rtc

[Install]
WantedBy=multi-user.target
EOF

    # The variables are expanded by systemd from EnvironmentFile at each start;
    # they are intentionally not pinned to installation-time values.
    quiver_privileged tee "$SYSTEMD_DIR/tailscale-funnel.service" >/dev/null <<EOF
[Unit]
Description=Tailscale Funnel for go2rtc WebRTC Signaling
After=network-online.target tailscaled.service go2rtc.service
Wants=network-online.target
Requires=tailscaled.service go2rtc.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=${env_file_unit}
Environment=${env_assignment_unit}
ExecStart=${tailscale_bin_unit} funnel --bg --https=\${TAILSCALE_FUNNEL_PORT} http://\${GO2RTC_API_HOST}:\${GO2RTC_API_PORT}
ExecStop=${tailscale_bin_unit} funnel --https=\${TAILSCALE_FUNNEL_PORT} off
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tailscale-funnel

[Install]
WantedBy=multi-user.target
EOF
}

configure_camera_environment() {
    local stream_type rtsp_url hub_url

    quiver_prompt HUB_URL "Quiver Hub URL"
    hub_url=$(quiver_get HUB_URL)
    # Older Hub/telemetry clients use WEB_SERVER_URL; keep it synchronized without
    # parsing or sourcing the environment file.
    quiver_set WEB_SERVER_URL "$hub_url"
    quiver_prompt DRONE_ID "Drone ID"
    quiver_prompt API_KEY "API key" secret
    quiver_prompt STREAM_TYPE "RTSP stream type (main=4K, sub=720p)"
    quiver_prompt GO2RTC_API_PORT "go2rtc API port"
    quiver_prompt GO2RTC_WEBRTC_PORT "go2rtc WebRTC UDP port"
    quiver_prompt TAILSCALE_FUNNEL_PORT "Tailscale Funnel HTTPS port (443, 8443, or 10000)"

    stream_type=$(quiver_get STREAM_TYPE)
    case "$stream_type" in
        main|sub) ;;
        *) fail "STREAM_TYPE must be 'main' or 'sub'" ;;
    esac
    require_value HUB_URL
    require_value DRONE_ID
    require_value API_KEY
    require_value SIYI_CAMERA_IP
    require_port SIYI_RTSP_PORT
    require_port GO2RTC_API_PORT
    require_port GO2RTC_WEBRTC_PORT
    require_port TAILSCALE_FUNNEL_PORT

    # RTSP_URL is an optional explicit override. Do not persist a derived URL:
    # companion_config derives it from SIYI_CAMERA_IP, SIYI_RTSP_PORT, and
    # STREAM_TYPE each time go2rtc is rendered, so endpoint edits apply after
    # a restart. An existing non-empty RTSP_URL deliberately remains an override.
    rtsp_url=$(quiver_get RTSP_URL)
    [ -n "$rtsp_url" ] || fail "RTSP_URL could not be derived; set SIYI_CAMERA_IP, SIYI_RTSP_PORT, and STREAM_TYPE"
}

install_dependencies() {
    echo -e "${GREEN}[1/5] Installing camera dependencies...${NC}"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-pip curl jq
    python3 -m pip install --break-system-packages requests 'python-socketio[asyncio_client]' aiohttp
}

install_go2rtc() {
    local arch go2rtc_url temporary
    echo -e "${GREEN}[2/5] Installing go2rtc in the selected companion folder...${NC}"
    case "$(uname -m)" in
        aarch64) arch="arm64" ;;
        armv7l) arch="arm" ;;
        x86_64) arch="amd64" ;;
        *) fail "Unsupported architecture: $(uname -m)" ;;
    esac

    GO2RTC_BIN="$INSTALL_DIR/bin/go2rtc"
    quiver_privileged mkdir -p "$INSTALL_DIR/bin"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/bin"
    go2rtc_url=$(curl -fsSL https://api.github.com/repos/AlexxIT/go2rtc/releases/latest \
        | jq -r ".assets[] | select(.name | test(\"go2rtc_linux_${arch}\")) | .browser_download_url" \
        | head -n 1)
    [ -n "$go2rtc_url" ] && [ "$go2rtc_url" != "null" ] || fail "Could not find a go2rtc release for $arch"

    temporary=$(mktemp)
    curl -fL "$go2rtc_url" -o "$temporary"
    quiver_privileged install -m 755 "$temporary" "$GO2RTC_BIN"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$GO2RTC_BIN"
    quiver_set GO2RTC_BINARY "$GO2RTC_BIN" GO2RTC_EXTERNAL true SKIP_FUNNEL_SETUP true
    rm -f "$temporary"
    echo "Installed go2rtc at $GO2RTC_BIN"
}

configure_tailscale() {
    local hostname funnel_port
    echo -e "${GREEN}[3/5] Checking Tailscale...${NC}"
    if command -v tailscale >/dev/null 2>&1; then
        tailscale version
    else
        echo -e "${YELLOW}Tailscale is not installed. Installing it using Tailscale's installer...${NC}"
        curl -fsSL https://tailscale.com/install.sh | sh
        echo -e "${CYAN}Authenticate this companion with: sudo tailscale up${NC}"
        read -r -p "Press Enter after authenticating Tailscale (Ctrl+C to abort)..." _
    fi

    if ! tailscale status >/dev/null 2>&1; then
        echo -e "${YELLOW}Tailscale is not connected. Running 'tailscale up'...${NC}"
        tailscale up
        read -r -p "Press Enter after authenticating Tailscale..." _
    fi

    TAILSCALE_BIN=$(command -v tailscale)
    hostname=$(tailscale status --json | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
    if [ -n "$hostname" ]; then
        quiver_set TAILSCALE_HOSTNAME "$hostname"
        funnel_port=$(quiver_get TAILSCALE_FUNNEL_PORT)
        echo "Tailscale Funnel will publish https://${hostname}${funnel_port:+:$funnel_port} (443 omits the port after install)."
    else
        echo -e "${YELLOW}Tailscale hostname is not available yet; camera services will retry when it becomes available.${NC}"
    fi
}

install_services() {
    echo -e "${GREEN}[4/5] Copying camera runtime and rendering systemd services...${NC}"
    # quiver_copy avoids same-file copies, so this also works when launched from
    # the already-installed companion suite.
    quiver_copy siyi_camera_controller.py
    quiver_copy camera_stream_service.py
    quiver_copy camera-stream.service
    quiver_copy siyi-camera.service
    quiver_install_helpers

    quiver_privileged mkdir -p "$SYSTEMD_DIR"
    render_template "$SCRIPT_DIR/camera-stream.service" "$SYSTEMD_DIR/camera-stream.service"
    render_template "$SCRIPT_DIR/siyi-camera.service" "$SYSTEMD_DIR/siyi-camera.service"
    write_generated_units

    # Verify that the config renderer can create the initial file before systemd
    # starts go2rtc. The same renderer is also the go2rtc ExecStartPre hook.
    quiver_privileged python3 "$INSTALL_DIR/companion_config.py" render-go2rtc \
        "$ENV_FILE" "$INSTALL_DIR/go2rtc.yaml"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/go2rtc.yaml"
}

start_services() {
    echo -e "${GREEN}[5/5] Enabling and starting services...${NC}"
    systemctl daemon-reload
    systemctl enable go2rtc.service tailscale-funnel.service siyi-camera.service camera-stream.service
    systemctl restart go2rtc.service
    systemctl restart tailscale-funnel.service
    systemctl restart siyi-camera.service
    systemctl restart camera-stream.service
}

main() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Quiver Hub Camera Services Installer${NC}"
    echo -e "${GREEN}========================================${NC}"

    if [ "${EUID}" -ne 0 ] && [ "${QUIVER_TEST_MODE:-}" != "1" ]; then
        fail "Run with sudo: sudo bash $SCRIPT_DIR/install_camera_services.sh"
    fi
    quiver_configure
    configure_camera_environment
    install_dependencies
    install_go2rtc
    configure_tailscale
    install_services
    start_services

    echo -e "${GREEN}Camera services are running.${NC}"
    echo "Shared configuration: $ENV_FILE"
    echo "RTSP source: $(quiver_get RTSP_URL)"
    echo
    echo "After editing $ENV_FILE, restart the affected service:"
    echo "  sudo systemctl restart go2rtc tailscale-funnel camera-stream siyi-camera"
    echo "Useful checks:"
    echo "  sudo systemctl status go2rtc tailscale-funnel siyi-camera camera-stream"
    echo "  sudo journalctl -u camera-stream -f"
}

main "$@"
