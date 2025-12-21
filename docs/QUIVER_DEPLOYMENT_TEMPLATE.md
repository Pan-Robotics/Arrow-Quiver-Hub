# Quiver Deployment Template

This template shows how to deploy custom payload parsers directly on Quiver edge devices for autonomous data ingestion and forwarding to the Quiver Hub.

## Overview

When deploying to Quiver devices, your parser runs as a standalone Flask/FastAPI server that:
1. Receives raw payload data from sensors/devices via HTTP POST
2. Executes the parser to transform raw data into structured format
3. Forwards parsed data to Quiver Hub REST endpoint
4. Optionally broadcasts data locally via WebSocket for edge monitoring

## Complete Deployment Template

```python
#!/usr/bin/env python3
"""
Quiver Edge Parser Service
Autonomous payload parser for edge deployment on Quiver devices

This service receives raw sensor data, parses it using your custom parser,
and forwards the parsed data to Quiver Hub for visualization.
"""

import json
import sys
import os
from flask import Flask, request, jsonify
import requests
from datetime import datetime

# ============================================================================
# PARSER CONFIGURATION
# ============================================================================

# Your Quiver Hub endpoint (replace with your actual hub URL)
QUIVER_HUB_URL = os.getenv("QUIVER_HUB_URL", "https://your-quiver-hub.manus.space")
APP_ID = os.getenv("APP_ID", "your-app-id")  # Your custom app ID from Quiver Hub

# Parser metadata
PARSER_NAME = "Sensor Data Parser"
PARSER_VERSION = "1.0.0"

# ============================================================================
# DATA SCHEMA
# Define the output structure that Quiver Hub expects
# ============================================================================

SCHEMA = {
    "temperature": {"type": "number", "unit": "°C", "min": -50, "max": 150},
    "humidity": {"type": "number", "unit": "%", "min": 0, "max": 100},
    "pressure": {"type": "number", "unit": "hPa", "min": 900, "max": 1100},
    "timestamp": {"type": "string"},
}

# ============================================================================
# PARSER FUNCTION
# Implement your custom parsing logic here
# ============================================================================

def parse_payload(raw_data: dict) -> dict:
    """
    Transform raw sensor data into structured format.
    
    Args:
        raw_data: Dictionary containing raw sensor readings
        
    Returns:
        Dictionary matching the SCHEMA structure
        
    Example:
        Input:  {"temp_raw": 2850, "hum_raw": 6500, "press_raw": 101325}
        Output: {"temperature": 28.5, "humidity": 65, "pressure": 1013.25, "timestamp": "..."}
    """
    try:
        return {
            "temperature": raw_data.get("temp_raw", 0) / 100.0,
            "humidity": raw_data.get("hum_raw", 0) / 100.0,
            "pressure": raw_data.get("press_raw", 101325) / 100.0,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
    except Exception as e:
        print(f"[ERROR] Parser failed: {e}", file=sys.stderr)
        raise

# ============================================================================
# FLASK SERVER SETUP
# ============================================================================

app = Flask(__name__)

@app.route("/health", methods=["GET"])
def health_check():
    """Health check endpoint for monitoring"""
    return jsonify({
        "status": "healthy",
        "parser": PARSER_NAME,
        "version": PARSER_VERSION,
        "timestamp": datetime.utcnow().isoformat() + "Z"
    })

@app.route("/ingest", methods=["POST"])
def ingest_payload():
    """
    Receive raw payload, parse it, and forward to Quiver Hub
    
    Expected request body: JSON object with raw sensor data
    Returns: Parsed data and forwarding status
    """
    try:
        # Get raw payload from request
        raw_data = request.get_json()
        if not raw_data:
            return jsonify({"error": "No payload provided"}), 400
        
        print(f"[INFO] Received payload: {json.dumps(raw_data)}")
        
        # Parse the payload
        parsed_data = parse_payload(raw_data)
        print(f"[INFO] Parsed data: {json.dumps(parsed_data)}")
        
        # Forward to Quiver Hub
        hub_endpoint = f"{QUIVER_HUB_URL}/api/rest/payload/{APP_ID}/ingest"
        response = requests.post(
            hub_endpoint,
            json=raw_data,  # Send raw data, hub will execute parser
            headers={"Content-Type": "application/json"},
            timeout=5
        )
        
        if response.status_code == 200:
            print(f"[INFO] Successfully forwarded to Quiver Hub")
            return jsonify({
                "success": True,
                "parsed_data": parsed_data,
                "forwarded": True,
                "hub_response": response.json()
            }), 200
        else:
            print(f"[WARN] Hub returned status {response.status_code}")
            return jsonify({
                "success": True,
                "parsed_data": parsed_data,
                "forwarded": False,
                "error": f"Hub returned {response.status_code}"
            }), 200
            
    except Exception as e:
        print(f"[ERROR] Ingestion failed: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500

@app.route("/parse", methods=["POST"])
def parse_only():
    """
    Parse payload without forwarding (for testing)
    
    Expected request body: JSON object with raw sensor data
    Returns: Parsed data only
    """
    try:
        raw_data = request.get_json()
        if not raw_data:
            return jsonify({"error": "No payload provided"}), 400
        
        parsed_data = parse_payload(raw_data)
        return jsonify({
            "success": True,
            "parsed_data": parsed_data
        }), 200
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    # Configuration from environment variables
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("DEBUG", "false").lower() == "true"
    
    print(f"[INFO] Starting {PARSER_NAME} v{PARSER_VERSION}")
    print(f"[INFO] Listening on {host}:{port}")
    print(f"[INFO] Forwarding to: {QUIVER_HUB_URL}/api/rest/payload/{APP_ID}/ingest")
    print(f"[INFO] Endpoints:")
    print(f"       GET  /health - Health check")
    print(f"       POST /ingest - Receive and forward payload")
    print(f"       POST /parse  - Parse payload (testing only)")
    
    app.run(host=host, port=port, debug=debug)
```

## Deployment Instructions

### 1. Prepare the Parser

1. Copy the template above to your Quiver device
2. Update the `SCHEMA` to match your data structure
3. Implement your custom `parse_payload()` function
4. Set environment variables:
   ```bash
   export QUIVER_HUB_URL="https://your-hub.manus.space"
   export APP_ID="your-app-id"
   export PORT=5000
   ```

### 2. Install Dependencies

```bash
# On Quiver device
pip3 install flask requests
```

### 3. Test Locally

```bash
# Start the parser service
python3 parser_service.py

# Test with sample data
curl -X POST http://localhost:5000/parse \
  -H "Content-Type: application/json" \
  -d '{"temp_raw": 2850, "hum_raw": 6500, "press_raw": 101325}'
```

### 4. Create Systemd Service

Create `/etc/systemd/system/quiver-parser.service`:

```ini
[Unit]
Description=Quiver Edge Parser Service
After=network.target

[Service]
Type=simple
User=quiver
WorkingDirectory=/home/quiver/parser
Environment="QUIVER_HUB_URL=https://your-hub.manus.space"
Environment="APP_ID=your-app-id"
Environment="PORT=5000"
ExecStart=/usr/bin/python3 /home/quiver/parser/parser_service.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable quiver-parser
sudo systemctl start quiver-parser
sudo systemctl status quiver-parser
```

### 5. Configure Sensor/Device

Point your sensor or data source to send data to:
```
http://<quiver-device-ip>:5000/ingest
```

## Architecture

```
┌─────────────────┐
│  Sensor/Device  │
│  (RPLidar, etc) │
└────────┬────────┘
         │ Raw payload
         │ (HTTP POST)
         ▼
┌─────────────────┐
│  Quiver Device  │
│  Parser Service │
│  (Flask/Python) │
└────────┬────────┘
         │ Parsed data
         │ (HTTP POST)
         ▼
┌─────────────────┐
│   Quiver Hub    │
│  (Manus Cloud)  │
│  WebSocket ───► │ Real-time UI
└─────────────────┘
```

## Advanced Features

### Add WebSocket Broadcasting (Optional)

For local edge monitoring, add WebSocket support:

```python
from flask_socketio import SocketIO, emit

socketio = SocketIO(app, cors_allowed_origins="*")

@app.route("/ingest", methods=["POST"])
def ingest_payload():
    # ... existing code ...
    
    # Broadcast to local WebSocket clients
    socketio.emit("sensor_data", parsed_data)
    
    # ... rest of code ...

if __name__ == "__main__":
    socketio.run(app, host=host, port=port, debug=debug)
```

### Add Data Buffering

For unreliable network connections:

```python
from collections import deque
import threading
import time

# Buffer for failed forwards
forward_buffer = deque(maxlen=1000)

def forward_worker():
    """Background thread to retry failed forwards"""
    while True:
        if forward_buffer:
            raw_data = forward_buffer.popleft()
            try:
                response = requests.post(...)
                if response.status_code != 200:
                    forward_buffer.append(raw_data)
            except:
                forward_buffer.append(raw_data)
        time.sleep(1)

# Start background worker
threading.Thread(target=forward_worker, daemon=True).start()
```

### Add Logging

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/var/log/quiver-parser.log'),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)
```

## Monitoring

### Check Service Status

```bash
sudo systemctl status quiver-parser
sudo journalctl -u quiver-parser -f
```

### Health Check

```bash
curl http://localhost:5000/health
```

### View Logs

```bash
tail -f /var/log/quiver-parser.log
```

## Troubleshooting

### Parser Service Won't Start

- Check Python version: `python3 --version` (requires 3.7+)
- Verify dependencies: `pip3 list | grep -E "flask|requests"`
- Check port availability: `sudo netstat -tulpn | grep 5000`

### Data Not Reaching Quiver Hub

- Verify `QUIVER_HUB_URL` and `APP_ID` are correct
- Check network connectivity: `curl -I $QUIVER_HUB_URL`
- Review parser service logs for errors
- Test with `/parse` endpoint first to isolate parsing issues

### High CPU/Memory Usage

- Reduce logging verbosity
- Implement rate limiting
- Add data buffering with size limits
- Consider using async processing (FastAPI + asyncio)

## Example: RPLidar Forwarder Integration

For RPLidar integration, your sensor device would send point cloud data to the parser service:

```python
# On sensor device (e.g., Raspberry Pi with RPLidar)
import requests

def forward_scan(scan_data):
    requests.post(
        "http://quiver-device:5000/ingest",
        json={
            "points": scan_data,
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
    )
```

The parser service would then transform and forward to Quiver Hub for visualization.
