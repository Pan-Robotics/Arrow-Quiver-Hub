# Quiver Hub — Companion Services Reference

**Version:** April 2026
**Author:** Pan Robotics

This document covers all Python companion scripts, systemd services, and install scripts that run on the Raspberry Pi companion computer. Each service handles a specific data pipeline between the drone hardware and the Quiver Hub web server.

---

## Service Inventory

| Service Name | Script | Systemd Unit | Install Script | Purpose |
|---|---|---|---|---|
| Hub Client | `raspberry_pi_client.py` | `quiver-hub-client.service` | `install_hub_client.sh` | Job polling, file delivery, config updates |
| Telemetry Forwarder | `telemetry_forwarder.py` | `telemetry-forwarder.service` | `install_telemetry_forwarder.sh` | MAVLink + UAVCAN telemetry relay |
| Logs & OTA | `logs_ota_service.py` | `logs-ota.service` | `install_logs_ota.sh` | FC log download, OTA firmware flash, diagnostics, remote log streaming |
| Camera Stream | `camera_stream_service.py` | `camera-stream.service` | `install_camera_services.sh` | go2rtc management, Tailscale funnel, stream registration |
| SIYI Camera Controller | `siyi_camera_controller.py` | `siyi-camera.service` | `install_camera_services.sh` | Gimbal control via SIYI UDP SDK + Socket.IO |

All services are designed to run as the `alexd` user (configurable during install), auto-restart on failure, and log to journald for remote streaming via the Logs & OTA app.

---

## 1. Hub Client (`raspberry_pi_client.py`)

### Overview

A polling-based job queue client that enables two-way communication between the Quiver Hub web UI and the Raspberry Pi. The Hub creates jobs (file uploads, config changes, service restarts), and the Pi client polls for pending jobs, executes them, and reports completion. Job acknowledgement uses a **mutex lock** with a companion identifier to prevent double-execution when multiple companions poll the same drone.

### Job Types

| Job Type | Description |
|---|---|
| `upload_file` | Download a file from S3 to a target path on the Pi; supports gzip compression for Python files |
| `update_config` | Write a JSON configuration object to a specified file path |
| `restart_service` | Restart a systemd service on the Pi |

### CLI Arguments

```
--server         Quiver Hub server URL (required)
--drone-id       Unique identifier for this drone (required)
--api-key        API key for authentication (required)
--poll-interval  How often to poll for jobs in seconds (default: 5)
--companion-id   Unique companion identifier for mutex locking (default: hub_client@<hostname>)
--debug          Enable debug logging
```

### Installation

```bash
chmod +x install_hub_client.sh
./install_hub_client.sh
```

The installer prompts for the Hub URL, drone ID, and API key, then creates `forwarder.env`, copies the script, and sets up the systemd service.

### Configuration

All configuration is stored in `/home/alexd/quiver/forwarder.env`:

```bash
WEB_SERVER_URL=https://your-quiver-hub.com
API_KEY=your-api-key-here
DRONE_ID=quiver_001
```

### Workflow

1. Web UI creates a job via `droneJobs.createJob` tRPC mutation
2. Pi client polls `droneJobs.getPendingJobs` every 5 seconds
3. Pi acknowledges the job with mutex lock (`droneJobs.acknowledgeJob` + `lockedBy` companion ID)
4. If the job is already locked by another companion, the client skips it
5. Pi executes the job (download file, write config, restart service)
6. Pi reports completion or failure (`droneJobs.completeJob`)
7. Web UI shows updated job status in the Drone Configuration page

---

## 2. Telemetry Forwarder (`telemetry_forwarder.py`)

### Overview

A multi-threaded telemetry relay that reads MAVLink data from the flight controller via MAVSDK and optionally reads UAVCAN battery data via DroneCAN. Telemetry is POSTed to the Hub's REST endpoint at a configurable rate.

### Data Sources

| Source | Protocol | Data |
|---|---|---|
| Flight Controller | MAVLink via MAVSDK | Attitude (roll, pitch, yaw), position (lat, lon, alt), GPS (fix type, satellites), FC battery (voltage, current, remaining) |
| UAVCAN Battery | DroneCAN via CAN bus | Voltage, current, remaining percentage, temperature |

### CLI Arguments

```
--hub-url          Quiver Hub server URL (from env: WEB_SERVER_URL)
--api-key          API key for authentication (from env: API_KEY)
--drone-id         Drone identifier (from env: DRONE_ID)
--mavlink-url      MAVSDK connection URL (from env: MAVLINK_URL, default: serial:///dev/ttyAMA1:921600)
--can-interface    CAN interface for DroneCAN (from env: CAN_INTERFACE, optional)
--update-rate      Telemetry update rate in Hz (from env: UPDATE_RATE, default: 2)
--debug            Enable debug logging
```

### Installation

```bash
chmod +x install_telemetry_forwarder.sh
sudo ./install_telemetry_forwarder.sh
```

The installer prompts for the MAVLink connection URL (serial or UDP), optional UAVCAN battery monitoring (CAN interface), and update rate. It installs `mavsdk`, `aiohttp`, and optionally `dronecan`, then creates the systemd service.

### Configuration

All configuration is stored in `/home/alexd/quiver/forwarder.env`:

```bash
WEB_SERVER_URL=https://your-quiver-hub.com
API_KEY=your-api-key-here
DRONE_ID=quiver_001
MAVLINK_URL=serial:///dev/ttyAMA1:921600
CAN_INTERFACE=can0          # Optional, for UAVCAN battery
UPDATE_RATE=2               # Hz
```

### REST Endpoint

`POST /api/rest/telemetry/ingest` with JSON body containing `api_key`, `drone_id`, and telemetry fields (attitude, position, gps, battery, uavcan_battery).

---

## 3. Logs & OTA Service (`logs_ota_service.py`)

### Overview

A comprehensive companion service that bridges the flight controller and the Hub for four functions: FC log management, OTA firmware updates, system diagnostics, and remote log streaming. It uses MAVSDK/MAVFTP for flight controller communication and Socket.IO for real-time bidirectional data.

**Security features:** SHA-256 artefact integrity verification before firmware flash, mutex-locked job acknowledgement, automatic artefact cleanup after flash, and superuser permission checks at startup.

### Features

| Feature | Description |
|---|---|
| FC Log Scan | List log files on the FC SD card via MAVFTP directory listing |
| FC Log Download | Download `.BIN`/`.log` files from the FC via MAVFTP, upload to Hub S3 |
| OTA Firmware Flash | Download firmware from Hub S3, **verify SHA-256 hash**, upload to FC as `ardupilot.abin` via MAVFTP, monitor ArduPilot rename stages (verify → flash → flashed), **clean up temp file** |
| System Diagnostics | Collect CPU, memory, disk, temperature, network, and systemd service status every 10 seconds |
| Remote Log Streaming | Stream journalctl output from any companion service to the browser in real-time |

### Job Types

| Job Type | Trigger | Description |
|---|---|---|
| `scan_fc_logs` | FC Logs tab → "Scan FC Logs" button | Lists `/APM/LOGS/` directory and reports discovered files |
| `download_fc_log` | FC Logs tab → download button on a log row | Downloads the file to a temp directory, then uploads base64 content to Hub |
| `flash_firmware` | OTA tab → "Flash to FC" button | Downloads firmware from S3, **verifies SHA-256 hash** against server-computed value, uploads to FC, monitors rename stages, cleans up temp file |

### CLI Arguments

```
--hub-url          Quiver Hub server URL (required)
--api-key          API key for authentication (required)
--drone-id         Drone identifier (required)
--fc-connection    MAVSDK connection URL (default: serial:///dev/ttyAMA1:921600)
--poll-interval    Job polling interval in seconds (default: 5)
--diag-interval    Diagnostics reporting interval in seconds (default: 10)
--no-fc            Run without flight controller connection (diagnostics + log streaming only)
--allow-non-root   Allow running as non-root (some features may not work)
--debug            Enable debug logging
```

### Installation

```bash
chmod +x install_logs_ota.sh
sudo ./install_logs_ota.sh
```

The installer prompts for the FC connection type (serial, UDP, or no-FC mode) and permission level (run as root for full functionality, or as service user with group membership). It installs `mavsdk`, `aiohttp`, `psutil`, and `python-socketio`, then creates the systemd service with security hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`).

### Monitored Services

The diagnostics collector checks the status of these systemd services:

- `telemetry-forwarder.service`
- `logs-ota.service`
- `camera-stream.service`
- `siyi-camera.service`
- `quiver-hub-client.service`
- `go2rtc.service`
- `tailscale-funnel.service`

### Class Structure

| Class | Responsibility |
|---|---|
| `HubClient` | REST + tRPC communication with the Hub server |
| `MavFtpClient` | MAVSDK FTP operations (list, download, upload, exists, remove) |
| `LogsOtaJobHandler` | Implements scan, download, and flash job handlers |
| `DiagnosticsCollector` | System health metrics via psutil + systemctl |
| `RemoteLogStreamer` | Manages journalctl subprocess streams via Socket.IO |
| `LogsOtaService` | Main orchestrator — FC connection, job polling, diagnostics loop |

---

## 4. Camera Services

### Camera Stream (`camera_stream_service.py`)

Manages the video streaming pipeline from the SIYI A8 Mini camera to the browser:

1. Monitors go2rtc health via its HTTP API
2. Auto-detects the Tailscale funnel URL by querying `tailscale status`
3. Registers the WebRTC signaling URL with the Quiver Hub
4. Handles graceful shutdown (unregisters stream)

### SIYI Camera Controller (`siyi_camera_controller.py`)

Controls the SIYI A8 Mini gimbal via its UDP SDK (port 37260):

- Connects to the Quiver Hub via Socket.IO
- Receives gimbal commands (rotate, zoom, photo, record, center, nadir)
- Sends camera status updates (attitude, zoom level, recording state)

### Camera Architecture

```
SIYI A8 Mini ──RTSP──▶ go2rtc ──WebRTC──▶ Browser
(192.168.144.25)       (port 1984)    (peer-to-peer UDP)
                            │
                   Tailscale Funnel
                   (HTTPS signaling)
```

Video flows peer-to-peer via WebRTC. Only the SDP signaling goes through the Tailscale funnel. No video is proxied through the Hub.

### Camera Controller Commands

| Action | Description | Parameters |
|---|---|---|
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

### Network Configuration

| Service | IP Address | Port | Protocol |
|---|---|---|---|
| SIYI SDK Control | 192.168.144.25 | 37260 | UDP |
| Main Stream (4K) | 192.168.144.25 | 8554 | RTSP (`/main.264`) |
| Sub Stream (720p) | 192.168.144.25 | 8554 | RTSP (`/sub.264`) |
| go2rtc API | localhost | 1984 | HTTP |
| go2rtc WebRTC | 0.0.0.0 | 8555 | UDP |

### Installation

```bash
chmod +x install_camera_services.sh
sudo ./install_camera_services.sh
```

The installer handles go2rtc binary installation (auto-detects ARM64/ARM/AMD64), Tailscale authentication and funnel setup, go2rtc configuration, and all four camera-related systemd services.

### Camera Systemd Services

| Service | Description | Dependencies |
|---|---|---|
| `go2rtc.service` | RTSP → WebRTC streaming server | network |
| `tailscale-funnel.service` | Exposes go2rtc API to internet | tailscaled, go2rtc |
| `siyi-camera.service` | Gimbal controller (Socket.IO) | network |
| `camera-stream.service` | Stream manager + Hub registration | go2rtc, tailscale-funnel |

Startup order: `go2rtc` → `tailscale-funnel` → `camera-stream` (parallel: `siyi-camera`)

---

## 5. Deployment

### Prerequisites

All companion scripts require Python 3.7+ on the Raspberry Pi. Each install script handles its own dependencies.

### Recommended Install Order

1. **Hub Client** — required for all job-based operations
2. **Telemetry Forwarder** — required for live flight telemetry
3. **Camera Services** — required for video streaming and gimbal control
4. **Logs & OTA** — required for FC log management, firmware updates, and diagnostics

### Copying Files to the Pi

```bash
# Copy all companion scripts to the Pi
scp companion_scripts/*.py companion_scripts/*.sh companion_scripts/*.service \
    alexd@your-pi-ip:/home/alexd/

# SSH in and run the install scripts
ssh alexd@your-pi-ip
```

### Service Management

```bash
# Check status of all services
sudo systemctl status quiver-hub-client telemetry-forwarder logs-ota \
    camera-stream siyi-camera go2rtc tailscale-funnel

# View live logs for a specific service
sudo journalctl -u logs-ota -f

# Restart a service
sudo systemctl restart telemetry-forwarder

# Stop all Quiver services
sudo systemctl stop quiver-hub-client telemetry-forwarder logs-ota \
    siyi-camera camera-stream tailscale-funnel go2rtc
```

### Updating a Script

```bash
# Stop the service
sudo systemctl stop logs-ota

# Copy the new version
scp logs_ota_service.py alexd@your-pi-ip:/home/alexd/quiver/

# Restart
sudo systemctl start logs-ota

# Verify
sudo journalctl -u logs-ota -f
```

---

## 6. Troubleshooting

### Service Won't Start

```bash
# Check Python version (must be 3.7+)
python3 --version

# Check if required packages are installed
python3 -c "import mavsdk; import aiohttp; import psutil; print('OK')"

# Check service logs for the specific error
sudo journalctl -u <service-name> -n 50 --no-pager
```

### Can't Connect to Hub

```bash
# Test network connectivity
curl -I https://your-quiver-hub.com

# Verify forwarder.env
cat /home/alexd/quiver/forwarder.env

# Ensure WEB_SERVER_URL is the base URL (no trailing /api/rest/...)
# Ensure API_KEY matches the drone's key in the Quiver Hub web UI
```

### FC Connection Fails (Logs & OTA / Telemetry)

```bash
# Check serial port exists
ls -la /dev/ttyAMA1

# Check serial port permissions
sudo usermod -a -G dialout alexd

# Test with MAVSDK directly
python3 -c "
import asyncio
from mavsdk import System
async def test():
    drone = System()
    await drone.connect(system_address='serial:///dev/ttyAMA1:921600')
    print('Connected')
asyncio.run(test())
"
```

### No Video in Browser

```bash
# Check go2rtc is running
sudo systemctl status go2rtc
curl http://localhost:1984/api/streams

# Check Tailscale funnel
tailscale funnel status

# Check stream registration
sudo journalctl -u camera-stream -f
```

### Gimbal Not Responding

```bash
# Check camera controller service
sudo systemctl status siyi-camera

# Verify camera IP
ping 192.168.144.25

# Check Socket.IO connection
sudo journalctl -u siyi-camera -f
```

---

## 7. Security

All services follow these security practices:

- **Mutex-locked job acknowledgement:** Both `raspberry_pi_client.py` and `logs_ota_service.py` send a `lockedBy` companion identifier when acknowledging jobs. The server uses an atomic compare-and-swap (only update if status is still `pending`) to prevent double-execution.
- **SHA-256 artefact integrity:** Firmware uploads are hashed server-side at upload time. The companion verifies the hash after downloading from S3 and before flashing to the flight controller. A mismatch aborts the flash with a `hash_verification_failed` error.
- **Artefact cleanup:** Downloaded firmware temp files are deleted in a `finally` block after flash completes or fails, preventing stale artefacts from accumulating on the Pi.
- **Job timeout reaper:** The Hub server runs a 60-second interval reaper that resets stuck `in_progress` jobs back to `pending` (with retry counting) or marks them as permanently failed after `maxRetries` is exceeded.
- **Job expiry:** Pending jobs with an `expiresAt` timestamp are automatically expired by the reaper if they are never picked up.
- **Superuser check:** `logs_ota_service.py` warns at startup if not running as root (needed for journalctl, systemctl, serial port access). Use `--allow-non-root` to suppress.
- **Systemd hardening:** Install scripts configure `ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, and restricted `ReadWritePaths`.
- API keys are stored in `forwarder.env` with restricted file permissions
- All Hub communication uses HTTPS
- API keys should be rotated regularly via the Quiver Hub web UI

---

## 8. SIYI SDK Protocol Reference

The SIYI A8 Mini uses a binary frame format over UDP:

```
| STX (2) | CTRL (1) | DATA_LEN (2) | SEQ (2) | CMD_ID (1) | DATA (N) | CRC16 (2) |
| 0x55 0x66 |   0x01   |    N bytes   |  seq++  |    cmd     |   ...    |  CRC16    |
```

CRC16 uses CRC-16-CCITT (polynomial 0x1021, initial value 0x0000).
