#!/bin/bash
# =============================================================================
# Logs & OTA Service Installation Script
# =============================================================================
# Installs the Quiver Hub Logs & OTA companion service on a Raspberry Pi.
#
# This service provides:
#   - FC log scanning and download via MAVFTP (MAVSDK)
#   - OTA firmware upload to FC via MAVFTP
#   - System diagnostics reporting (CPU, memory, disk, temp, services)
#   - Remote log streaming (journalctl → browser)
#   - Socket.IO real-time progress updates
#
# Prerequisites:
#   - Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
#   - Python 3.9+
#   - Flight controller connected via serial (TELEM) or Ethernet
#   - Internet connectivity to Quiver Hub
#
# Usage:
#   chmod +x install_logs_ota.sh
#   sudo ./install_logs_ota.sh
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Logs & OTA Service Installer${NC}"
echo -e "${GREEN}  MAVSDK + MAVFTP Edition${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

# Configuration defaults
INSTALL_DIR="/home/alexd/companion_scripts"
SERVICE_USER="alexd"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prompt for configuration
echo ""
echo -e "${YELLOW}Configuration:${NC}"
read -p "Install directory [$INSTALL_DIR]: " INPUT_DIR
INSTALL_DIR=${INPUT_DIR:-$INSTALL_DIR}

read -p "Service user [$SERVICE_USER]: " INPUT_USER
SERVICE_USER=${INPUT_USER:-$SERVICE_USER}

read -p "Quiver Hub URL [https://rplidar-viz-cjlhozxe.manus.space]: " HUB_URL
HUB_URL=${HUB_URL:-"https://rplidar-viz-cjlhozxe.manus.space"}

read -p "Drone ID [quiver_001]: " DRONE_ID
DRONE_ID=${DRONE_ID:-"quiver_001"}

read -p "API Key: " API_KEY
if [ -z "$API_KEY" ]; then
    echo -e "${RED}API key is required${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}Flight Controller Connection:${NC}"
echo "  1) Serial (TELEM port, e.g., /dev/ttyAMA1:921600)"
echo "  2) Ethernet/UDP (e.g., udp://:14540)"
echo "  3) No FC (diagnostics + log streaming only)"
read -p "Choose [1]: " FC_CHOICE
FC_CHOICE=${FC_CHOICE:-1}

case "$FC_CHOICE" in
    1)
        read -p "Serial device [/dev/ttyAMA1]: " SERIAL_DEV
        SERIAL_DEV=${SERIAL_DEV:-"/dev/ttyAMA1"}
        read -p "Baud rate [921600]: " BAUD_RATE
        BAUD_RATE=${BAUD_RATE:-"921600"}
        FC_CONNECTION="serial://${SERIAL_DEV}:${BAUD_RATE}"
        NO_FC_FLAG=""
        ;;
    2)
        read -p "UDP address [udp://:14540]: " UDP_ADDR
        UDP_ADDR=${UDP_ADDR:-"udp://:14540"}
        FC_CONNECTION="$UDP_ADDR"
        NO_FC_FLAG=""
        ;;
    3)
        FC_CONNECTION=""
        NO_FC_FLAG="--no-fc"
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${CYAN}Summary:${NC}"
echo "  Install dir:    $INSTALL_DIR"
echo "  Service user:   $SERVICE_USER"
echo "  Hub URL:        $HUB_URL"
echo "  Drone ID:       $DRONE_ID"
echo "  FC connection:  ${FC_CONNECTION:-'None (diagnostics only)'}"
echo ""
read -p "Continue? [Y/n]: " CONFIRM
CONFIRM=${CONFIRM:-Y}
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
fi

# ── Step 1: Install Python dependencies ──────────────────────────────────
echo ""
echo -e "${GREEN}[1/4] Installing Python dependencies...${NC}"

pip3 install --break-system-packages \
    mavsdk \
    requests \
    psutil \
    'python-socketio[asyncio_client]' \
    aiohttp

echo -e "${GREEN}  ✓ Python dependencies installed${NC}"

# ── Step 2: Copy script to install directory ─────────────────────────────
echo ""
echo -e "${GREEN}[2/4] Copying service script...${NC}"

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/logs_ota_service.py" "$INSTALL_DIR/logs_ota_service.py"
chmod +x "$INSTALL_DIR/logs_ota_service.py"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/logs_ota_service.py"

echo -e "${GREEN}  ✓ Script copied to $INSTALL_DIR/logs_ota_service.py${NC}"

# ── Step 3: Create systemd service ───────────────────────────────────────
echo ""
echo -e "${GREEN}[3/4] Creating systemd service...${NC}"

# Build ExecStart command
EXEC_CMD="/usr/bin/python3 ${INSTALL_DIR}/logs_ota_service.py"
EXEC_CMD+=" --hub-url ${HUB_URL}"
EXEC_CMD+=" --drone-id ${DRONE_ID}"
EXEC_CMD+=" --api-key ${API_KEY}"

if [ -n "$FC_CONNECTION" ]; then
    EXEC_CMD+=" --fc-connection ${FC_CONNECTION}"
fi

if [ -n "$NO_FC_FLAG" ]; then
    EXEC_CMD+=" ${NO_FC_FLAG}"
fi

EXEC_CMD+=" --poll-interval 5"
EXEC_CMD+=" --diagnostics-interval 10"

cat > /etc/systemd/system/logs-ota.service << EOF
[Unit]
Description=Quiver Hub – Logs & OTA Service
Documentation=https://github.com/Pan-Robotics/Feather-Companion-Computer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=/home/${SERVICE_USER}
ExecStart=${EXEC_CMD}
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=logs-ota

# Environment
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}  ✓ Service file created at /etc/systemd/system/logs-ota.service${NC}"

# ── Step 4: Enable and start service ─────────────────────────────────────
echo ""
echo -e "${GREEN}[4/4] Enabling and starting service...${NC}"

systemctl daemon-reload
systemctl enable logs-ota.service
systemctl start logs-ota.service

echo -e "${GREEN}  ✓ Service enabled and started${NC}"

# ── Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Useful commands:${NC}"
echo "  sudo systemctl status logs-ota      # Check service status"
echo "  sudo journalctl -u logs-ota -f      # View live logs"
echo "  sudo systemctl restart logs-ota     # Restart service"
echo "  sudo systemctl stop logs-ota        # Stop service"
echo ""
echo -e "${CYAN}The service will:${NC}"
echo "  • Poll Hub for log download and firmware flash jobs every 5s"
echo "  • Report system diagnostics every 10s"
echo "  • Stream journalctl logs to browser on demand"
if [ -n "$FC_CONNECTION" ]; then
    echo "  • Connect to FC at: $FC_CONNECTION"
else
    echo "  • Running without FC (diagnostics + log streaming only)"
fi
echo ""
