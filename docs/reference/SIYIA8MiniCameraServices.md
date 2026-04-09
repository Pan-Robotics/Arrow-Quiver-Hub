# SIYI A8 Mini Camera Services

This directory contains Python services for controlling the SIYI A8 mini gimbal camera and streaming video to Quiver Hub.

## Overview

The camera integration consists of two services running on the companion computer:

1. **Camera Controller** (`siyi_camera_controller.py`) - Handles gimbal control commands via the SIYI SDK protocol over TCP
2. **Streaming Service** (`camera_stream_service.py`) - Converts RTSP video to HLS for web delivery

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   Quiver Hub    │◄──────────────────►│   Companion Pi  │
│   (Frontend)    │    Commands/Status │                 │
└─────────────────┘                    │  ┌───────────┐  │
                                       │  │  Camera   │  │
                                       │  │Controller │  │
                                       │  └─────┬─────┘  │
                                       │        │TCP     │
                                       │        ▼        │
┌─────────────────┐     RTSP           │  ┌───────────┐  │
│   HLS Player    │◄───────────────────│  │ Streaming │  │
│   (Browser)     │    Video Stream    │  │  Service  │  │
└─────────────────┘                    │  └─────┬─────┘  │
                                       │        │RTSP    │
                                       └────────┼────────┘
                                                │
                                       ┌────────▼────────┐
                                       │  SIYI A8 Mini   │
                                       │  192.168.144.25 │
                                       └─────────────────┘
```

## Network Configuration

The SIYI A8 mini camera has a fixed IP address on the aircraft's internal network:

| Service | IP Address | Port | Protocol |
|---------|------------|------|----------|
| SDK Control | 192.168.144.25 | 37260 | TCP |
| Main Stream (4K) | 192.168.144.25 | 8554 | RTSP |
| Sub Stream (720p) | 192.168.144.25 | 8554 | RTSP |

RTSP URLs:
- Main: `rtsp://192.168.144.25:8554/video1`
- Sub: `rtsp://192.168.144.25:8554/video2`

## Quick Start

### Prerequisites

- Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit)
- Python 3.9+
- FFmpeg
- Network connectivity to SIYI camera

### Installation

1. Copy the scripts to the companion computer:
```bash
scp -r companion_scripts/ pi@<companion-ip>:/home/pi/quiver/
```

2. Run the installation script:
```bash
ssh pi@<companion-ip>
cd /home/pi/quiver
chmod +x install_camera_services.sh
sudo ./install_camera_services.sh
```

3. Follow the prompts to configure:
   - Quiver Hub WebSocket URL
   - Drone ID
   - API Key

### Manual Installation

If you prefer manual installation:

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y python3 python3-pip ffmpeg
pip3 install --break-system-packages python-socketio[client] aiohttp websockets

# Run camera controller
python3 siyi_camera_controller.py \
  --hub-url wss://your-hub.manus.space/socket.io/ \
  --drone-id quiver_001 \
  --api-key YOUR_API_KEY

# Run streaming service (in another terminal)
python3 camera_stream_service.py --stream sub --port 8080
```

## Camera Controller

The camera controller (`siyi_camera_controller.py`) implements the SIYI SDK binary protocol for gimbal control.

### Supported Commands

| Command | Description | Parameters |
|---------|-------------|------------|
| `gimbal_rotate` | Rotate gimbal | `yaw_speed`, `pitch_speed` (-100 to 100) |
| `gimbal_center` | Center gimbal | None |
| `gimbal_down` | Point gimbal straight down | None |
| `zoom_in` | Increase zoom | None |
| `zoom_out` | Decrease zoom | None |
| `zoom_set` | Set specific zoom level | `level` (1.0 to 6.0) |
| `take_photo` | Capture photo | None |
| `start_recording` | Start video recording | None |
| `stop_recording` | Stop video recording | None |
| `get_attitude` | Get current gimbal angles | None |

### Command Line Options

```
--camera-ip     SIYI camera IP address (default: 192.168.144.25)
--camera-port   SIYI SDK port (default: 37260)
--hub-url       Quiver Hub WebSocket URL
--drone-id      Drone identifier
--api-key       API key for authentication
--status-interval  Status broadcast interval in seconds (default: 1.0)
```

### Status Updates

The controller broadcasts camera status to Quiver Hub every second:

```json
{
  "drone_id": "quiver_001",
  "timestamp": 1706000000,
  "connected": true,
  "attitude": {
    "yaw": 45.5,
    "pitch": -30.0,
    "roll": 0.0
  },
  "recording": false,
  "hdr_enabled": false,
  "tf_card_present": true,
  "zoom_level": 1.0
}
```

## Streaming Service

The streaming service (`camera_stream_service.py`) converts RTSP to HLS using FFmpeg.

### Features

- Low-latency HLS output (1-second segments)
- Automatic reconnection on stream failure
- CORS-enabled HTTP server for cross-origin access
- Health monitoring

### Command Line Options

```
--stream    Stream type: 'main' (4K) or 'sub' (720p, default)
--port      HTTP port for HLS server (default: 8080)
--hls-dir   Directory for HLS output files
```

### HLS Output

The service creates:
- `stream.m3u8` - HLS playlist
- `segment_XXX.ts` - Video segments (1 second each)

Access the stream at: `http://<companion-ip>:8080/stream.m3u8`

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
ffplay rtsp://192.168.144.25:8554/video2
```

2. Check FFmpeg installation:
```bash
ffmpeg -version
```

3. View streaming service logs:
```bash
sudo journalctl -u camera-stream -f
```

### Gimbal Not Responding

1. Check camera controller logs:
```bash
sudo journalctl -u siyi-camera -f
```

2. Verify WebSocket connection to Quiver Hub

3. Ensure API key is valid and matches drone ID

## Service Management

```bash
# Check status
sudo systemctl status siyi-camera
sudo systemctl status camera-stream

# View logs
sudo journalctl -u siyi-camera -f
sudo journalctl -u camera-stream -f

# Restart services
sudo systemctl restart siyi-camera
sudo systemctl restart camera-stream

# Stop services
sudo systemctl stop siyi-camera
sudo systemctl stop camera-stream
```

## SIYI SDK Protocol Reference

The SDK uses a binary frame format:

```
| STX (2) | CTRL (1) | DATA_LEN (2) | SEQ (2) | CMD_ID (1) | DATA (N) | CRC16 (2) |
| 0x55 0x66 |   0x01   |    N bytes   |  seq++  |    cmd     |   ...    |  CRC16    |
```

### Command IDs

| ID | Command |
|----|---------|
| 0x01 | Firmware Version |
| 0x02 | Hardware ID |
| 0x0A | Auto Focus |
| 0x0C | Manual Zoom |
| 0x0D | Absolute Zoom |
| 0x0E | Max Zoom |
| 0x0F | Focus Value |
| 0x10 | Gimbal Rotation |
| 0x0D | Center Gimbal |
| 0x14 | Gimbal Info |
| 0x15 | Function Feedback |
| 0x19 | Photo/Video |
| 0x1A | Gimbal Attitude |

### CRC16 Calculation

Uses CRC-16-CCITT (polynomial 0x1021, initial value 0x0000).
