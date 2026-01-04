# Quiver Hub - Raspberry Pi Client

Two-way communication client for Raspberry Pi companion computer on Quiver drones.

## Overview

This Python client runs on the Raspberry Pi and enables two-way communication with the Quiver Hub server:

**From Server → Pi:**
- Upload parser files
- Update configuration
- Execute custom commands

**From Pi → Server:**
- Send telemetry data (existing)
- Report job status
- Acknowledge task completion

## Architecture

The system uses a **simple job queue** approach:

1. **Web UI** creates jobs (e.g., "upload file X to path Y")
2. **Server** stores jobs in database
3. **Pi client** polls server for pending jobs
4. **Pi client** executes jobs and reports completion
5. **Web UI** shows job history and status

## Installation

### Prerequisites

```bash
# On Raspberry Pi
sudo apt-get update
sudo apt-get install python3 python3-pip
pip3 install requests
```

### Download Client

```bash
# Copy raspberry_pi_client.py to your Raspberry Pi
scp raspberry_pi_client.py pi@your-pi-ip:/home/pi/
```

### Make Executable

```bash
chmod +x /home/pi/raspberry_pi_client.py
```

## Configuration

### 1. Get Your API Key

1. Log in to Quiver Hub web interface
2. Navigate to Settings → API Keys
3. Create a new API key for your drone
4. Copy the API key

### 2. Run the Client

```bash
python3 /home/pi/raspberry_pi_client.py \
  --server https://your-quiver-hub.com \
  --drone-id quiver_001 \
  --api-key your-api-key-here
```

### 3. Run as System Service (Recommended)

Create a systemd service to run the client automatically on boot:

```bash
sudo nano /etc/systemd/system/quiver-hub-client.service
```

Add the following content:

```ini
[Unit]
Description=Quiver Hub Client
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStart=/usr/bin/python3 /home/pi/raspberry_pi_client.py --server https://your-quiver-hub.com --drone-id quiver_001 --api-key your-api-key-here
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable quiver-hub-client
sudo systemctl start quiver-hub-client
```

Check status:

```bash
sudo systemctl status quiver-hub-client
```

View logs:

```bash
sudo journalctl -u quiver-hub-client -f
```

## Usage

### Command Line Options

```
--server         Quiver Hub server URL (required)
--drone-id       Unique identifier for this drone (required)
--api-key        API key for authentication (required)
--poll-interval  How often to poll for jobs in seconds (default: 5)
--debug          Enable debug logging
```

### Example Commands

**Basic usage:**
```bash
python3 raspberry_pi_client.py \
  --server https://quiver-hub.example.com \
  --drone-id quiver_001 \
  --api-key abc123def456
```

**With custom poll interval:**
```bash
python3 raspberry_pi_client.py \
  --server https://quiver-hub.example.com \
  --drone-id quiver_001 \
  --api-key abc123def456 \
  --poll-interval 10
```

**With debug logging:**
```bash
python3 raspberry_pi_client.py \
  --server https://quiver-hub.example.com \
  --drone-id quiver_001 \
  --api-key abc123def456 \
  --debug
```

## Supported Job Types

### 1. upload_file

Upload a file from the server to the Raspberry Pi.

**Payload:**
```json
{
  "fileId": "abc123",
  "fileUrl": "https://s3.../file.py",
  "targetPath": "/home/pi/parsers/sensor_parser.py",
  "filename": "sensor_parser.py"
}
```

**What it does:**
- Downloads the file from S3
- Saves it to the specified path on the Pi
- Creates directories if they don't exist

### 2. update_config

Update the drone configuration file.

**Payload:**
```json
{
  "config": {
    "sensor_rate": 10,
    "telemetry_interval": 5
  },
  "configFile": "/home/pi/config/quiver_config.json"
}
```

**What it does:**
- Writes the config JSON to the specified file
- Creates directories if they don't exist

## Web UI Usage

### Upload a Parser File

1. Navigate to **Drone Configuration** page (Settings icon in sidebar)
2. Select your drone from the dropdown
3. Click **Choose File** and select your parser file
4. Set **Target Path** (e.g., `/home/pi/parsers/my_parser.py`)
5. Add a description (optional)
6. Click **Upload File**

The file will be uploaded to S3 and a job will be created. The Pi client will automatically:
- Detect the new job
- Download the file from S3
- Save it to the specified path
- Report completion status

### Monitor Jobs

The **Job History** section shows:
- Job type (upload_file, update_config, etc.)
- Status (pending, in_progress, completed, failed)
- Timestamps (created, acknowledged, completed)
- Error messages (if failed)

## Troubleshooting

### Client won't start

**Check Python version:**
```bash
python3 --version  # Should be 3.7+
```

**Check requests library:**
```bash
pip3 show requests
```

### Can't connect to server

**Test connectivity:**
```bash
curl https://your-quiver-hub.com/api/health
```

**Check API key:**
- Verify the API key is correct
- Check that the API key is active in the web UI

### Jobs not being processed

**Check client logs:**
```bash
# If running as service
sudo journalctl -u quiver-hub-client -f

# If running manually
# Look at the terminal output
```

**Check job status in web UI:**
- Navigate to Drone Configuration
- Check Job History section
- Look for error messages

### File download fails

**Check permissions:**
```bash
# Ensure the target directory is writable
ls -la /home/pi/parsers/
```

**Check disk space:**
```bash
df -h
```

## Security Considerations

1. **API Key Protection**
   - Never commit API keys to git
   - Use environment variables or config files with restricted permissions
   - Rotate API keys regularly

2. **File Permissions**
   - The client runs as the `pi` user by default
   - Ensure target directories are writable by the `pi` user
   - Be careful with file paths - validate before use

3. **Network Security**
   - Always use HTTPS for the server URL
   - Consider using a VPN for additional security
   - Monitor network traffic for anomalies

## Development

### Adding New Job Types

1. Add a new handler method in the `QuiverHubClient` class:

```python
def handle_my_custom_job(self, job: Dict) -> tuple[bool, Optional[str]]:
    """Handle a custom job type"""
    try:
        payload = job.get('payload', {})
        # Your custom logic here
        return True, None
    except Exception as e:
        return False, str(e)
```

2. Add the job type to the `process_job` method:

```python
elif job_type == 'my_custom_job':
    success, error_message = self.handle_my_custom_job(job)
```

3. Create jobs from the web UI using the `droneJobs.createJob` mutation

### Testing

**Test file upload:**
```bash
# Create a test file
echo "test content" > /tmp/test.txt

# Upload via web UI
# Check that it appears in the target location on Pi
```

**Test configuration update:**
```bash
# Update config via web UI
# Check the config file on Pi:
cat /home/pi/config/quiver_config.json
```

## Support

For issues or questions:
1. Check the logs first
2. Review this README
3. Contact Quiver support

## License

Copyright © 2025 Quiver. All rights reserved.
