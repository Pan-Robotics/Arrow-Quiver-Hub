#!/bin/bash
# =============================================================================
# Logs & OTA Service Installation Script
# =============================================================================
# Installs the Quiver Hub Logs & OTA companion service on a Raspberry Pi.
#
# This service provides:
#   - FC log sync via ArduPilot net_webserver HTTP (fast, no MAVLink blocking)
#   - FC log download from local cache → Hub S3 → user's browser
#   - OTA firmware upload to FC via MAVFTP with SHA-256 integrity verification
#   - System diagnostics reporting (CPU, memory, disk, temp, services)
#   - Remote log streaming (journalctl → browser)
#   - Socket.IO real-time progress updates
#   - Mutex-locked job acknowledgement to prevent double-execution
#
# Prerequisites:
#   - Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
#   - Python 3.9+
#   - Flight controller connected via serial (TELEM) or Ethernet
#   - ArduPilot net_webserver.lua running on FC (for HTTP log download)
#   - Internet connectivity to Quiver Hub
#
# Usage:
#   chmod +x install_logs_ota.sh
#   sudo ./install_logs_ota.sh
#
# Uninstall:
#   sudo ./install_logs_ota.sh --uninstall
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

SERVICE_NAME="logs-ota"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Uninstall mode ──────────────────────────────────────────────────────────
if [ "$1" = "--uninstall" ]; then
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}Uninstalling Logs & OTA Service${NC}"
    echo -e "${RED}========================================${NC}"

    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}Please run as root (sudo)${NC}"
        exit 1
    fi

    echo ""
    read -p "This will stop and remove the logs-ota service. Continue? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
        echo "Aborted."
        exit 0
    fi

    systemctl stop ${SERVICE_NAME} 2>/dev/null || true
    systemctl disable ${SERVICE_NAME} 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload

    echo -e "${GREEN}  ✓ Service stopped, disabled, and removed${NC}"
    echo -e "${DIM}  Note: Python packages and log store directory were not removed.${NC}"
    echo -e "${DIM}  To remove cached logs: sudo rm -rf /var/lib/quiver/fc_logs${NC}"
    exit 0
fi

# ── Main install ────────────────────────────────────────────────────────────
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Quiver Hub – Logs & OTA Installer${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    echo -e "${DIM}  Usage: sudo ./install_logs_ota.sh${NC}"
    exit 1
fi

# Detect if this is an upgrade (service already exists)
IS_UPGRADE=false
if [ -f "$SERVICE_FILE" ]; then
    IS_UPGRADE=true
    echo -e "${YELLOW}Existing installation detected. This will upgrade in place.${NC}"
    echo ""
fi

# ── Configuration defaults ──────────────────────────────────────────────────
DEFAULT_INSTALL_DIR="/home/$(logname 2>/dev/null || echo 'pi')/companion_scripts"
DEFAULT_SERVICE_USER="$(logname 2>/dev/null || echo 'pi')"
DEFAULT_HUB_URL="https://rplidar-viz-cjlhozxe.manus.space"
DEFAULT_DRONE_ID="quiver_001"
DEFAULT_FC_WEBSERVER_URL="http://192.168.144.10:8080"
DEFAULT_LOG_STORE_DIR="/var/lib/quiver/fc_logs"
DEFAULT_POLL_INTERVAL=5
DEFAULT_DIAG_INTERVAL=10

# ── Section 1: Basic Configuration ──────────────────────────────────────────
echo -e "${BOLD}${CYAN}─── Basic Configuration ───${NC}"
echo ""

read -p "  Install directory [${DEFAULT_INSTALL_DIR}]: " INSTALL_DIR
INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}

read -p "  Service user [${DEFAULT_SERVICE_USER}]: " SERVICE_USER
SERVICE_USER=${SERVICE_USER:-$DEFAULT_SERVICE_USER}

# Validate user exists
if ! id "$SERVICE_USER" &>/dev/null; then
    echo -e "${RED}  Error: User '$SERVICE_USER' does not exist${NC}"
    exit 1
fi

echo ""

# ── Section 2: Hub Connection ───────────────────────────────────────────────
echo -e "${BOLD}${CYAN}─── Hub Connection ───${NC}"
echo ""

read -p "  Quiver Hub URL [${DEFAULT_HUB_URL}]: " HUB_URL
HUB_URL=${HUB_URL:-$DEFAULT_HUB_URL}
# Strip trailing slash
HUB_URL="${HUB_URL%/}"

read -p "  Drone ID [${DEFAULT_DRONE_ID}]: " DRONE_ID
DRONE_ID=${DRONE_ID:-$DEFAULT_DRONE_ID}

read -sp "  API Key (hidden): " API_KEY
echo ""
if [ -z "$API_KEY" ]; then
    echo -e "${RED}  Error: API key is required${NC}"
    echo -e "${DIM}  Generate one from Quiver Hub → Settings → API Keys${NC}"
    exit 1
fi

echo ""

# ── Section 3: Flight Controller Connection ─────────────────────────────────
echo -e "${BOLD}${CYAN}─── Flight Controller Connection ───${NC}"
echo ""
echo -e "  ${DIM}How is the FC connected to this companion computer?${NC}"
echo ""
echo "    1) Serial (TELEM port, e.g., /dev/ttyAMA1:921600)"
echo "    2) Ethernet/TCP (e.g., tcp://192.168.144.10:5760)"
echo "    3) Ethernet/UDP (e.g., udp://:14540)"
echo "    4) No FC (diagnostics + log streaming only)"
echo ""
read -p "  Choose [1]: " FC_CHOICE
FC_CHOICE=${FC_CHOICE:-1}

NO_FC_FLAG=""
FC_CONNECTION=""

case "$FC_CHOICE" in
    1)
        read -p "  Serial device [/dev/ttyAMA1]: " SERIAL_DEV
        SERIAL_DEV=${SERIAL_DEV:-"/dev/ttyAMA1"}
        read -p "  Baud rate [921600]: " BAUD_RATE
        BAUD_RATE=${BAUD_RATE:-"921600"}
        FC_CONNECTION="serial://${SERIAL_DEV}:${BAUD_RATE}"
        ;;
    2)
        read -p "  TCP address [tcp://192.168.144.10:5760]: " TCP_ADDR
        TCP_ADDR=${TCP_ADDR:-"tcp://192.168.144.10:5760"}
        FC_CONNECTION="$TCP_ADDR"
        ;;
    3)
        read -p "  UDP address [udp://:14540]: " UDP_ADDR
        UDP_ADDR=${UDP_ADDR:-"udp://:14540"}
        FC_CONNECTION="$UDP_ADDR"
        ;;
    4)
        NO_FC_FLAG="--no-fc"
        ;;
    *)
        echo -e "${RED}  Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""

# ── Section 4: FC Log Download (ArduPilot net_webserver) ────────────────────
echo -e "${BOLD}${CYAN}─── FC Log Download (ArduPilot net_webserver) ───${NC}"
echo ""
echo -e "  ${DIM}The FC runs a Lua webserver (net_webserver.lua) that serves log files${NC}"
echo -e "  ${DIM}over HTTP. This avoids blocking MAVLink/TCP during log downloads.${NC}"
echo ""

if [ "$FC_CHOICE" = "4" ]; then
    echo -e "  ${YELLOW}Skipped (no FC connection)${NC}"
    FC_WEBSERVER_URL=""
    LOG_STORE_DIR=""
else
    read -p "  FC webserver URL [${DEFAULT_FC_WEBSERVER_URL}]: " FC_WEBSERVER_URL
    FC_WEBSERVER_URL=${FC_WEBSERVER_URL:-$DEFAULT_FC_WEBSERVER_URL}
    # Strip trailing slash
    FC_WEBSERVER_URL="${FC_WEBSERVER_URL%/}"

    read -p "  Local log cache directory [${DEFAULT_LOG_STORE_DIR}]: " LOG_STORE_DIR
    LOG_STORE_DIR=${LOG_STORE_DIR:-$DEFAULT_LOG_STORE_DIR}
fi

echo ""

# ── Section 5: Tuning ──────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}─── Tuning (press Enter for defaults) ───${NC}"
echo ""

read -p "  Job poll interval in seconds [${DEFAULT_POLL_INTERVAL}]: " POLL_INTERVAL
POLL_INTERVAL=${POLL_INTERVAL:-$DEFAULT_POLL_INTERVAL}

read -p "  Diagnostics report interval in seconds [${DEFAULT_DIAG_INTERVAL}]: " DIAG_INTERVAL
DIAG_INTERVAL=${DIAG_INTERVAL:-$DEFAULT_DIAG_INTERVAL}

echo ""

# ── Section 6: Permissions ──────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}─── Service Permissions ───${NC}"
echo ""
echo -e "  ${DIM}The service needs elevated permissions for:${NC}"
echo -e "  ${DIM}  • journalctl log streaming${NC}"
echo -e "  ${DIM}  • systemctl service status queries${NC}"
echo -e "  ${DIM}  • Serial port access (if applicable)${NC}"
echo -e "  ${DIM}  • Writing to log cache directory${NC}"
echo ""
echo "    1) Run as root (recommended for full functionality)"
echo "    2) Run as service user with group permissions"
echo ""
read -p "  Choose [1]: " PERM_CHOICE
PERM_CHOICE=${PERM_CHOICE:-1}

RUN_AS_ROOT=true
if [ "$PERM_CHOICE" = "2" ]; then
    RUN_AS_ROOT=false
    # Add user to required groups
    usermod -aG dialout "$SERVICE_USER" 2>/dev/null || true
    usermod -aG systemd-journal "$SERVICE_USER" 2>/dev/null || true
    echo -e "  ${GREEN}✓ Added $SERVICE_USER to dialout and systemd-journal groups${NC}"
    echo -e "  ${YELLOW}Note: Group changes take effect after next login or reboot${NC}"
fi

echo ""

# ── Summary ─────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}─── Installation Summary ───${NC}"
echo ""
echo -e "  Install dir:       ${BOLD}$INSTALL_DIR${NC}"
echo -e "  Service user:      ${BOLD}$SERVICE_USER${NC}"
echo -e "  Run as:            ${BOLD}$([ "$RUN_AS_ROOT" = "true" ] && echo "root" || echo "$SERVICE_USER")${NC}"
echo -e "  Hub URL:           ${BOLD}$HUB_URL${NC}"
echo -e "  Drone ID:          ${BOLD}$DRONE_ID${NC}"
echo -e "  API Key:           ${BOLD}${API_KEY:0:8}...${NC}"
if [ -n "$FC_CONNECTION" ]; then
    echo -e "  FC connection:     ${BOLD}$FC_CONNECTION${NC}"
else
    echo -e "  FC connection:     ${BOLD}None (diagnostics only)${NC}"
fi
if [ -n "$FC_WEBSERVER_URL" ]; then
    echo -e "  FC webserver:      ${BOLD}$FC_WEBSERVER_URL${NC}"
    echo -e "  Log cache dir:     ${BOLD}$LOG_STORE_DIR${NC}"
fi
echo -e "  Poll interval:     ${BOLD}${POLL_INTERVAL}s${NC}"
echo -e "  Diag interval:     ${BOLD}${DIAG_INTERVAL}s${NC}"
echo ""

read -p "  Proceed with installation? [Y/n]: " CONFIRM
CONFIRM=${CONFIRM:-Y}
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "  Aborted."
    exit 0
fi

echo ""

# ── Step 1: Install Python dependencies ─────────────────────────────────────
echo -e "${GREEN}[1/5] Installing Python dependencies...${NC}"

pip3 install --break-system-packages \
    mavsdk \
    requests \
    psutil \
    'python-socketio[asyncio_client]' \
    aiohttp 2>&1 | tail -1

echo -e "${GREEN}  ✓ Python dependencies installed${NC}"
echo ""

# ── Step 2: Copy script to install directory ────────────────────────────────
echo -e "${GREEN}[2/5] Copying service script...${NC}"

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/logs_ota_service.py" "$INSTALL_DIR/logs_ota_service.py"
chmod +x "$INSTALL_DIR/logs_ota_service.py"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/logs_ota_service.py"

echo -e "${GREEN}  ✓ Script copied to $INSTALL_DIR/logs_ota_service.py${NC}"
echo ""

# ── Step 3: Create log cache directory ──────────────────────────────────────
echo -e "${GREEN}[3/5] Setting up log cache directory...${NC}"

if [ -n "$LOG_STORE_DIR" ]; then
    mkdir -p "$LOG_STORE_DIR"
    if [ "$RUN_AS_ROOT" = "false" ]; then
        chown "$SERVICE_USER:$SERVICE_USER" "$LOG_STORE_DIR"
    fi
    echo -e "${GREEN}  ✓ Log cache directory created at $LOG_STORE_DIR${NC}"
else
    echo -e "${DIM}  Skipped (no FC connection)${NC}"
fi
echo ""

# ── Step 4: Create systemd service ──────────────────────────────────────────
echo -e "${GREEN}[4/5] Creating systemd service...${NC}"

# Build ExecStart command
EXEC_CMD="/usr/bin/python3 ${INSTALL_DIR}/logs_ota_service.py"
EXEC_CMD+=" \\\\\n    --hub-url ${HUB_URL}"
EXEC_CMD+=" \\\\\n    --drone-id ${DRONE_ID}"
EXEC_CMD+=" \\\\\n    --api-key ${API_KEY}"

if [ -n "$FC_CONNECTION" ]; then
    EXEC_CMD+=" \\\\\n    --fc-connection ${FC_CONNECTION}"
fi

if [ -n "$NO_FC_FLAG" ]; then
    EXEC_CMD+=" \\\\\n    ${NO_FC_FLAG}"
fi

if [ -n "$FC_WEBSERVER_URL" ]; then
    EXEC_CMD+=" \\\\\n    --fc-webserver-url ${FC_WEBSERVER_URL}"
fi

if [ -n "$LOG_STORE_DIR" ]; then
    EXEC_CMD+=" \\\\\n    --log-store-dir ${LOG_STORE_DIR}"
fi

EXEC_CMD+=" \\\\\n    --poll-interval ${POLL_INTERVAL}"
EXEC_CMD+=" \\\\\n    --diagnostics-interval ${DIAG_INTERVAL}"

if [ "$RUN_AS_ROOT" = "false" ]; then
    EXEC_CMD+=" \\\\\n    --allow-non-root"
fi

# Build ReadWritePaths
RW_PATHS="/tmp /home/${SERVICE_USER}"
if [ -n "$LOG_STORE_DIR" ]; then
    RW_PATHS+=" ${LOG_STORE_DIR}"
fi

# Write the service file
cat > "$SERVICE_FILE" << SERVICEEOF
[Unit]
Description=Quiver Hub – Logs & OTA Service
Documentation=https://github.com/Pan-Robotics/Feather-Companion-Computer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$(if [ "$RUN_AS_ROOT" = "false" ]; then echo "User=${SERVICE_USER}"; echo "Group=${SERVICE_USER}"; fi)
WorkingDirectory=/home/${SERVICE_USER}
ExecStart=$(echo -e "$EXEC_CMD")
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=logs-ota

# Environment
Environment=PYTHONUNBUFFERED=1

# Security hardening
ProtectSystem=strict
ReadWritePaths=${RW_PATHS}
PrivateTmp=true
NoNewPrivileges=$([ "$RUN_AS_ROOT" = "true" ] && echo "false" || echo "true")

[Install]
WantedBy=multi-user.target
SERVICEEOF

echo -e "${GREEN}  ✓ Service file created at $SERVICE_FILE${NC}"
echo ""

# ── Step 5: Enable and start service ────────────────────────────────────────
echo -e "${GREEN}[5/5] Enabling and starting service...${NC}"

# Stop existing service if upgrading
if [ "$IS_UPGRADE" = "true" ]; then
    systemctl stop ${SERVICE_NAME} 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
systemctl start ${SERVICE_NAME}.service

# Wait a moment and check status
sleep 2
if systemctl is-active --quiet ${SERVICE_NAME}; then
    echo -e "${GREEN}  ✓ Service is running${NC}"
else
    echo -e "${YELLOW}  ⚠ Service may have failed to start. Check logs:${NC}"
    echo -e "${DIM}    sudo journalctl -u ${SERVICE_NAME} -n 20 --no-pager${NC}"
fi

echo ""

# ── Done ────────────────────────────────────────────────────────────────────
echo -e "${GREEN}========================================${NC}"
if [ "$IS_UPGRADE" = "true" ]; then
    echo -e "${GREEN}  Upgrade complete!${NC}"
else
    echo -e "${GREEN}  Installation complete!${NC}"
fi
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BOLD}Useful commands:${NC}"
echo -e "  ${CYAN}sudo systemctl status ${SERVICE_NAME}${NC}      Check service status"
echo -e "  ${CYAN}sudo journalctl -u ${SERVICE_NAME} -f${NC}      View live logs"
echo -e "  ${CYAN}sudo systemctl restart ${SERVICE_NAME}${NC}     Restart service"
echo -e "  ${CYAN}sudo systemctl stop ${SERVICE_NAME}${NC}        Stop service"
echo -e "  ${CYAN}sudo ./install_logs_ota.sh --uninstall${NC}  Remove service"
echo ""
echo -e "${BOLD}The service will:${NC}"
echo -e "  • Poll Hub for jobs every ${POLL_INTERVAL}s (scan, download, flash)"
echo -e "  • Report system diagnostics every ${DIAG_INTERVAL}s"
echo -e "  • Stream journalctl logs to browser on demand"
if [ -n "$FC_CONNECTION" ]; then
    echo -e "  • Connect to FC at: ${FC_CONNECTION}"
fi
if [ -n "$FC_WEBSERVER_URL" ]; then
    echo -e "  • Sync FC logs via HTTP from: ${FC_WEBSERVER_URL}"
    echo -e "  • Cache logs locally at: ${LOG_STORE_DIR}"
fi
if [ -z "$FC_CONNECTION" ] && [ -z "$FC_WEBSERVER_URL" ]; then
    echo -e "  • Running without FC (diagnostics + log streaming only)"
fi
echo ""
