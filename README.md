# Quiver Hub

**Modular UAV Ground Station & Data Pipeline Platform**

Quiver Hub is a web-based ground station for managing unmanned aerial vehicle data pipelines. It aggregates real-time sensor streams, post-flight analytics, drone configuration, over-the-air firmware updates, and a developer-extensible app framework into a single-page application. The platform follows a **hub-and-spoke model**: a persistent sidebar provides instant access to any installed application, while a pluggable App Builder allows developers to create new data pipeline apps without modifying the core codebase.

---

## Architecture

The system consists of three tiers: the browser-based frontend, the Node.js server, and one or more companion computers (typically Raspberry Pi units mounted on drones). The browser communicates with the server via tRPC over HTTP for CRUD operations and Socket.IO over WebSocket for real-time data. Companion computers push sensor data to REST endpoints, poll a job queue for reverse commands, and maintain persistent Socket.IO connections for bidirectional streaming.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Quiver Hub Web UI                            │
│  ┌───────────┐  ┌──────────────────────────────────────────────────┐ │
│  │  Sidebar   │  │  Active App Window                              │ │
│  │  (AppBar)  │  │   LidarApp · TelemetryApp · CameraFeedApp      │ │
│  │            │  │   FlightAnalyticsApp · LogsOtaApp               │ │
│  │  [+] Store │  │   DroneConfig · AppRenderer (custom apps)       │ │
│  └───────────┘  └──────────────────────────────────────────────────┘ │
└─────────────────────────────┬────────────────────────────────────────┘
                              │  tRPC (HTTP)  +  Socket.IO (WS)
┌─────────────────────────────┴────────────────────────────────────────┐
│                        Express Server                                │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌─────────────────┐   │
│  │  tRPC     │  │  REST API │  │  WebSocket│  │ Parser Executor │   │
│  │  Router   │  │  /api/rest│  │  Server   │  │ (Python sandbox)│   │
│  └───────────┘  └───────────┘  └───────────┘  └─────────────────┘   │
│                         │                                            │
│  ┌──────────────────────┴───────────────────────────────────────┐    │
│  │  Drizzle ORM → MySQL / TiDB       S3 Object Storage         │    │
│  └──────────────────────────────────────────────────────────────┘    │
└─────────────────────────────▲────────────────────────────────────────┘
                              │  REST + Socket.IO
┌─────────────────────────────┴────────────────────────────────────────┐
│                Companion Computer (Raspberry Pi)                     │
│                                                                      │
│  telemetry_forwarder.py → POST /api/rest/telemetry/ingest            │
│  raspberry_pi_client.py → tRPC droneJobs.getPendingJobs (polling)    │
│  camera_stream_service.py → POST /api/rest/camera/stream-register    │
│  siyi_camera_controller.py → Socket.IO (gimbal commands/status)      │
│  logs_ota_service.py → REST + Socket.IO (logs, OTA, diagnostics, remote logs)     │
│  (supports multipart upload for FC logs with base64 fallback)                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Recharts, Three.js, Leaflet, Socket.IO client |
| Backend | Express 4, tRPC 11, Socket.IO server, Drizzle ORM |
| Database | MySQL / TiDB (cloud-hosted, SSL) |
| File Storage | S3-compatible object storage |
| Authentication | Manus OAuth + JWT (users); per-drone API keys (companion computers) |
| Parser Runtime | Python 3.11 subprocess sandbox (custom app parsers) |
| Companion Scripts | Python 3.11 with MAVSDK, aiohttp, python-socketio, psutil |

### Key Directories

```
client/
  src/
    components/
      AppSidebar.tsx              ← Sidebar navigation with app icons
      apps/
        LidarApp.tsx              ← RPLidar point cloud visualization
        TelemetryApp.tsx          ← Flight telemetry dashboard
        CameraFeedApp.tsx         ← Gimbal camera control & status
        FlightAnalyticsApp.tsx    ← Post-flight log analysis
        LogsOtaApp.tsx            ← FC logs, OTA firmware, diagnostics, remote logs
        AppStore.tsx              ← App marketplace
        AppBuilder.tsx            ← 4-step app creation wizard
        AppRenderer.tsx           ← Runtime renderer for custom apps
        UIBuilder.tsx             ← Drag-and-drop widget layout editor
      widgets/
        PointCloudCanvas.tsx      ← Three.js 3D point cloud renderer
        PointCloudCanvas2D.tsx    ← HTML5 Canvas 2D polar renderer
        LineChartWidget.tsx       ← Rolling time-series chart
        BarChartWidget.tsx        ← Bar chart widget
    pages/
      Home.tsx                    ← Hub layout and app routing
      DroneConfig.tsx             ← Drone management panel
      AppManagement.tsx           ← Custom app administration
    hooks/
      useDroneSelection.ts       ← Per-app drone selection with persistence
    lib/
      flight-charts.ts           ← DataFlash parser and chart definitions
server/
  routers.ts                     ← tRPC procedures (auth, drones, apps, logs, OTA, diagnostics)
  rest-api.ts                    ← REST endpoints for companion computers
  websocket.ts                   ← Socket.IO event handling and broadcast functions
  parserExecutor.ts              ← Python sandbox for custom app parsers
  db.ts                          ← Core database query helpers
  logsOtaDb.ts                   ← Database helpers for FC logs, firmware, diagnostics
  droneJobsDb.ts                 ← Database helpers for drone job queue
  storage.ts                     ← S3 file storage helpers
drizzle/
  schema.ts                      ← Database schema (15 tables)
companion_scripts/
  telemetry_forwarder.py         ← MAVLink + UAVCAN telemetry relay
  raspberry_pi_client.py         ← Job queue poller and file delivery client
  camera_stream_service.py       ← go2rtc + Tailscale WebRTC stream manager
  siyi_camera_controller.py      ← SIYI A8 Mini gimbal controller (Socket.IO)
  logs_ota_service.py            ← FC log download, OTA firmware, diagnostics, remote logs
  *.service                      ← Systemd unit files for each companion script
  install_*.sh                   ← Interactive install scripts for Pi deployment
docs/
  LOGS_OTA_PIPELINE.md           ← Logs & OTA pipeline architecture
  PARSER_OUTPUT_FORMAT.md        ← Custom parser output specification
  UI_SCHEMA_SPEC.md              ← UI Builder schema specification
  QUIVER_DEPLOYMENT_TEMPLATE.md  ← Edge deployment template for custom parsers
  architecture/                  ← System architecture documents
  sdk/                           ← SDK documentation (5 levels)
  reference/                     ← SIYI SDK docs, Flight-Log-Analyser reference
  archive/                       ← Historical test findings and debug notes
shared/
  types.ts                       ← Shared TypeScript types
```

---

## Applications

### RPLidar Terrain Mapping (Core)

Real-time 2D LiDAR point cloud visualization from an RPLidar sensor. Supports both a 2D polar canvas view with distance-based color gradient and a 3D WebGL view with orbit controls and elevation mapping. Includes a demo mode for testing without hardware.

### Flight Telemetry

Real-time flight controller dashboard displaying attitude (roll, pitch, yaw), position (lat, lon, altitude), GPS status, battery voltage (FC and UAVCAN), and flight status. Data arrives via the `telemetry_forwarder.py` companion script, which reads MAVLink telemetry via MAVSDK and optionally monitors UAVCAN battery data via DroneCAN.

### Camera Feed & Gimbal Control

Gimbal camera interface with D-pad rotation controls, zoom slider, photo/record triggers, and live status display (connection, angles, recording, HDR). Video streams via WebRTC through go2rtc and Tailscale Funnel for sub-second latency. Commands relay through Socket.IO to the `siyi_camera_controller.py` companion script, which communicates with the SIYI A8 Mini via its UDP SDK.

### Flight Analytics

Post-flight log analysis with a full ArduPilot DataFlash binary parser running in the browser. Parses `.BIN` and `.log` files into 18 chart types across 6 categories (Attitude, Navigation, Power, Vibration, Radio, EKF). Features include a color-coded flight mode timeline, GPS track map with altitude gradient, mode-based filtering (click a mode segment to zoom all charts), brush-select zoom (click-and-drag on any chart), flight summary with Markdown export, side-by-side log comparison, and instant restore across app switches via module-level cache.

### Logs & OTA Updates

Four-tab interface for remote flight controller management and companion computer monitoring, powered by the `logs_ota_service.py` companion script:

**FC Logs** — Scan the flight controller's SD card for `.BIN` and `.log` files via MAVFTP, download them to S3, and view/download from the browser. Completed logs can be saved directly to the user's PC via a server-side download proxy (`GET /api/rest/logs/fc-download/:logId`) that streams from S3 with `Content-Disposition: attachment`. For logs still on the FC, the download button dispatches the companion job and auto-triggers the browser download once the upload completes. Completed logs can also be sent directly to the Flight Analytics app for parsing (checks if the app is installed first). The companion script supports both multipart file upload (preferred, no base64 overhead) and base64 JSON upload (backward-compatible fallback). Real-time download progress via WebSocket.

**OTA Updates** — Upload firmware files (`.abin`/`.apj`, max 50 MB) and flash them to the flight controller via MAVFTP. Monitors the ArduPilot firmware rename sequence (`ardupilot.abin` → `ardupilot-verify.abin` → `ardupilot-flash.abin` → `ardupilot-flashed.abin`) with real-time progress. Includes a safety warning dialog before flashing.

**Diagnostics** — Live system health gauges (CPU, memory, disk, temperature) with color-coded thresholds, systemd service status grid (active/inactive/failed), and network interface table (IP, RX/TX bytes). Data collected every 10 seconds via `psutil` on the companion computer.

**Remote Logs** — Real-time terminal view of `journalctl` output from any companion service (telemetry-forwarder, logs-ota, camera-stream, siyi-camera, quiver-hub-client). Start/stop streaming with service selector dropdown. Lines arrive via Socket.IO in buffered batches.

### Drone Configuration

Administration panel for managing drones and connectivity. Register drones, generate and manage API keys, run multi-endpoint connection tests with latency reporting, upload files for drone delivery, view job history, and generate ready-to-use Python relay configuration snippets.

### Mission Planner (Planned)

Autonomous flight mission planning with waypoints. A Google Maps integration component is available in the codebase; the UI shows a placeholder.

---

## App Store & App Builder

The **App Store** provides a discovery and installation interface for built-in and custom apps. Per-user installation state is tracked in the database.

The **App Builder** is a four-step wizard for creating custom data pipeline apps:

1. **Data Source** — Choose `custom_endpoint` (gets its own REST ingest URL), `stream_subscription` (subscribe to existing streams), or `passthrough` (direct WebSocket relay).
2. **Parser Upload** — Write a Python `parse_payload()` function with a `SCHEMA` dictionary defining output fields. The parser runs in a sandboxed Python 3.11 subprocess. A test runner validates it before proceeding.
3. **UI Builder** — Drag-and-drop widget layout editor. Widget types: Text, Gauge, Line Chart, Bar Chart, LED Indicator, Map, Video, Canvas (2D/3D point cloud). Each widget binds to a schema field.
4. **Publish** — Save with versioning and make available in the App Store.

The **App Renderer** instantiates custom apps at runtime, connecting widgets to live data via Socket.IO or REST polling. The **App Management** page provides editing, deletion, version history, and rollback.

---

## Companion Computer Integration

### Services Overview

Five companion scripts run on the Raspberry Pi, each as a systemd service with automatic restart and journald logging:

| Service | Script | systemd Unit | Purpose |
|---|---|---|---|
| Telemetry Forwarder | `telemetry_forwarder.py` | `telemetry-forwarder.service` | MAVLink + UAVCAN telemetry relay to Hub |
| Hub Client | `raspberry_pi_client.py` | `quiver-hub-client.service` | Job queue polling and file delivery |
| Camera Stream | `camera_stream_service.py` | `camera-stream.service` | go2rtc + Tailscale WebRTC stream management |
| SIYI Camera | `siyi_camera_controller.py` | `siyi-camera.service` | Gimbal control via SIYI UDP SDK |
| Logs & OTA | `logs_ota_service.py` | `logs-ota.service` | FC log download, OTA flash, diagnostics, remote logs |

Each service has a corresponding install script (`install_*.sh`) that handles dependency installation, environment configuration, script deployment, and systemd service setup.

### Data Ingestion (Pi → Hub)

Python companion scripts POST sensor data to REST endpoints, authenticated with `api_key` and `drone_id`.

| Endpoint | Method | Payload | Source Script |
|---|---|---|---|
| `/api/rest/pointcloud/ingest` | POST | Polar scan points and statistics | External LiDAR relay |
| `/api/rest/telemetry/ingest` | POST | MAVLink attitude, position, GPS, battery | `telemetry_forwarder.py` |
| `/api/rest/camera/status` | POST | Gimbal angles, recording state, connection | `siyi_camera_controller.py` |
| `/api/rest/camera/stream-register` | POST | WebRTC signaling URL registration | `camera_stream_service.py` |
| `/api/rest/flightlog/upload` | POST | Base64-encoded `.BIN` files | `telemetry_forwarder.py` |
| `/api/rest/logs/fc-list` | POST | Discovered FC log files from SD card | `logs_ota_service.py` |
| `/api/rest/logs/fc-progress` | POST | FC log download progress updates | `logs_ota_service.py` |
| `/api/rest/logs/fc-upload` | POST | Downloaded FC log content (base64) | `logs_ota_service.py` |
| `/api/rest/firmware/progress` | POST | Firmware flash progress and stage | `logs_ota_service.py` |
| `/api/rest/diagnostics/report` | POST | System health snapshot (CPU, mem, disk, temp, services) | `logs_ota_service.py` |
| `/api/rest/payload/:appId/ingest` | POST | Custom app JSON payloads | Custom relay scripts |

### Job Execution (Hub → Pi)

A polling-based job queue pushes tasks to the companion computer. Jobs follow a `pending → in_progress → completed/failed` lifecycle.

| Job Type | Description | Handler |
|---|---|---|
| `upload_file` | Download a file from S3 to a target path on the Pi | `raspberry_pi_client.py` |
| `update_config` | Update configuration files | `raspberry_pi_client.py` |
| `restart_service` | Restart a systemd service | `raspberry_pi_client.py` |
| `scan_fc_logs` | Scan FC SD card for log files via MAVFTP | `logs_ota_service.py` |
| `download_fc_log` | Download a specific FC log via MAVFTP and upload to Hub | `logs_ota_service.py` |
| `flash_firmware` | Flash firmware to FC via MAVFTP with stage monitoring | `logs_ota_service.py` |

### Relay Configuration

The Drone Configuration page generates Python snippets. Example environment:

```bash
WEB_SERVER_URL=https://your-hub.manus.space/api/rest
API_KEY=your_api_key
DRONE_ID=quiver_001
```

---

## REST API Reference

All ingest endpoints require `api_key` and `drone_id` in the request body.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/rest/health` | GET | Health check |
| `/api/rest/test-connection` | POST | Validate API key and drone ID |
| `/api/rest/pointcloud/ingest` | POST | Receive LiDAR scan data |
| `/api/rest/pointcloud/latest/:droneId` | GET | Polling fallback for latest scan |
| `/api/rest/telemetry/ingest` | POST | Receive flight telemetry |
| `/api/rest/camera/status` | POST | Receive camera and gimbal status |
| `/api/rest/camera/stream-register` | POST | Register WebRTC stream URL |
| `/api/rest/camera/stream-unregister` | POST | Unregister WebRTC stream URL |
| `/api/rest/camera/stream-status/:droneId` | GET | Get current stream URL |
| `/api/rest/camera/whep-proxy/:droneId` | POST | WHEP SDP proxy — relays WebRTC signaling to go2rtc on companion |
| `/api/rest/flightlog/upload` | POST | Upload flight log from Pi |
| `/api/rest/logs/fc-list` | POST | Report discovered FC log files |
| `/api/rest/logs/fc-progress` | POST | Update FC log download progress |
| `/api/rest/logs/fc-upload` | POST | Upload downloaded FC log to S3 (base64) |
| `/api/rest/logs/fc-upload-multipart` | POST | Upload downloaded FC log to S3 (multipart, preferred) |
| `/api/rest/logs/fc-download/:logId` | GET | Download proxy — streams FC log from S3 to browser (session auth) |
| `/api/rest/firmware/progress` | POST | Update firmware flash progress |
| `/api/rest/diagnostics/report` | POST | Submit system diagnostics snapshot |
| `/api/rest/payload/:appId/ingest` | POST | Receive custom app payload |

### Point Cloud Ingest Example

```json
{
  "api_key": "string",
  "drone_id": "string",
  "timestamp": "ISO8601",
  "points": [
    { "angle": 0.0, "distance": 1000.0, "quality": 63, "x": 1000.0, "y": 0.0 }
  ],
  "stats": {
    "point_count": 800,
    "valid_points": 750,
    "min_distance": 100.0,
    "max_distance": 8000.0,
    "avg_distance": 2500.0,
    "avg_quality": 45.0
  }
}
```

---

## WebSocket Events

Socket.IO handles all real-time data distribution using room-based routing.

| Event | Direction | Description |
|---|---|---|
| `subscribe` / `unsubscribe` | Client → Server | Join or leave a drone's data room |
| `subscribe_camera` / `unsubscribe_camera` | Client → Server | Join or leave camera status room |
| `subscribe_app` / `unsubscribe_app` | Client → Server | Join or leave custom app room |
| `subscribe_logs` / `unsubscribe_logs` | Client → Server | Join or leave logs room for a drone |
| `subscribe_stream` / `unsubscribe_stream` | Client → Server | Join or leave a data stream room |
| `register_companion` | Client → Server | Companion computer self-registration |
| `camera_command` | Client → Server | Forward gimbal command to companion |
| `log_stream_request` | Client → Server → Pi | Start/stop remote journalctl stream |
| `pointcloud` | Server → Client | LiDAR scan data |
| `telemetry` | Server → Client | Flight telemetry data |
| `camera_status` | Server → Client | Camera and gimbal status |
| `camera_response` | Server → Client | Camera command response |
| `camera_stream` | Server → Client | WebRTC stream URL update |
| `app_data` | Server → Client | Custom app parsed data |
| `fc_log_progress` | Server → Client | FC log download progress |
| `firmware_progress` | Server → Client | Firmware flash progress and stage |
| `diagnostics` | Server → Client | Live system diagnostics snapshot |
| `log_stream` | Server → Client | Buffered journalctl lines |
| `log_stream_line` | Pi → Server | Raw journalctl lines from companion |

---

## tRPC Routers

| Router | Key Procedures | Purpose |
|---|---|---|
| `auth` | `me`, `logout` | Authentication state and session management |
| `pointcloud` | `getLatest`, `getHistory` | Point cloud data queries |
| `telemetry` | `getLatest`, `getHistory` | Telemetry data queries |
| `appBuilder` | `create`, `update`, `list`, `get`, `delete`, `testParser` | Custom app CRUD and parser testing |
| `drones` | `list`, `register`, `update`, `delete`, `generateApiKey` | Drone fleet management |
| `droneJobs` | `create`, `list`, `getPendingJobs`, `acknowledge`, `complete` | Job queue operations |
| `flightLogs` | `list`, `get`, `upload`, `delete` | Flight log management |
| `fcLogs` | `list`, `get`, `requestScan`, `requestDownload`, `sendToAnalytics`, `delete` | FC log scanning, download, download-to-PC, and cross-app transfer |
| `firmware` | `list`, `get`, `upload`, `requestFlash` | Firmware upload and flash management |
| `diagnostics` | `latest`, `history` | System diagnostics queries |

---

## Database Schema

Fifteen tables organized across five domains.

| Table | Purpose |
|---|---|
| **Auth & Users** | |
| `users` | OAuth user accounts (openId, name, email, role) |
| **Drone Fleet** | |
| `drones` | Registered drone inventory (droneId, name, lastSeen) |
| `apiKeys` | Per-drone authentication keys |
| `droneJobs` | Hub-to-Pi job queue (type, payload, status, timestamps) |
| `droneFiles` | Uploaded files for drone delivery |
| **Sensor Data** | |
| `scans` | Point cloud scan metadata |
| `telemetry` | Flight telemetry snapshots (JSON) |
| **Flight Logs & OTA** | |
| `flightLogs` | Uploaded flight log metadata and S3 references |
| `fcLogs` | FC SD card log files (discovered, downloading, completed) |
| `firmwareUpdates` | Firmware uploads and flash status tracking |
| `systemDiagnostics` | Periodic companion computer health snapshots |
| **Custom Apps** | |
| `customApps` | App Builder definitions (parser, schema, UI) |
| `userApps` | Per-user app installations |
| `appVersions` | App version history for rollback |
| `appData` | Parsed payload storage for custom apps |

---

## Getting Started

### Prerequisites

- Node.js 22+
- MySQL or TiDB database
- pnpm package manager

### Installation

```bash
pnpm install
pnpm db:push
pnpm dev
```

### Environment Variables

Environment variables are managed through the Manus platform. Key variables include `DATABASE_URL`, `JWT_SECRET`, `VITE_APP_TITLE`, and `VITE_APP_LOGO`. Update `VITE_APP_TITLE` via Management Dashboard > Settings > General.

### Deployment

1. Create a checkpoint via the Management UI
2. Click **Publish** in the dashboard header
3. The site is live at `https://your-project.manus.space`

Custom domain binding is available through Management Dashboard > Settings > Domains.

### Companion Computer Setup

Each companion script has a dedicated install script. Run on the Raspberry Pi:

```bash
# Hub client (job queue poller)
sudo ./install_hub_client.sh

# Telemetry forwarder (MAVLink + UAVCAN relay)
sudo ./install_telemetry_forwarder.sh

# Camera services (go2rtc + Tailscale + gimbal controller)
sudo ./install_camera_services.sh

# Logs & OTA (FC logs, firmware flash, diagnostics, remote logs)
sudo ./install_logs_ota.sh
```

Each installer prompts for the Hub URL, drone ID, API key, and service-specific configuration (serial port, UDP address, etc.).

---

## Feature Status

| Feature | Status |
|---|---|
| RPLidar Terrain Mapping | **Implemented** |
| Flight Telemetry | **Implemented** |
| Camera Feed & Gimbal Control | **Implemented** |
| Flight Analytics (18 charts, GPS map, brush zoom, compare) | **Implemented** |
| Drone Configuration & API Keys | **Implemented** |
| Logs & OTA Updates (FC logs, firmware flash, diagnostics, remote logs) | **Implemented** |
| App Store & Installation | **Implemented** |
| App Builder (parser + UI wizard) | **Implemented** |
| App Renderer (runtime widget engine) | **Implemented** |
| App Management & Versioning | **Implemented** |
| REST API (Pi integration) | **Implemented** |
| Drone Job Queue (Hub → Pi) | **Implemented** |
| Mission Planner | **Planned** |

---

## License

MIT License

## Acknowledgments

- **RPLidar C1** by SLAMTEC
- **ArduPilot** DataFlash log format and MAVFTP protocol
- **MAVSDK** for flight controller communication
- **SIYI** A8 Mini gimbal camera SDK
- **shadcn/ui** for UI components
- **tRPC** for type-safe APIs
- **Manus Platform** for hosting and deployment
