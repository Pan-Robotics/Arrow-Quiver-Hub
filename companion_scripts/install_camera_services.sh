#!/bin/bash
# =============================================================================
# SIYI Camera Services Installation Script
# =============================================================================
# This script installs the SIYI A8 mini camera controller and streaming
# services on a Raspberry Pi companion computer.
#
# Prerequisites:
# - Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
# - Python 3.9+
# - Network connectivity to SIYI camera (192.168.144.25)
# - FFmpeg for video transcoding
#
# Usage:
#   chmod +x install_camera_services.sh
#   sudo ./install_camera_services.sh
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SIYI Camera Services Installer${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

# Configuration
INSTALL_DIR="/home/pi/quiver"
SERVICE_USER="pi"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prompt for configuration
echo ""
echo -e "${YELLOW}Configuration:${NC}"
read -p "Quiver Hub WebSocket URL [wss://your-hub.manus.space/socket.io/]: " HUB_WS_URL
HUB_WS_URL=${HUB_WS_URL:-"wss://your-hub.manus.space/socket.io/"}

read -p "Drone ID [quiver_001]: " DRONE_ID
DRONE_ID=${DRONE_ID:-"quiver_001"}

read -p "API Key: " API_KEY
if [ -z "$API_KEY" ]; then
    echo -e "${RED}API Key is required${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}Step 1: Installing system dependencies...${NC}"
apt-get update
apt-get install -y python3 python3-pip ffmpeg

echo ""
echo -e "${GREEN}Step 2: Installing Python dependencies...${NC}"
pip3 install --break-system-packages python-socketio[client] aiohttp websockets

echo ""
echo -e "${GREEN}Step 3: Creating installation directory...${NC}"
mkdir -p "$INSTALL_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo ""
echo -e "${GREEN}Step 4: Copying scripts...${NC}"
cp "$SCRIPT_DIR/siyi_camera_controller.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/camera_stream_service.py" "$INSTALL_DIR/"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"/*.py
chmod +x "$INSTALL_DIR"/*.py

echo ""
echo -e "${GREEN}Step 5: Creating environment file...${NC}"
cat > "$INSTALL_DIR/.env" << EOF
# Quiver Hub Configuration
HUB_WS_URL=$HUB_WS_URL
DRONE_ID=$DRONE_ID
API_KEY=$API_KEY

# SIYI Camera Configuration
SIYI_CAMERA_IP=192.168.144.25
SIYI_SDK_PORT=37260
SIYI_RTSP_PORT=8554

# Streaming Configuration
HLS_HTTP_PORT=8080
STREAM_TYPE=sub
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

echo ""
echo -e "${GREEN}Step 6: Installing systemd services...${NC}"

# Camera controller service
cat > /etc/systemd/system/siyi-camera.service << EOF
[Unit]
Description=SIYI A8 Mini Camera Controller Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=/usr/bin/python3 $INSTALL_DIR/siyi_camera_controller.py --hub-url \${HUB_WS_URL} --drone-id \${DRONE_ID} --api-key \${API_KEY}
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=siyi-camera

[Install]
WantedBy=multi-user.target
EOF

# Camera streaming service
cat > /etc/systemd/system/camera-stream.service << EOF
[Unit]
Description=SIYI A8 Mini RTSP to HLS Streaming Service
After=network-online.target siyi-camera.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=/usr/bin/python3 $INSTALL_DIR/camera_stream_service.py --stream \${STREAM_TYPE} --port \${HLS_HTTP_PORT}
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=camera-stream

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo -e "${GREEN}Step 7: Enabling and starting services...${NC}"
systemctl daemon-reload
systemctl enable siyi-camera.service
systemctl enable camera-stream.service
systemctl start siyi-camera.service
systemctl start camera-stream.service

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Services installed:"
echo -e "  - siyi-camera.service (Camera controller)"
echo -e "  - camera-stream.service (HLS streaming)"
echo ""
echo -e "Useful commands:"
echo -e "  ${YELLOW}sudo systemctl status siyi-camera${NC}     - Check camera controller status"
echo -e "  ${YELLOW}sudo systemctl status camera-stream${NC}   - Check streaming status"
echo -e "  ${YELLOW}sudo journalctl -u siyi-camera -f${NC}     - View camera controller logs"
echo -e "  ${YELLOW}sudo journalctl -u camera-stream -f${NC}   - View streaming logs"
echo ""
echo -e "HLS stream available at: ${GREEN}http://localhost:8080/stream.m3u8${NC}"
echo ""
