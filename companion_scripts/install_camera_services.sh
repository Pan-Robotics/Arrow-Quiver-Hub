#!/bin/bash
# =============================================================================
# SIYI Camera Services Installation Script
# =============================================================================
# This script installs the SIYI A8 mini camera controller, go2rtc WebRTC
# streaming, and Tailscale funnel services on a Raspberry Pi companion computer.
#
# Architecture:
#   RTSP Camera → go2rtc (RTSP→WebRTC) → Tailscale Funnel (public HTTPS)
#   Browser ←→ go2rtc (WebRTC peer-to-peer, signaling via Tailscale funnel)
#
# go2rtc handles RTSP ingest and WebRTC signaling/media.
# Tailscale funnel exposes go2rtc's API to the internet for signaling.
# WebRTC media flows peer-to-peer via UDP (STUN hole-punch).
# camera_stream_service.py manages go2rtc, auto-detects the Tailscale
# funnel URL, and registers it with the Quiver Hub.
#
# Prerequisites:
# - Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
# - Python 3.9+
# - Network connectivity to SIYI camera (192.168.144.25)
# - Internet connectivity (for Tailscale funnel + Hub registration)
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
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SIYI Camera Services Installer${NC}"
echo -e "${GREEN}  WebRTC + Tailscale Funnel Edition${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    aarch64) GO2RTC_ARCH="arm64" ;;
    armv7l)  GO2RTC_ARCH="arm" ;;
    x86_64)  GO2RTC_ARCH="amd64" ;;
    *)
        echo -e "${RED}Unsupported architecture: $ARCH${NC}"
        exit 1
        ;;
esac

# Configuration defaults
INSTALL_DIR="/home/pi/quiver"
SERVICE_USER="pi"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO2RTC_BIN="/usr/local/bin/go2rtc"
GO2RTC_API_PORT=1984
GO2RTC_WEBRTC_PORT=8555
TAILSCALE_FUNNEL_PORT=443

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

read -p "RTSP stream type (main=4K, sub=720p) [sub]: " STREAM_TYPE
STREAM_TYPE=${STREAM_TYPE:-"sub"}

read -p "go2rtc API port [$GO2RTC_API_PORT]: " INPUT_API_PORT
GO2RTC_API_PORT=${INPUT_API_PORT:-$GO2RTC_API_PORT}

read -p "go2rtc WebRTC UDP port [$GO2RTC_WEBRTC_PORT]: " INPUT_WEBRTC_PORT
GO2RTC_WEBRTC_PORT=${INPUT_WEBRTC_PORT:-$GO2RTC_WEBRTC_PORT}

# Build RTSP URL based on stream type
if [ "$STREAM_TYPE" = "main" ]; then
    RTSP_URL="rtsp://192.168.144.25:8554/main.264"
else
    RTSP_URL="rtsp://192.168.144.25:8554/sub.264"
fi

echo ""
echo -e "${GREEN}Step 1: Installing system dependencies...${NC}"
apt-get update
apt-get install -y python3 python3-pip curl jq

echo ""
echo -e "${GREEN}Step 2: Installing Python dependencies...${NC}"
pip3 install --break-system-packages requests 'python-socketio[asyncio_client]' aiohttp

echo ""
echo -e "${GREEN}Step 3: Installing go2rtc...${NC}"
if [ -f "$GO2RTC_BIN" ]; then
    echo -e "${YELLOW}go2rtc already installed, updating...${NC}"
fi
# Get latest release URL
GO2RTC_URL=$(curl -s https://api.github.com/repos/AlexxIT/go2rtc/releases/latest \
    | jq -r ".assets[] | select(.name | test(\"go2rtc_linux_${GO2RTC_ARCH}\")) | .browser_download_url" \
    | head -1)
if [ -z "$GO2RTC_URL" ]; then
    echo -e "${RED}Failed to find go2rtc release for ${GO2RTC_ARCH}${NC}"
    exit 1
fi
echo -e "Downloading: $GO2RTC_URL"
curl -L "$GO2RTC_URL" -o "$GO2RTC_BIN"
chmod +x "$GO2RTC_BIN"
echo -e "Installed: $($GO2RTC_BIN --version 2>&1 || echo 'go2rtc installed')"

echo ""
echo -e "${GREEN}Step 4: Installing Tailscale...${NC}"
if command -v tailscale &> /dev/null; then
    echo -e "${YELLOW}Tailscale already installed${NC}"
    tailscale version
else
    curl -fsSL https://tailscale.com/install.sh | sh
    echo -e "${CYAN}Tailscale installed. You need to authenticate:${NC}"
    echo -e "${CYAN}  sudo tailscale up${NC}"
    echo -e "${CYAN}Follow the URL to authenticate this device.${NC}"
    echo ""
    read -p "Press Enter after authenticating Tailscale (or Ctrl+C to abort)..."
fi

# Check Tailscale status
if ! tailscale status &> /dev/null; then
    echo -e "${YELLOW}Tailscale is not connected. Running 'tailscale up'...${NC}"
    tailscale up
    echo -e "${CYAN}Follow the URL above to authenticate.${NC}"
    read -p "Press Enter after authenticating..."
fi

# Get the Tailscale hostname for this device
TS_HOSTNAME=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
if [ -z "$TS_HOSTNAME" ] || [ "$TS_HOSTNAME" = "null" ]; then
    echo -e "${RED}Could not determine Tailscale hostname.${NC}"
    echo -e "${RED}Make sure Tailscale is authenticated and connected.${NC}"
    exit 1
fi
echo -e "Tailscale hostname: ${CYAN}${TS_HOSTNAME}${NC}"

echo ""
echo -e "${GREEN}Step 5: Setting up Tailscale funnel...${NC}"
# Enable HTTPS and funnel for the go2rtc API port
echo -e "Enabling funnel on port $TAILSCALE_FUNNEL_PORT → localhost:$GO2RTC_API_PORT"
tailscale funnel --bg --https=$TAILSCALE_FUNNEL_PORT http://localhost:$GO2RTC_API_PORT

# Construct the funnel URL
FUNNEL_URL="https://${TS_HOSTNAME}"
if [ "$TAILSCALE_FUNNEL_PORT" != "443" ]; then
    FUNNEL_URL="https://${TS_HOSTNAME}:${TAILSCALE_FUNNEL_PORT}"
fi
echo -e "Funnel URL: ${CYAN}${FUNNEL_URL}${NC}"

echo ""
echo -e "${GREEN}Step 6: Creating installation directory...${NC}"
mkdir -p "$INSTALL_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo ""
echo -e "${GREEN}Step 7: Copying scripts...${NC}"
cp "$SCRIPT_DIR/siyi_camera_controller.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/camera_stream_service.py" "$INSTALL_DIR/"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"/*.py
chmod +x "$INSTALL_DIR"/*.py

echo ""
echo -e "${GREEN}Step 8: Creating go2rtc configuration...${NC}"
cat > "$INSTALL_DIR/go2rtc.yaml" << EOF
# go2rtc configuration for SIYI A8 Mini camera
# Managed by install_camera_services.sh — edit with care

streams:
  camera:
    - $RTSP_URL

api:
  listen: ":$GO2RTC_API_PORT"

webrtc:
  listen: ":$GO2RTC_WEBRTC_PORT"
  candidates:
    - stun:8555
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/go2rtc.yaml"

echo ""
echo -e "${GREEN}Step 9: Creating environment file...${NC}"
cat > "$INSTALL_DIR/.env" << EOF
# Quiver Hub Configuration
HUB_URL=$HUB_URL
DRONE_ID=$DRONE_ID
API_KEY=$API_KEY

# SIYI Camera Configuration
SIYI_CAMERA_IP=192.168.144.25
SIYI_SDK_PORT=37260
SIYI_RTSP_PORT=8554

# go2rtc Configuration
GO2RTC_API_PORT=$GO2RTC_API_PORT
GO2RTC_WEBRTC_PORT=$GO2RTC_WEBRTC_PORT
RTSP_URL=$RTSP_URL
STREAM_TYPE=$STREAM_TYPE

# Tailscale Funnel
# The funnel URL is auto-detected by camera_stream_service.py
# but stored here for reference
TAILSCALE_FUNNEL_URL=$FUNNEL_URL
TAILSCALE_HOSTNAME=$TS_HOSTNAME
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

echo ""
echo -e "${GREEN}Step 10: Installing systemd services...${NC}"

# go2rtc service
cat > /etc/systemd/system/go2rtc.service << EOF
[Unit]
Description=go2rtc WebRTC Streaming Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$GO2RTC_BIN -config $INSTALL_DIR/go2rtc.yaml
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=go2rtc

[Install]
WantedBy=multi-user.target
EOF

# Tailscale funnel service (persistent, survives reboots)
cat > /etc/systemd/system/tailscale-funnel.service << EOF
[Unit]
Description=Tailscale Funnel for go2rtc WebRTC Signaling
After=network-online.target tailscaled.service go2rtc.service
Wants=network-online.target
Requires=tailscaled.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/tailscale funnel --bg --https=$TAILSCALE_FUNNEL_PORT http://localhost:$GO2RTC_API_PORT
ExecStop=/usr/bin/tailscale funnel --https=$TAILSCALE_FUNNEL_PORT off
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tailscale-funnel

[Install]
WantedBy=multi-user.target
EOF

# Camera controller service (SIYI gimbal control via Socket.IO)
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

# Camera stream management service (manages go2rtc + registers with Hub)
cat > /etc/systemd/system/camera-stream.service << EOF
[Unit]
Description=Camera Stream Manager (go2rtc + Tailscale + Hub Registration)
After=network-online.target go2rtc.service tailscale-funnel.service
Wants=network-online.target
Requires=go2rtc.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=/usr/bin/python3 $INSTALL_DIR/camera_stream_service.py \\
    --stream \${STREAM_TYPE} \\
    --hub-url \${HUB_URL} \\
    --drone-id \${DRONE_ID} \\
    --api-key \${API_KEY} \\
    --go2rtc-api http://localhost:\${GO2RTC_API_PORT}
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
echo -e "${GREEN}Step 11: Enabling and starting services...${NC}"
systemctl daemon-reload
systemctl enable go2rtc.service
systemctl enable tailscale-funnel.service
systemctl enable siyi-camera.service
systemctl enable camera-stream.service

systemctl start go2rtc.service
sleep 2  # Give go2rtc a moment to start
systemctl start tailscale-funnel.service
sleep 1
systemctl start siyi-camera.service
systemctl start camera-stream.service

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Architecture:"
echo -e "  RTSP Camera → go2rtc (WebRTC) → Tailscale Funnel → Browser"
echo -e ""
echo -e "Services installed:"
echo -e "  - go2rtc.service             (RTSP → WebRTC streaming server)"
echo -e "  - tailscale-funnel.service   (Exposes go2rtc API to internet)"
echo -e "  - siyi-camera.service        (Camera gimbal controller via Socket.IO)"
echo -e "  - camera-stream.service      (Manages go2rtc + registers with Hub)"
echo ""
echo -e "Startup order: go2rtc → tailscale-funnel → camera-stream"
echo ""
echo -e "Key URLs:"
echo -e "  Local go2rtc API:    ${CYAN}http://localhost:$GO2RTC_API_PORT${NC}"
echo -e "  Local go2rtc WebUI:  ${CYAN}http://localhost:$GO2RTC_API_PORT${NC}"
echo -e "  Tailscale Funnel:    ${CYAN}${FUNNEL_URL}${NC}"
echo -e "  WebRTC signaling:    ${CYAN}${FUNNEL_URL}/api/webrtc?src=camera${NC}"
echo ""
echo -e "Useful commands:"
echo -e "  ${YELLOW}sudo systemctl status go2rtc${NC}             - Check go2rtc status"
echo -e "  ${YELLOW}sudo systemctl status tailscale-funnel${NC}   - Check funnel status"
echo -e "  ${YELLOW}sudo systemctl status siyi-camera${NC}        - Check camera controller"
echo -e "  ${YELLOW}sudo systemctl status camera-stream${NC}      - Check stream manager"
echo -e "  ${YELLOW}sudo journalctl -u go2rtc -f${NC}             - View go2rtc logs"
echo -e "  ${YELLOW}sudo journalctl -u camera-stream -f${NC}      - View stream manager logs"
echo -e "  ${YELLOW}tailscale funnel status${NC}                   - View funnel status"
echo -e "  ${YELLOW}tailscale status${NC}                          - View Tailscale status"
echo ""
echo -e "${YELLOW}Note:${NC} The camera_stream_service.py auto-detects the Tailscale"
echo -e "funnel URL and registers it with the Quiver Hub. No manual URL"
echo -e "configuration is needed per drone."
echo ""
