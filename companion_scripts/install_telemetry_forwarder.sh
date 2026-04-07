#!/bin/bash
# =============================================================================
# Telemetry Forwarder Installation Script
# =============================================================================
# Installs the Quiver Hub Telemetry Forwarder on a Raspberry Pi.
#
# This service provides:
#   - MAVLink telemetry collection via MAVSDK (attitude, position, GPS, battery)
#   - UAVCAN battery data collection via DroneCAN (voltage, current, SoC, SoH)
#   - HTTP POST forwarding to Quiver Hub REST endpoint
#   - Multi-threaded architecture (MAVLink, UAVCAN, HTTP workers)
#
# Prerequisites:
#   - Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
#   - Python 3.9+
#   - Flight controller connected via UDP (MAVLink)
#   - CAN interface configured for UAVCAN (optional)
#   - Internet connectivity to Quiver Hub
#   - forwarder.env file with WEB_SERVER_URL and API_KEY
#
# Usage:
#   chmod +x install_telemetry_forwarder.sh
#   sudo ./install_telemetry_forwarder.sh
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Telemetry Forwarder Installer${NC}"
echo -e "${GREEN}  MAVLink + UAVCAN → Quiver Hub${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

# Configuration defaults
INSTALL_DIR="/home/alexd/quiver"
SERVICE_USER="alexd"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prompt for configuration
echo ""
echo -e "${YELLOW}Configuration:${NC}"
read -p "Install directory [$INSTALL_DIR]: " INPUT_DIR
INSTALL_DIR=${INPUT_DIR:-$INSTALL_DIR}

read -p "Service user [$SERVICE_USER]: " INPUT_USER
SERVICE_USER=${INPUT_USER:-$SERVICE_USER}

# Check if forwarder.env exists
ENV_FILE="${INSTALL_DIR}/forwarder.env"
if [ -f "$ENV_FILE" ]; then
    echo -e "${GREEN}  ✓ Found existing forwarder.env at $ENV_FILE${NC}"
    echo -e "${CYAN}  The service will use WEB_SERVER_URL, API_KEY, DRONE_ID from this file.${NC}"
else
    echo -e "${YELLOW}  ⚠ No forwarder.env found at $ENV_FILE${NC}"
    echo -e "${YELLOW}  You will need to create it before starting the service.${NC}"
    echo ""
    read -p "Create forwarder.env now? [Y/n]: " CREATE_ENV
    CREATE_ENV=${CREATE_ENV:-Y}
    if [[ "$CREATE_ENV" =~ ^[Yy] ]]; then
        read -p "Quiver Hub URL [https://rplidar-viz-cjlhozxe.manus.space]: " HUB_URL
        HUB_URL=${HUB_URL:-"https://rplidar-viz-cjlhozxe.manus.space"}

        read -p "Drone ID [quiver_001]: " DRONE_ID
        DRONE_ID=${DRONE_ID:-"quiver_001"}

        read -p "API Key: " API_KEY
        if [ -z "$API_KEY" ]; then
            echo -e "${RED}API key is required${NC}"
            exit 1
        fi

        mkdir -p "$INSTALL_DIR"
        cat > "$ENV_FILE" << ENVEOF
WEB_SERVER_URL=${HUB_URL}
API_KEY=${API_KEY}
DRONE_ID=${DRONE_ID}
ENVEOF
        chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo -e "${GREEN}  ✓ Created forwarder.env${NC}"
    fi
fi

# MAVLink connection
echo ""
echo -e "${YELLOW}MAVLink Connection:${NC}"
echo "  The forwarder connects to the flight controller via MAVSDK."
echo "  Default: udpin://0.0.0.0:14540 (listens for MAVLink UDP on port 14540)"
read -p "MAVLink URL [udpin://0.0.0.0:14540]: " MAVLINK_URL
MAVLINK_URL=${MAVLINK_URL:-"udpin://0.0.0.0:14540"}

# UAVCAN configuration
echo ""
echo -e "${YELLOW}UAVCAN Battery Monitoring:${NC}"
echo "  The forwarder can also collect battery data via UAVCAN/DroneCAN."
echo "  This requires a CAN interface (e.g., can0) configured on the Pi."
read -p "Enable UAVCAN battery monitoring? [Y/n]: " ENABLE_UAVCAN
ENABLE_UAVCAN=${ENABLE_UAVCAN:-Y}

CAN_INTERFACE="can0"
if [[ "$ENABLE_UAVCAN" =~ ^[Yy] ]]; then
    read -p "CAN interface [can0]: " CAN_INPUT
    CAN_INTERFACE=${CAN_INPUT:-"can0"}
fi

# Telemetry rate
read -p "Telemetry update rate in Hz [10]: " UPDATE_RATE
UPDATE_RATE=${UPDATE_RATE:-"10"}

# Summary
echo ""
echo -e "${CYAN}Summary:${NC}"
echo "  Install dir:    $INSTALL_DIR"
echo "  Service user:   $SERVICE_USER"
echo "  MAVLink URL:    $MAVLINK_URL"
echo "  UAVCAN:         $(if [[ "$ENABLE_UAVCAN" =~ ^[Yy] ]]; then echo "Enabled ($CAN_INTERFACE)"; else echo "Disabled"; fi)"
echo "  Update rate:    ${UPDATE_RATE} Hz"
echo "  Env file:       $ENV_FILE"
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
    aiohttp \
    dronecan

echo -e "${GREEN}  ✓ Python dependencies installed${NC}"

# ── Step 2: Copy script to install directory ─────────────────────────────
echo ""
echo -e "${GREEN}[2/4] Copying telemetry forwarder script...${NC}"

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/telemetry_forwarder.py" "$INSTALL_DIR/telemetry_forwarder.py"
chmod +x "$INSTALL_DIR/telemetry_forwarder.py"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/telemetry_forwarder.py"

echo -e "${GREEN}  ✓ Script copied to $INSTALL_DIR/telemetry_forwarder.py${NC}"

# ── Step 3: Create systemd service ───────────────────────────────────────
echo ""
echo -e "${GREEN}[3/4] Creating systemd service...${NC}"

# Build environment overrides for the service
ENV_OVERRIDES="Environment=PYTHONUNBUFFERED=1"
ENV_OVERRIDES+="\nEnvironment=MAVLINK_URL=${MAVLINK_URL}"
ENV_OVERRIDES+="\nEnvironment=UPDATE_RATE_HZ=${UPDATE_RATE}"

if [[ "$ENABLE_UAVCAN" =~ ^[Yy] ]]; then
    ENV_OVERRIDES+="\nEnvironment=CAN_INTERFACE=${CAN_INTERFACE}"
fi

cat > /etc/systemd/system/telemetry-forwarder.service << EOF
[Unit]
Description=Quiver Hub – Telemetry Forwarder (MAVLink + UAVCAN → Hub)
Documentation=https://github.com/Pan-Robotics/Feather-Companion-Computer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}

# Load shared environment variables (WEB_SERVER_URL, API_KEY, DRONE_ID)
EnvironmentFile=${ENV_FILE}

# Service-specific environment
$(echo -e "$ENV_OVERRIDES")

# Execute the telemetry forwarder
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/telemetry_forwarder.py

# Restart policy
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Resource limits
LimitNOFILE=65536

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telemetry-forwarder

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}  ✓ Service file created at /etc/systemd/system/telemetry-forwarder.service${NC}"

# ── Step 4: Enable and start service ─────────────────────────────────────
echo ""
echo -e "${GREEN}[4/4] Enabling and starting service...${NC}"

systemctl daemon-reload
systemctl enable telemetry-forwarder.service
systemctl start telemetry-forwarder.service

echo -e "${GREEN}  ✓ Service enabled and started${NC}"

# ── Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}Useful commands:${NC}"
echo "  sudo systemctl status telemetry-forwarder      # Check service status"
echo "  sudo journalctl -u telemetry-forwarder -f      # View live logs"
echo "  sudo systemctl restart telemetry-forwarder     # Restart service"
echo "  sudo systemctl stop telemetry-forwarder        # Stop service"
echo ""
echo -e "${CYAN}The service will:${NC}"
echo "  • Collect MAVLink telemetry at ${UPDATE_RATE} Hz from ${MAVLINK_URL}"
if [[ "$ENABLE_UAVCAN" =~ ^[Yy] ]]; then
    echo "  • Collect UAVCAN battery data from ${CAN_INTERFACE}"
fi
echo "  • Forward telemetry to Quiver Hub via HTTP POST"
echo "  • Use credentials from ${ENV_FILE}"
echo ""
echo -e "${CYAN}Debug mode:${NC}"
echo "  To run with verbose logging, stop the service and run manually:"
echo "    sudo systemctl stop telemetry-forwarder"
echo "    cd ${INSTALL_DIR} && python3 telemetry_forwarder.py --debug"
echo ""
