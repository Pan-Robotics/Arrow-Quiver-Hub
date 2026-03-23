# SIYI A8 Mini Camera Services — WebRTC + Tailscale Architecture

## Overview

This system streams video from a SIYI A8 Mini gimbal camera on a Raspberry Pi companion computer to a remote browser via WebRTC, with sub-second latency. Camera gimbal controls (pan, tilt, zoom, photo, record) flow from the browser through the Quiver Hub to the companion via Socket.IO.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Raspberry Pi (Companion Computer)                          │
│                                                             │
│  SIYI A8 Mini ──RTSP──▶ go2rtc ──WebRTC──▶ Browser         │
│  (192.168.144.25)       (port 1984)    (peer-to-peer UDP)   │
│                              │                              │
│                     Tailscale Funnel                        │
│                     (HTTPS signaling)                       │
│                              │                              │
│  siyi_camera_controller.py ──Socket.IO──▶ Quiver Hub        │
│  (gimbal control via UDP SDK)                               │
│                                                             │
│  camera_stream_service.py                                   │
│  (manages go2rtc, detects funnel URL, registers with Hub)   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Cloud (Quiver Hub)                                         │
│                                                             │
│  Stores WebRTC signaling URL per drone                      │
│  Relays gimbal commands (browser → companion via Socket.IO) │
│  Relays camera status (companion → browser via Socket.IO)   │
│  No video proxying — media flows peer-to-peer               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│                                                             │
│  Gets WebRTC URL from Hub → WHEP signaling via funnel       │
│  Receives video via WebRTC (UDP peer-to-peer)               │
│  Sends gimbal commands via Socket.IO through Hub            │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

| Flow | Protocol | Path |
|------|----------|------|
| Video (RTSP ingest) | RTSP/TCP | Camera → go2rtc |
| Video (to browser) | WebRTC/UDP | go2rtc → Browser (peer-to-peer via STUN) |
| WebRTC signaling | HTTPS | Browser → Tailscale funnel → go2rtc |
| Stream registration | HTTPS REST | camera_stream_service.py → Quiver Hub |
| Gimbal commands | Socket.IO | Browser → Hub → siyi_camera_controller.py |
| Camera status | Socket.IO | siyi_camera_controller.py → Hub → Browser |

## Components

### go2rtc

A single binary that converts RTSP to WebRTC natively. No FFmpeg needed. Configured via `go2rtc.yaml` to ingest from the SIYI camera's RTSP stream and serve WebRTC on port 1984 (API) and port 8555 (WebRTC UDP).

### Tailscale Funnel

Exposes go2rtc's HTTP API (port 1984) to the internet via a stable HTTPS URL (e.g., `https://quiver.tail1234.ts.net`). Only signaling traffic (SDP offer/answer) goes through the funnel. Actual video flows peer-to-peer via UDP.

### camera_stream_service.py

Manages the streaming pipeline:
- Monitors go2rtc health via its API
- Auto-detects the Tailscale funnel URL by querying `tailscale status`
- Registers the WebRTC signaling URL with the Quiver Hub
- Handles graceful shutdown (unregisters stream)

### siyi_camera_controller.py

Controls the SIYI A8 Mini gimbal via its UDP SDK (port 37260):
- Connects to the Quiver Hub via Socket.IO
- Receives gimbal commands (rotate, zoom, photo, record, center, nadir)
- Sends camera status updates (attitude, zoom level, recording state)

## Network Configuration

| Service | IP Address | Port | Protocol |
|---------|------------|------|----------|
| SDK Control | 192.168.144.25 | 37260 | UDP |
| Main Stream (4K) | 192.168.144.25 | 8554 | RTSP (`/main.264`) |
| Sub Stream (720p) | 192.168.144.25 | 8554 | RTSP (`/sub.264`) |
| go2rtc API | localhost | 1984 | HTTP |
| go2rtc WebRTC | 0.0.0.0 | 8555 | UDP |

## Installation

```bash
chmod +x install_camera_services.sh
sudo ./install_camera_services.sh
```

The install script handles:
1. Installing go2rtc binary (auto-detects ARM64/ARM/AMD64)
2. Installing Tailscale (if not present) and authenticating
3. Setting up Tailscale funnel (auto-detects hostname)
4. Creating go2rtc configuration
5. Installing all systemd services
6. Starting everything

## Systemd Services

| Service | Description | Dependencies |
|---------|-------------|--------------|
| `go2rtc.service` | RTSP→WebRTC streaming server | network |
| `tailscale-funnel.service` | Exposes go2rtc API to internet | tailscaled, go2rtc |
| `siyi-camera.service` | Gimbal controller (Socket.IO) | network |
| `camera-stream.service` | Stream manager + Hub registration | go2rtc, tailscale-funnel |

Startup order: `go2rtc` → `tailscale-funnel` → `camera-stream` (parallel: `siyi-camera`)

### Service Management

```bash
# Check status
sudo systemctl status go2rtc camera-stream siyi-camera tailscale-funnel

# View logs (follow mode)
sudo journalctl -u go2rtc -f
sudo journalctl -u camera-stream -f
sudo journalctl -u siyi-camera -f

# Restart all services
sudo systemctl restart go2rtc tailscale-funnel camera-stream siyi-camera

# Stop all services
sudo systemctl stop siyi-camera camera-stream tailscale-funnel go2rtc
```

## Camera Controller Commands

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

## Troubleshooting

**No video in browser:**
1. Check go2rtc is running: `sudo systemctl status go2rtc`
2. Check go2rtc can reach camera: `curl http://localhost:1984/api/streams`
3. Check Tailscale funnel: `tailscale funnel status`
4. Check stream is registered: `sudo journalctl -u camera-stream -f`

**High latency:**
- Ensure WebRTC is using UDP (not TCP fallback)
- Check STUN connectivity — symmetric NAT may force TURN relay
- Use `sub` stream (720p) instead of `main` (4K) to reduce encoding load

**Gimbal not responding:**
1. Check siyi-camera service: `sudo systemctl status siyi-camera`
2. Verify camera IP: `ping 192.168.144.25`
3. Check Socket.IO connection in logs: `sudo journalctl -u siyi-camera -f`

**Tailscale funnel not working:**
1. Verify Tailscale is connected: `tailscale status`
2. Check funnel is enabled: `tailscale funnel status`
3. Ensure your Tailscale plan supports funnel (free tier includes it)
4. Check DNS propagation: `curl https://your-hostname.ts.net`

## SIYI SDK Protocol Reference

The SDK uses a binary frame format over UDP:

```
| STX (2) | CTRL (1) | DATA_LEN (2) | SEQ (2) | CMD_ID (1) | DATA (N) | CRC16 (2) |
| 0x55 0x66 |   0x01   |    N bytes   |  seq++  |    cmd     |   ...    |  CRC16    |
```

CRC16 uses CRC-16-CCITT (polynomial 0x1021, initial value 0x0000).
