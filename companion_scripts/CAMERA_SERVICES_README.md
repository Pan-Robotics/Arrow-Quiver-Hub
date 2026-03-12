# SIYI A8 Mini Camera Services

This directory contains Python services for controlling the SIYI A8 mini gimbal camera and streaming video to Quiver Hub.

## Overview

The camera integration consists of three services running on the companion computer:

1. **Camera Controller** (`siyi_camera_controller.py`) — Handles gimbal control commands via the SIYI SDK protocol over TCP, connected to Quiver Hub via Socket.IO
2. **Streaming Service** (`camera_stream_service.py`) — Converts RTSP video to HLS for web delivery, registers the stream with Quiver Hub via REST API
3. **Cloudflared Tunnel** (`cloudflared-hls.service`) — Exposes the local HLS server to the internet so the Hub can proxy the stream to remote browsers

## Architecture

```
┌─────────────────┐    Socket.IO     ┌─────────────────────────────┐
│   Quiver Hub    │◄────────────────►│       Companion Pi          │
│   (Browser)     │  Commands/Status │                             │
│                 │                  │  ┌───────────────────────┐  │
│   HLS Player    │    Cloudflare    │  │  Camera Controller    │  │
│   (via proxy)   │◄───Tunnel───────►│  │  (Socket.IO client)   │  │
└─────────────────┘                  │  └──────────┬────────────┘  │
                                     │             │ TCP (SDK)     │
                                     │             ▼              │
                                     │  ┌───────────────────────┐  │
                                     │  │  Streaming Service    │  │
                                     │  │  (FFmpeg + HLS HTTP)  │  │
                                     │  └──────────┬────────────┘  │
                                     │             │ RTSP          │
                                     │  ┌──────────▼────────────┐  │
                                     │  │  Cloudflared Tunnel   │  │
                                     │  │  (port 8080 → public) │  │
                                     │  └───────────────────────┘  │
                                     └─────────────┬───────────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  SIYI A8 Mini   │
                                          │  192.168.144.25 │
                                          └─────────────────┘
```

## How the Stream Reaches the Browser

1. FFmpeg captures RTSP from the camera and outputs HLS segments to `/tmp/hls_stream/`
2. A local HTTP server (port 8080) serves the HLS playlist and segments
3. Cloudflared creates a public tunnel URL (e.g., `https://abc123.trycloudflare.com`) pointing to port 8080
4. The streaming service auto-detects the tunnel URL by querying cloudflared's metrics endpoint (`http://127.0.0.1:33843/quicktunnel`)
5. The streaming service registers the public tunnel URL with Quiver Hub via `POST /api/rest/camera/stream-register`
6. The Hub proxies HLS requests from the browser through the tunnel to the Pi

This means the Pi can be on any network (cellular, satellite, private LAN) — as long as it has outbound internet access, the stream will reach the Hub.

## Network Configuration

The SIYI A8 mini camera has a fixed IP address on the aircraft's internal network:

| Service | IP Address | Port | Protocol |
|---------|------------|------|----------|
| SDK Control | 192.168.144.25 | 37260 | TCP |
| Main Stream (4K) | 192.168.144.25 | 8554 | RTSP (`/main.264`) |
| Sub Stream (720p) | 192.168.144.25 | 8554 | RTSP (`/sub.264`) |

## Quick Start

### Prerequisites

- Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
- Python 3.9+
- FFmpeg
- Network connectivity to SIYI camera
- Outbound internet access (for cloudflared tunnel)

### Installation

1. Copy the scripts to the companion computer:
```bash
scp -r companion_scripts/ julius@<companion-ip>:/home/julius/camera_forwarder/
```

2. Run the installation script:
```bash
ssh julius@<companion-ip>
cd /home/julius/camera_forwarder
chmod +x install_camera_services.sh
sudo ./install_camera_services.sh
```

3. Follow the prompts to configure:
   - Quiver Hub URL (HTTPS, e.g., `https://rplidar-viz-cjlhozxe.manus.space`)
   - Drone ID
   - API Key

The install script will:
- Install `ffmpeg`, `python3-pip`, `cloudflared`
- Install Python dependencies (`python-socketio[asyncio_client]`, `aiohttp`, `requests`)
- Create and enable three systemd services

### Manual Installation

```bash
# Install system dependencies
sudo apt-get update
sudo apt-get install -y python3 python3-pip ffmpeg

# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared

# Install Python dependencies
pip3 install --break-system-packages 'python-socketio[asyncio_client]' aiohttp requests

# Start cloudflared tunnel (terminal 1)
cloudflared tunnel --url http://localhost:8080 --metrics localhost:33843

# Start streaming service (terminal 2)
python3 camera_stream_service.py \
  --stream sub --port 8080 \
  --hub-url https://your-hub.manus.space \
  --drone-id quiver_001 \
  --api-key YOUR_API_KEY \
  --tunnel-metrics-port 33843

# Start camera controller (terminal 3)
python3 siyi_camera_controller.py \
  --hub-url https://your-hub.manus.space \
  --drone-id quiver_001 \
  --api-key YOUR_API_KEY
```

## Camera Controller

The camera controller (`siyi_camera_controller.py`) implements the SIYI SDK binary protocol for gimbal control and connects to Quiver Hub via **Socket.IO** (not raw WebSocket).

### Supported Commands

| Action | Description | Parameters |
|--------|-------------|------------|
| `rotate` | Rotate gimbal at velocity | `yaw`, `pitch` (-100 to 100) |
| `set_angles` | Set absolute gimbal angles | `yaw` (-135 to 135), `pitch` (-90 to 25) |
| `center` | Center gimbal | None |
| `nadir` | Point gimbal straight down | None |
| `zoom` | Zoom in/out/stop | `direction` (-1, 0, 1) |
| `set_zoom` | Set specific zoom level | `level` (1.0 to 6.0) |
| `photo` | Capture photo | None |
| `record` | Start video recording | None |
| `stop_record` | Stop video recording | None |
| `focus` | Auto focus at point | `x`, `y` (0-1000) |
| `get_status` | Get current status | None |

### Command Line Options

```
--hub-url       Quiver Hub URL (HTTPS — Socket.IO handles transport upgrade)
--drone-id      Drone identifier
--api-key       API key for authentication
--test          Run in test mode (direct camera control, no Hub connection)
--debug         Enable debug logging (Socket.IO + engine.io verbose output)
```

### Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `register_companion` | Pi → Hub | Register as camera companion for a drone |
| `camera_command` | Hub → Pi | Forward gimbal/zoom/photo command from browser |
| `camera_response` | Pi → Hub | Command execution result |
| `camera_status` | Pi → Hub | Periodic status update (2 Hz) |

### Status Update Format

```json
{
  "type": "camera_status",
  "drone_id": "quiver_001",
  "connected": true,
  "timestamp": 1706000000.0,
  "attitude": { "yaw": 45.5, "pitch": -30.0, "roll": 0.0 },
  "recording": false,
  "hdr_enabled": false,
  "tf_card_present": true
}
```

## Streaming Service

The streaming service (`camera_stream_service.py`) converts RTSP to HLS using FFmpeg and registers the stream with Quiver Hub.

### Features

- Low-latency HLS output (1-second segments, 3-segment window)
- Automatic cloudflared tunnel URL detection
- Auto-registration with Quiver Hub using public tunnel URL
- Automatic reconnection on stream failure
- CORS-enabled HTTP server for cross-origin access
- Health monitoring with configurable thresholds

### Command Line Options

```
--stream              Stream type: 'main' (4K) or 'sub' (720p, default)
--port                HTTP port for HLS server (default: 8080)
--hls-dir             Directory for HLS output files
--hub-url             Quiver Hub URL for stream registration
--drone-id            Drone identifier
--api-key             API key for authentication
--tunnel-metrics-port Cloudflared metrics port for tunnel URL auto-detection (default: 33843)
--debug               Enable debug logging
```

### Tunnel Auto-Detection

On startup, the streaming service polls `http://127.0.0.1:<metrics-port>/quicktunnel` to discover the cloudflared tunnel's public URL. It retries up to 30 times (1 second apart) to allow cloudflared time to establish the tunnel. Once discovered, it registers the public URL with the Hub instead of the local LAN IP.

## Systemd Services

### Service Files

| Service | File | Description |
|---------|------|-------------|
| `cloudflared-hls` | `cloudflared-hls.service` | Cloudflare tunnel for HLS port |
| `camera-stream` | `camera-stream.service` | FFmpeg streaming + Hub registration |
| `siyi-camera` | `siyi-camera.service` | Gimbal controller + Socket.IO bridge |

### Startup Order

```
cloudflared-hls → camera-stream → siyi-camera
```

`camera-stream` depends on `cloudflared-hls` (needs the tunnel URL). `siyi-camera` is independent but typically started after the stream is up.

### Service Management

```bash
# Check status
sudo systemctl status cloudflared-hls camera-stream siyi-camera

# View logs (follow mode)
sudo journalctl -u cloudflared-hls -f
sudo journalctl -u camera-stream -f
sudo journalctl -u siyi-camera -f

# Restart all services
sudo systemctl restart cloudflared-hls camera-stream siyi-camera

# Stop all services
sudo systemctl stop siyi-camera camera-stream cloudflared-hls
```

## Troubleshooting

### Camera Not Connecting

1. Verify network connectivity:
```bash
ping 192.168.144.25
```

2. Check if SDK port is accessible:
```bash
nc -zv 192.168.144.25 37260
```

3. Verify camera is powered on and network cable is connected

### No Video Stream

1. Test RTSP stream directly:
```bash
ffplay rtsp://192.168.144.25:8554/sub.264
```

2. Check if HLS segments are being created:
```bash
ls -la /tmp/hls_stream/
```

3. Check if cloudflared tunnel is up:
```bash
curl http://127.0.0.1:33843/quicktunnel
```

4. View streaming service logs:
```bash
sudo journalctl -u camera-stream -f
```

### Stream Not Showing in Browser

1. Check if stream registered with Hub (look for "Stream registered with Hub" in logs)
2. Verify the tunnel URL is reachable from outside the Pi's network
3. Check Hub server logs for proxy errors

### Gimbal Not Responding

1. Check camera controller logs:
```bash
sudo journalctl -u siyi-camera -f
```

2. Verify Socket.IO connection (look for "Connected to Quiver Hub (Socket.IO)" in logs)

3. Ensure API key is valid and matches drone ID

## SIYI SDK Protocol Reference

The SDK uses a binary frame format:

```
| STX (2) | CTRL (1) | DATA_LEN (2) | SEQ (2) | CMD_ID (1) | DATA (N) | CRC16 (2) |
| 0x55 0x66 |   0x01   |    N bytes   |  seq++  |    cmd     |   ...    |  CRC16    |
```

CRC16 uses CRC-16-CCITT (polynomial 0x1021, initial value 0x0000).
