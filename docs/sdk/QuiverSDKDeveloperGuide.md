# Quiver SDK Developer Guide

**Version:** April 2026 | **Author:** Pan Robotics

---

## 1. System Overview

Quiver Hub is a cloud-hosted web application that provides real-time visualization, remote management, and data logging for UAV operations. The companion computer (Raspberry Pi) runs Python services that bridge the flight controller, payload devices, and Hub over HTTPS and WebSocket. Operators interact through the Hub web UI; the companion computer handles all local hardware communication and data forwarding autonomously.

The system supports five concurrent data pipelines: telemetry (MAVLink + UAVCAN), point cloud (LiDAR), camera (WebRTC via go2rtc), FC logs and OTA firmware, and custom payload apps. Each pipeline has a dedicated companion service, REST endpoint, and WebSocket broadcast channel.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        QUIVER HUB (Cloud)                       │
│  React UI · tRPC · REST API · Socket.IO · S3 · TiDB            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS / WSS (cellular or WiFi)
┌──────────────────────────┴──────────────────────────────────────┐
│              COMPANION COMPUTER  (Raspberry Pi)                  │
│  192.168.144.50                                                  │
│                                                                  │
│  Services:                                                       │
│    raspberry_pi_client.py   — Job polling & file delivery        │
│    telemetry_forwarder.py   — MAVLink + UAVCAN → Hub            │
│    logs_ota_service.py      — FC logs, OTA, diagnostics          │
│    camera_stream_service.py — go2rtc + Tailscale stream mgmt     │
│    siyi_camera_controller.py— Gimbal control (SIYI UDP SDK)      │
│                                                                  │
│  Connects to FC via Ethernet (MAVLink) and CAN bus (DroneCAN)    │
└──────────┬──────────────────────────────┬───────────────────────┘
           │ Ethernet                     │ CAN bus
┌──────────┴──────────┐     ┌─────────────┴───────────────────────┐
│  FLIGHT CONTROLLER  │     │  PAYLOAD PORTS (C1 / C2 / C3)       │
│  192.168.144.51     │     │  Ethernet: 192.168.144.100–.199     │
│  ArduPilot + Lua    │     │  CAN: DroneCAN protocol             │
│  net_webserver.lua  │     │  Sensors, cameras, actuators        │
│  (port 8080)        │     └─────────────────────────────────────┘
└─────────────────────┘
```

---

## 3. Network Configuration

The Quiver network is flat — no DHCP runs on the Pi (Siyi firmware conflicts with DHCP servers). All IPs are static on the `192.168.144.0/24` subnet.

### Reserved Addresses (Do Not Use)

| IP | Device |
|---|---|
| 192.168.144.11 | Siyi air unit |
| 192.168.144.12 | Siyi ground unit |
| 192.168.144.20 | Android GCS (Siyi reserved) |
| 192.168.144.25 | Siyi A8 Mini camera |
| 192.168.144.60 | Siyi camera reserved |
| 192.168.144.50 | Raspberry Pi (companion computer) |
| 192.168.144.51 | Flight controller |

### Payload Port Assignments

Developer-assigned static range: `192.168.144.100` – `192.168.144.199`

| Port | Recommended IP |
|---|---|
| Bottom (J31) | 192.168.144.100 |
| Side 1 (J29) | 192.168.144.101 |
| Side 2 (J30) | 192.168.144.102 |

### Key Connections

| Path | Protocol | Details |
|---|---|---|
| Companion → Hub | HTTPS + WSS | REST API, Socket.IO (cellular/WiFi) |
| Companion → FC | Ethernet (MAVLink) | `192.168.144.51`, also CAN bus for DroneCAN |
| Companion → FC Web Server | HTTP | `http://192.168.144.51:8080` (net_webserver.lua, FC log access) |
| Companion → Payloads | Ethernet | `192.168.144.100–.199` via integrated switch |
| Companion → Siyi Camera | Ethernet | `192.168.144.25` (RTSP stream + UDP SDK) |
| Mission Planner → FC | RF telemetry | 915 MHz / 433 MHz radio (MAVLink) |

---

## 4. Companion Services

All services run as systemd units under the `alexd` user, auto-restart on failure, and log to journald. Configuration lives in `/home/alexd/quiver/forwarder.env`.

### 4.1 Hub Client (`raspberry_pi_client.py`)

Polls Hub for pending jobs every 5 seconds, executes them locally, reports completion. Uses mutex locking (`lockedBy` companion ID) to prevent double-execution across multiple companions.

**Job types:** `upload_file` (S3 → local path), `update_config` (JSON write), `restart_service` (systemd restart).

```
CLI: python3 raspberry_pi_client.py \
       --server $QUIVER_HUB_URL --drone-id $DRONE_ID \
       --api-key $API_KEY --poll-interval 5 --debug
```

### 4.2 Telemetry Forwarder (`telemetry_forwarder.py`)

Three-thread architecture: MAVLink thread (MAVSDK async), UAVCAN thread (dronecan node), HTTP thread (POST at 10 Hz). Aggregates attitude, position, GPS, battery, flight mode, and armed status into a thread-safe dictionary and streams to Hub.

```
Flow: FC (MAVLink) ──┐
                      ├→ TelemetryDict → HTTP Queue → POST /api/rest/telemetry/ingest
      Battery (CAN) ──┘   (lock-protected)  (10 Hz)
```

### 4.3 Logs & OTA Service (`logs_ota_service.py`)

Manages FC log discovery, download, upload, OTA firmware flashing, system diagnostics, and remote log streaming. Key classes:

| Class | Role |
|---|---|
| `LogsOtaService` | Main orchestrator — starts all subsystems, manages Socket.IO connection |
| `FCLogSyncer` | Background sync loop — discovers FC logs via HTTP (`net_webserver.lua` on port 8080), caches locally, three-tier resolution: local cache → HTTP → MAVFTP |
| `DiagnosticsCollector` | Collects CPU/memory/disk/network stats + FC web server health check (HTTP HEAD ping), reports every cycle |
| `HubClient` | REST/tRPC client for reporting log lists, progress, uploads, diagnostics |
| `CompanionSocketManager` | Socket.IO connection for real-time job dispatch and log streaming |

**Job types:** `scan_fc_logs`, `download_fc_log`, `flash_firmware`.

**FC log upload:** Prefers multipart (`/api/rest/logs/fc-upload-multipart`) with automatic fallback to base64 JSON (`/api/rest/logs/fc-upload`).

```
CLI: python3 logs_ota_service.py \
       --server $QUIVER_HUB_URL --drone-id $DRONE_ID \
       --api-key $API_KEY --fc-webserver-url http://192.168.144.51:8080 \
       --log-store-dir /var/lib/quiver/fc_logs --debug
```

### 4.4 Camera Stream Service (`camera_stream_service.py`)

Manages go2rtc process lifecycle, Tailscale funnel for public WHEP access, and stream registration with Hub. Monitors Siyi camera availability and auto-registers/unregisters streams.

### 4.5 SIYI Camera Controller (`siyi_camera_controller.py`)

Bridges Hub Socket.IO commands to the Siyi gimbal via UDP SDK (`192.168.144.25:37260`). Supports pan/tilt, zoom, photo capture, video record, and gimbal mode switching.

---

## 5. Hub REST API — Complete Endpoint Reference

All REST endpoints require the `x-api-key` header (API key generated in Hub Drone Configuration page) unless noted otherwise.

### Core Data Pipelines

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/rest/pointcloud/ingest` | Ingest RPLidar point cloud scans |
| POST | `/api/rest/telemetry/ingest` | Ingest MAVLink + UAVCAN telemetry |
| POST | `/api/rest/payload/{appId}/ingest` | Ingest custom app payload data |

### Camera Pipeline

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/rest/camera/status` | Report camera status/metadata |
| POST | `/api/rest/camera/stream-register` | Register a WebRTC stream URL |
| POST | `/api/rest/camera/stream-unregister` | Unregister a stream |
| GET | `/api/rest/camera/stream-status/{droneId}` | Get stream status |
| POST | `/api/rest/camera/whep-proxy/{droneId}` | WHEP signaling proxy for WebRTC playback |

### Logs & OTA Pipeline

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/rest/logs/fc-list` | Report discovered FC log list |
| POST | `/api/rest/logs/fc-progress` | Report download/upload progress |
| POST | `/api/rest/logs/fc-upload` | Upload FC log (base64 JSON — legacy fallback) |
| POST | `/api/rest/logs/fc-upload-multipart` | Upload FC log (multipart form — preferred) |
| GET | `/api/rest/logs/fc-download/{logId}` | Download FC log to browser (session-auth, not API key) |
| POST | `/api/rest/firmware/progress` | Report firmware flash progress |
| POST | `/api/rest/diagnostics/report` | Report system diagnostics + FC web server health |

### Flight Analytics & System

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/rest/flightlog/upload` | Upload flight log for analysis (browser-only) |
| GET | `/api/rest/health` | Health check |
| POST | `/api/rest/test-connection` | Test API key + drone connectivity |

### tRPC Job Polling

| Procedure | Purpose |
|---|---|
| `droneJobs.getPendingJobs` | Poll for pending jobs assigned to this drone |
| `droneJobs.acknowledgeJob` | Lock a job for execution (mutex) |
| `droneJobs.completeJob` | Report job success + result data |
| `droneJobs.failJob` | Report job failure + error message |

---

## 6. WebSocket Events (Socket.IO)

Connect to `wss://<hub-url>` with Socket.IO client. Events are organized by direction.

### Client → Hub (Subscribe)

| Event | Payload | Purpose |
|---|---|---|
| `subscribe` | `{droneId}` | Subscribe to a drone's data channels |
| `unsubscribe` | `{droneId}` | Unsubscribe |
| `subscribe_app` | `{appId}` | Subscribe to custom app data |
| `subscribe_camera` | `{droneId}` | Subscribe to camera events |
| `subscribe_logs` | `{droneId}` | Subscribe to FC log events |
| `subscribe_stream` | `{droneId}` | Subscribe to log stream lines |

### Client → Hub (Commands)

| Event | Payload | Purpose |
|---|---|---|
| `camera_command` | `{droneId, command, params}` | Send gimbal/camera command |
| `log_stream_request` | `{droneId, service, lines}` | Request journald log stream |

### Companion → Hub

| Event | Payload | Purpose |
|---|---|---|
| `register_companion` | `{droneId, apiKey, companionId}` | Register companion connection |
| `camera_status` | `{droneId, ...status}` | Report camera status |
| `camera_response` | `{droneId, ...response}` | Respond to camera command |
| `log_stream_line` | `{droneId, service, line}` | Stream journald log line |

### Hub → Client (Broadcasts)

| Event | Data | Purpose |
|---|---|---|
| `pointcloud_update` | Point cloud frame | New LiDAR scan available |
| `telemetry_update` | Telemetry snapshot | New telemetry data |
| `app_data` | Parsed payload | Custom app data update |
| `camera_status` | Camera state | Camera status change |
| `camera_stream` | Stream info | Stream registered/unregistered |
| `fc_log_progress` | Progress object | FC log download/upload progress |
| `firmware_progress` | Progress object | Firmware flash progress |
| `diagnostics` | System stats + fcWebserver | Diagnostics report (includes FC web server health) |
| `log_stream` | Log line | Journald log stream line |

---

## 7. Play-by-Play: Setting Up a New Drone

This section walks through the complete setup sequence from bare hardware to a fully connected drone streaming data to Hub.

### Step 1: Generate API Key

Open Quiver Hub → Drone Configuration → select or create a drone → API Keys section → click "Generate Key". Copy the key — it is shown only once.

### Step 2: Configure the .env File

On the Raspberry Pi, create `/home/alexd/quiver/forwarder.env`:

```
QUIVER_HUB_URL=https://your-quiver-hub.com
QUIVER_DRONE_ID=quiver_001
QUIVER_API_KEY=<paste-key-here>
FC_WEBSERVER_URL=http://192.168.144.51:8080
FC_LOG_STORE_DIR=/var/lib/quiver/fc_logs
```

The Drone Configuration page in Hub has a ".env File" card that generates this file with all endpoints pre-filled. Copy it directly.

### Step 3: Install Companion Services

Run the install scripts in order. Each prompts for Hub URL, drone ID, and API key, then creates the systemd service.

```bash
cd /home/alexd/quiver/companion_scripts
chmod +x install_*.sh

./install_hub_client.sh          # Job polling
./install_telemetry_forwarder.sh # Telemetry streaming
./install_logs_ota.sh            # FC logs + OTA + diagnostics
./install_camera_services.sh     # Camera stream + SIYI controller
```

### Step 4: Verify Connectivity

```bash
# Check all services are running
sudo systemctl status quiver-hub-client telemetry-forwarder logs-ota camera-stream siyi-camera

# Test Hub connectivity
curl -X POST https://your-hub.com/api/rest/test-connection \
  -H "x-api-key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"droneId":"quiver_001"}'

# Test FC web server (from Pi)
curl -I http://192.168.144.51:8080/

# Check CAN bus
sudo ip link set can0 up type can bitrate 1000000
candump can0  # should show DroneCAN traffic
```

### Step 5: Verify in Hub UI

Open Quiver Hub in a browser. You should see:

1. **Telemetry App** — Attitude indicator, position, GPS, battery updating in real-time
2. **RPLidar App** — Point cloud rendering (if LiDAR connected)
3. **Camera App** — Live WebRTC stream (if camera configured)
4. **Logs & OTA App** — FC web server health indicator (green dot), discovered FC logs after first scan
5. **Drone Configuration** — "Connected" badge, test connection success

### Step 6: Dispatch a Job (Optional)

From Drone Configuration → Job History → create a job:

- **Scan FC Logs:** Triggers the companion to discover all FC log files and report them to Hub
- **Download FC Log:** Downloads a specific log from FC → uploads to Hub S3 → available for browser download
- **Flash Firmware:** Uploads firmware binary to FC via MAVFTP
- **Deliver File:** Downloads a file from Hub S3 to a target path on the Pi

---

## 8. FC Web Server Setup (ArduPilot)

The flight controller runs `net_webserver.lua` (ArduPilot Lua scripting applet) to serve FC log files over HTTP. This is the primary log access path; MAVFTP is the fallback.

### Enable on the Flight Controller

Set these parameters via Mission Planner or MAVProxy:

| Parameter | Value | Purpose |
|---|---|---|
| `SCR_ENABLE` | 1 | Enable Lua scripting engine |
| `SCR_VM_I_COUNT` | 200000 | VM instruction count (recommended) |
| `SCR_HEAP_SIZE` | 200000 | Heap size in bytes (recommended) |
| `WEB_ENABLE` | 1 | Enable the web server |
| `WEB_BIND_PORT` | 8080 | HTTP listen port |
| `NET_ENABLE` | 1 | Enable networking stack |
| `NET_IPADDR0–3` | 192.168.144.51 | FC static IP |
| `NET_NETMASK` | 24 | Subnet mask |
| `NET_GWADDR0–3` | 192.168.144.50 | Gateway (Pi) |

Copy the applet to the FC SD card: `APM/scripts/net_webserver.lua`. Reboot the FC. Verify from the Pi:

```bash
curl http://192.168.144.51:8080/
# Should return HTML directory listing
```

The companion's `FCLogSyncer` automatically uses this endpoint for background log sync and on-demand downloads.

---

## 9. Extending the System

### Adding a New Sensor Forwarder

The pattern for any new data source is:

```pseudo
1. Read sensor data (serial, I2C, SPI, USB, network)
2. Format as JSON: {droneId, timestamp, data: {...}}
3. POST to /api/rest/payload/{appId}/ingest with x-api-key header
4. Hub broadcasts via WebSocket → custom app UI renders it
```

Create a custom app in Hub App Store with a payload parser (Python script that transforms raw JSON into display fields), then build a UI with the drag-and-drop UI Builder.

### Adding a Custom Job Type

Extend `raspberry_pi_client.py`:

```pseudo
class ExtendedClient(QuiverHubClient):
    def handle_my_custom_job(self, job):
        payload = job['payload']
        # ... execute task ...
        return (True, None)  # or (False, "error message")

    def process_job(self, job):
        if job['type'] == 'my_custom_job':
            return self.handle_my_custom_job(job)
        return super().process_job(job)
```

Create the job from Hub UI: Drone Configuration → Job History → New Job → type `my_custom_job` with JSON payload.

### Integrating External Systems

The REST API accepts standard HTTP from any client. Examples:

- **ROS/ROS2:** Subscribe to a topic, POST to `/api/rest/telemetry/ingest` in the callback
- **ArduPilot Lua:** Use `net_webserver.lua` CGI handlers to push data to the companion, which forwards to Hub
- **MQTT bridge:** Subscribe to MQTT topics, forward to Hub REST endpoints

---

## 10. Quick Reference

### Dependencies

```bash
pip3 install requests aiohttp mavsdk dronecan python-socketio python-dotenv
```

### File Locations

| Path | Purpose |
|---|---|
| `/home/alexd/quiver/forwarder.env` | Shared environment configuration |
| `/home/alexd/quiver/raspberry_pi_client.py` | Hub client script |
| `/home/alexd/quiver/telemetry_forwarder.py` | Telemetry forwarder script |
| `/home/alexd/quiver/logs_ota_service.py` | Logs & OTA service script |
| `/home/alexd/quiver/camera_stream_service.py` | Camera stream service script |
| `/home/alexd/quiver/siyi_camera_controller.py` | SIYI camera controller script |
| `/var/lib/quiver/fc_logs/` | Local FC log cache (FCLogSyncer) |
| `/var/log/quiver/*.log` | Application logs |
| `/etc/systemd/system/quiver-*.service` | Systemd service files |

### Useful Commands

```bash
# Service management
sudo systemctl status quiver-hub-client
sudo systemctl restart telemetry-forwarder
sudo journalctl -u logs-ota -f

# CAN bus
sudo ip link set can0 up type can bitrate 1000000
candump can0

# MAVLink debugging
mavproxy.py --master=udpin:0.0.0.0:14540

# Test Hub endpoint
curl -X POST $QUIVER_HUB_URL/api/rest/health
```

### MAVLink Connection Strings

| Type | Connection String |
|---|---|
| UDP (simulation) | `udpin://0.0.0.0:14540` |
| Serial (direct) | `serial:///dev/ttyACM0:57600` |
| TCP (network) | `tcp://192.168.144.51:5760` |

### Common DroneCAN Messages

| Message | Data |
|---|---|
| `uavcan.equipment.power.BatteryInfo` | Voltage, current, temperature, SoC |
| `uavcan.equipment.gnss.Fix` | GPS position, velocity, accuracy |
| `uavcan.equipment.air_data.StaticPressure` | Barometric pressure |
| `uavcan.equipment.ahrs.MagneticFieldStrength` | Magnetometer data |
