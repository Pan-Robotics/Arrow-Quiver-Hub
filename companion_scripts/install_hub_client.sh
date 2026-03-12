#!/bin/bash
#
# Quiver Hub Client Installation Script
# This script installs and configures the Quiver Hub client on Raspberry Pi
#

set -e  # Exit on error

echo "=========================================="
echo "Quiver Hub Client Installation"
echo "=========================================="
echo ""

# Check if running on Raspberry Pi
if [ ! -f /proc/device-tree/model ] || ! grep -q "Raspberry Pi" /proc/device-tree/model 2>/dev/null; then
    echo "⚠️  Warning: This doesn't appear to be a Raspberry Pi"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    echo "❌ Please do not run this script as root or with sudo"
    echo "   The script will ask for sudo password when needed"
    exit 1
fi

echo "📦 Step 1: Installing dependencies..."
sudo apt-get update
sudo apt-get install -y python3 python3-pip

echo ""
echo "📦 Step 2: Installing Python packages..."
pip3 install --user requests

echo ""
echo "📁 Step 3: Creating directories..."
mkdir -p /home/alexd/quiver
mkdir -p /home/alexd/parsers
mkdir -p /home/alexd/config

echo ""
echo "📄 Step 4: Copying files..."
# Check if files exist in current directory
if [ ! -f "raspberry_pi_client.py" ]; then
    echo "❌ Error: raspberry_pi_client.py not found in current directory"
    echo "   Please run this script from the directory containing the client files"
    exit 1
fi

cp raspberry_pi_client.py /home/alexd/quiver/
chmod +x /home/alexd/quiver/raspberry_pi_client.py

if [ -f "README.md" ]; then
    cp README.md /home/alexd/quiver/
fi

echo ""
echo "⚙️  Step 5: Configuring environment..."

# Check if forwarder.env exists
if [ -f "forwarder.env" ]; then
    echo "   Found forwarder.env, copying to /home/alexd/quiver/"
    cp forwarder.env /home/alexd/quiver/
else
    echo "   Creating forwarder.env template..."
    cat > /home/alexd/quiver/forwarder.env << 'EOF'
# TCP port to listen on for Raspberry Pi connections (not used by client)
TCP_PORT=5555

# Web server endpoint URL (extract base URL, remove /api/rest/pointcloud/ingest)
WEB_SERVER_URL=https://your-quiver-hub-server.com

# API key for authentication with web server
API_KEY=your-api-key-here
EOF
    echo ""
    echo "⚠️  IMPORTANT: Edit /home/alexd/quiver/forwarder.env with your server details:"
    echo "   - Set WEB_SERVER_URL to your Quiver Hub server URL"
    echo "   - Set API_KEY to your drone's API key"
    echo ""
    read -p "Press Enter to edit the file now, or Ctrl+C to exit and edit later..."
    nano /home/alexd/quiver/forwarder.env
fi

echo ""
echo "🔧 Step 6: Installing systemd service..."
sudo cp quiver-hub-client.service /etc/systemd/system/
sudo systemctl daemon-reload

echo ""
echo "✅ Installation complete!"
echo ""
echo "=========================================="
echo "Next Steps:"
echo "=========================================="
echo ""
echo "1. Verify your configuration:"
echo "   cat /home/alexd/quiver/forwarder.env"
echo ""
echo "2. Start the service:"
echo "   sudo systemctl start quiver-hub-client"
echo ""
echo "3. Enable auto-start on boot:"
echo "   sudo systemctl enable quiver-hub-client"
echo ""
echo "4. Check service status:"
echo "   sudo systemctl status quiver-hub-client"
echo ""
echo "5. View logs:"
echo "   sudo journalctl -u quiver-hub-client -f"
echo ""
echo "=========================================="
echo ""
