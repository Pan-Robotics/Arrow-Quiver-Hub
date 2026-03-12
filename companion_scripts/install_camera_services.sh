#!/bin/bash
# =============================================================================
# SIYI Camera Services Installation Script
# =============================================================================
# This script installs the SIYI A8 mini camera controller, HLS streaming,
# and cloudflared tunnel services on a Raspberry Pi companion computer.
#
# The cloudflared tunnel exposes the local HLS server to the internet so
# the cloud-hosted Quiver Hub can proxy the camera stream to browsers.
# The camera_stream_service.py auto-detects the tunnel URL — no manual
# URL configuration is needed per drone.
#
# Prerequisites:
# - Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
# - Python 3.9+
# - Network connectivity to SIYI camera (192.168.144.25)
# - Internet connectivity (for cloudflared tunnel + Hub registration)
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

# Detect architecture for cloudflared download
ARCH=$(uname -m)
case "$ARCH" in
    aarch64) CF_ARCH="arm64" ;;
    armv7l)  CF_ARCH="arm" ;;
    x86_64)  CF_ARCH="amd64" ;;
    *)
        echo -e "${RED}Unsupported architecture: $ARCH${NC}"
        exit 1
        ;;
esac

# Configuration
INSTALL_DIR="/home/pi/quiver"
SERVICE_USER="pi"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
TUNNEL_METRICS_PORT=33843

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
    echo -e "${RED}API Key is required${NC}"
    exit 1
fi

read -p "Stream type (main=4K, sub=720p) [sub]: " STREAM_TYPE
STREAM_TYPE=${STREAM_TYPE:-"sub"}

read -p "HLS HTTP port [8080]: " HLS_PORT
HLS_PORT=${HLS_PORT:-"8080"}

echo ""
echo -e "${GREEN}Step 1: Installing system dependencies...${NC}"
apt-get update
apt-get install -y python3 python3-pip ffmpeg curl

echo ""
echo -e "${GREEN}Step 2: Installing Python dependencies...${NC}"
pip3 install --break-system-packages requests websockets

echo ""
echo -e "${GREEN}Step 3: Installing cloudflared...${NC}"
if [ -f "$CLOUDFLARED_BIN" ]; then
    echo -e "${YELLOW}cloudflared already installed, updating...${NC}"
fi
curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$CLOUDFLARED_BIN"
chmod +x "$CLOUDFLARED_BIN"
echo -e "Installed: $($CLOUDFLARED_BIN --version)"

echo ""
echo -e "${GREEN}Step 4: Creating installation directory...${NC}"
mkdir -p "$INSTALL_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo ""
echo -e "${GREEN}Step 5: Copying scripts...${NC}"
cp "$SCRIPT_DIR/siyi_camera_controller.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/camera_stream_service.py" "$INSTALL_DIR/"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"/*.py
chmod +x "$INSTALL_DIR"/*.py

echo ""
echo -e "${GREEN}Step 6: Creating environment file...${NC}"
cat > "$INSTALL_DIR/.env" << EOF
# Quiver Hub Configuration
HUB_URL=$HUB_URL
DRONE_ID=$DRONE_ID
API_KEY=$API_KEY

# SIYI Camera Configuration
SIYI_CAMERA_IP=192.168.144.25
SIYI_SDK_PORT=37260
SIYI_RTSP_PORT=8554

# Streaming Configuration
HLS_HTTP_PORT=$HLS_PORT
STREAM_TYPE=$STREAM_TYPE

# Cloudflared Tunnel
# The tunnel metrics port must match --metrics in cloudflared-hls.service
# and --tunnel-metrics-port in camera-stream.service
TUNNEL_METRICS_PORT=$TUNNEL_METRICS_PORT
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

echo ""
echo -e "${GREEN}Step 7: Installing systemd services...${NC}"

# Cloudflared tunnel service (must start before camera-stream)
cat > /etc/systemd/system/cloudflared-hls.service << EOF
[Unit]
Description=Cloudflared Quick Tunnel for HLS Camera Stream
After=network-online.target
Wants=network-online.target
Before=camera-stream.service

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=$CLOUDFLARED_BIN tunnel --url http://localhost:$HLS_PORT --metrics 127.0.0.1:$TUNNEL_METRICS_PORT
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cloudflared-hls

[Install]
WantedBy=multi-user.target
EOF

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
ExecStart=/usr/bin/python3 $INSTALL_DIR/siyi_camera_controller.py --hub-url \${HUB_URL} --drone-id \${DRONE_ID} --api-key \${API_KEY}
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=siyi-camera

[Install]
WantedBy=multi-user.target
EOF

# Camera streaming service (depends on cloudflared tunnel)
cat > /etc/systemd/system/camera-stream.service << EOF
[Unit]
Description=SIYI A8 Mini RTSP to HLS Streaming Service
After=network-online.target siyi-camera.service cloudflared-hls.service
Wants=network-online.target
Requires=cloudflared-hls.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=/usr/bin/python3 $INSTALL_DIR/camera_stream_service.py \\
    --stream \${STREAM_TYPE} \\
    --port \${HLS_HTTP_PORT} \\
    --hub-url \${HUB_URL} \\
    --drone-id \${DRONE_ID} \\
    --api-key \${API_KEY} \\
    --tunnel-metrics-port \${TUNNEL_METRICS_PORT}
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
echo -e "${GREEN}Step 8: Enabling and starting services...${NC}"
systemctl daemon-reload
systemctl enable cloudflared-hls.service
systemctl enable siyi-camera.service
systemctl enable camera-stream.service
systemctl start cloudflared-hls.service
sleep 3  # Give tunnel a moment to establish
systemctl start siyi-camera.service
systemctl start camera-stream.service

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Services installed:"
echo -e "  - cloudflared-hls.service  (Tunnel: exposes HLS to internet)"
echo -e "  - siyi-camera.service      (Camera gimbal controller)"
echo -e "  - camera-stream.service    (RTSP → HLS streaming + Hub registration)"
echo ""
echo -e "Startup order: cloudflared-hls → camera-stream (auto-detects tunnel URL)"
echo ""
echo -e "Useful commands:"
echo -e "  ${YELLOW}sudo systemctl status cloudflared-hls${NC}   - Check tunnel status"
echo -e "  ${YELLOW}sudo systemctl status siyi-camera${NC}       - Check camera controller"
echo -e "  ${YELLOW}sudo systemctl status camera-stream${NC}     - Check streaming status"
echo -e "  ${YELLOW}sudo journalctl -u cloudflared-hls -f${NC}   - View tunnel logs"
echo -e "  ${YELLOW}sudo journalctl -u camera-stream -f${NC}     - View streaming logs"
echo -e "  ${YELLOW}curl http://127.0.0.1:$TUNNEL_METRICS_PORT/quicktunnel${NC}  - Show tunnel URL"
echo ""
echo -e "Local HLS stream: ${GREEN}http://localhost:$HLS_PORT/stream.m3u8${NC}"
echo -e "Tunnel URL will be auto-detected and registered with Hub"
echo ""
