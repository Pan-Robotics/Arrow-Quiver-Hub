# Quiver Hub Client - Quick Start Guide

## Installation on Raspberry Pi

### Prerequisites
- Raspberry Pi (any model with network connectivity)
- Raspbian/Raspberry Pi OS installed
- Internet connection
- Your Quiver Hub server URL and API key

### Automatic Installation (Recommended)

1. **Copy files to Raspberry Pi:**
   ```bash
   # On your computer, copy all files to the Pi
   scp raspberry_pi_client.py install.sh quiver-hub-client.service forwarder.env alexd@your-pi-ip:/home/alexd/
   ```

2. **Run the installation script:**
   ```bash
   # SSH into your Raspberry Pi
   ssh alexd@your-pi-ip
   
   # Run the installer
   cd /home/alexd
   chmod +x install.sh
   ./install.sh
   ```

3. **Configure your server details:**
   
   The installer will prompt you to edit `/home/alexd/quiver/forwarder.env`. Update these values:
   
   ```bash
   # Extract base URL from your full endpoint URL
   # If your endpoint is: https://3000-xxx.manusvm.computer/api/rest/pointcloud/ingest
   # Your base URL is: https://3000-xxx.manusvm.computer
   WEB_SERVER_URL=https://your-server.com
   
   # Your drone's API key from Quiver Hub
   API_KEY=sp10G8P9XCXUBidys1KJaoeCSxOFLUo5E1CDhc9L85M
   ```

4. **Start the service:**
   ```bash
   sudo systemctl start quiver-hub-client
   sudo systemctl enable quiver-hub-client
   ```

5. **Verify it's running:**
   ```bash
   sudo systemctl status quiver-hub-client
   ```

### Manual Installation

If you prefer to install manually:

1. **Install dependencies:**
   ```bash
   sudo apt-get update
   sudo apt-get install python3 python3-pip
   pip3 install requests
   ```

2. **Create directories:**
   ```bash
   mkdir -p /home/alexd/quiver
   mkdir -p /home/alexd/parsers
   mkdir -p /home/alexd/config
   ```

3. **Copy files:**
   ```bash
   cp raspberry_pi_client.py /home/alexd/quiver/
   cp forwarder.env /home/alexd/quiver/
   chmod +x /home/alexd/quiver/raspberry_pi_client.py
   ```

4. **Edit configuration:**
   ```bash
   nano /home/alexd/quiver/forwarder.env
   ```

5. **Install service:**
   ```bash
   sudo cp quiver-hub-client.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl start quiver-hub-client
   sudo systemctl enable quiver-hub-client
   ```

## Testing the Connection

### Check Service Status
```bash
sudo systemctl status quiver-hub-client
```

Expected output:
```
● quiver-hub-client.service - Quiver Hub Client
   Loaded: loaded (/etc/systemd/system/quiver-hub-client.service; enabled)
   Active: active (running) since ...
```

### View Live Logs
```bash
sudo journalctl -u quiver-hub-client -f
```

Expected log output:
```
INFO - Initialized Quiver Hub client for drone: quiver_001
INFO - Server: https://your-server.com
INFO - Poll interval: 5s
INFO - Starting Quiver Hub client...
```

### Test File Upload from Web UI

1. Log in to your Quiver Hub web interface
2. Click the **Settings** icon (⚙️) in the sidebar
3. Select your drone from the dropdown
4. Upload a test file:
   - Click **Choose File**
   - Select a test file (e.g., a Python script)
   - Set target path: `/home/alexd/parsers/test.py`
   - Click **Upload File**

5. Watch the Raspberry Pi logs:
   ```bash
   sudo journalctl -u quiver-hub-client -f
   ```

   You should see:
   ```
   INFO - Found 1 pending job(s)
   INFO - Processing job 1: upload_file
   INFO - Acknowledged job 1
   INFO - Downloading file 'test.py' to /home/alexd/parsers/test.py
   INFO - Saved file to: /home/alexd/parsers/test.py
   INFO - Completed job 1 successfully
   ```

6. Verify the file was downloaded:
   ```bash
   ls -l /home/alexd/parsers/test.py
   cat /home/alexd/parsers/test.py
   ```

## Troubleshooting

### Service won't start

**Check Python version:**
```bash
python3 --version  # Should be 3.7 or higher
```

**Check if requests library is installed:**
```bash
python3 -c "import requests; print(requests.__version__)"
```

If not installed:
```bash
pip3 install --user requests
```

### Can't connect to server

**Test network connectivity:**
```bash
ping -c 3 google.com
```

**Test server connectivity:**
```bash
curl -I https://your-quiver-hub-server.com
```

**Verify forwarder.env:**
```bash
cat /home/alexd/quiver/forwarder.env
```

Make sure:
- `WEB_SERVER_URL` is the base URL (without `/api/rest/...`)
- `API_KEY` matches your drone's API key in Quiver Hub

### Jobs not being processed

**Check service logs for errors:**
```bash
sudo journalctl -u quiver-hub-client -n 50
```

**Verify API key is valid:**
- Log in to Quiver Hub
- Check that your API key is active
- Regenerate if necessary

**Check file permissions:**
```bash
ls -la /home/alexd/parsers/
ls -la /home/alexd/config/
```

Ensure directories are writable by the `pi` user.

## Service Management Commands

```bash
# Start the service
sudo systemctl start quiver-hub-client

# Stop the service
sudo systemctl stop quiver-hub-client

# Restart the service
sudo systemctl restart quiver-hub-client

# Enable auto-start on boot
sudo systemctl enable quiver-hub-client

# Disable auto-start
sudo systemctl disable quiver-hub-client

# Check service status
sudo systemctl status quiver-hub-client

# View logs (last 50 lines)
sudo journalctl -u quiver-hub-client -n 50

# View logs (live tail)
sudo journalctl -u quiver-hub-client -f

# View logs since boot
sudo journalctl -u quiver-hub-client -b
```

## Updating the Client

1. **Stop the service:**
   ```bash
   sudo systemctl stop quiver-hub-client
   ```

2. **Backup the old version:**
   ```bash
   cp /home/alexd/quiver/raspberry_pi_client.py /home/alexd/quiver/raspberry_pi_client.py.backup
   ```

3. **Copy new version:**
   ```bash
   scp raspberry_pi_client.py alexd@your-pi-ip:/home/alexd/quiver/
   ```

4. **Restart the service:**
   ```bash
   sudo systemctl start quiver-hub-client
   ```

5. **Verify it's working:**
   ```bash
   sudo systemctl status quiver-hub-client
   sudo journalctl -u quiver-hub-client -f
   ```

## Uninstalling

```bash
# Stop and disable the service
sudo systemctl stop quiver-hub-client
sudo systemctl disable quiver-hub-client

# Remove service file
sudo rm /etc/systemd/system/quiver-hub-client.service
sudo systemctl daemon-reload

# Remove client files (optional)
rm -rf /home/alexd/quiver

# Keep parsers and config if you want to preserve data
# Otherwise:
# rm -rf /home/alexd/parsers /home/alexd/config
```

## Support

For issues or questions:
1. Check the logs: `sudo journalctl -u quiver-hub-client -f`
2. Review the [full README](README.md)
3. Contact Quiver support

## Security Notes

- The service runs as the `pi` user (not root)
- File permissions are restricted via systemd security settings
- API keys are stored in `/home/alexd/quiver/forwarder.env` (readable only by `pi` user)
- Consider using a firewall to restrict outbound connections
- Rotate API keys regularly

## Next Steps

Once the client is running successfully:

1. **Upload parser files** - Deploy your custom payload parsers from the web UI
2. **Update configuration** - Push config changes to the drone remotely
3. **Monitor job history** - Track all file uploads and config updates in the web UI
4. **Set up multiple drones** - Repeat this process for additional Raspberry Pi units

Happy flying! 🚁
