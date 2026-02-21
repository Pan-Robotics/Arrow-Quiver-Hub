# Quiver Hub

**Modular UAV Ground Station & Data Pipeline Platform**

Quiver Hub is a web-based ground station for managing unmanned aerial vehicle data pipelines. It aggregates real-time sensor streams, post-flight analytics, drone configuration, and a developer-extensible app framework into a single-page application. The platform follows a **hub-and-spoke model**: a persistent sidebar provides instant access to any installed application, while a pluggable App Builder allows developers to create new data pipeline apps without modifying the core codebase.

---

## Architecture

The system consists of three tiers: the browser-based frontend, the Node.js server, and one or more companion computers (typically Raspberry Pi units mounted on drones). The browser communicates with the server via tRPC over HTTP for CRUD operations and Socket.IO over WebSocket for real-time data. Companion computers push sensor data to REST endpoints and poll a job queue for reverse commands.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Quiver Hub Web UI                            │
│  ┌───────────┐  ┌──────────────────────────────────────────────────┐ │
│  │  Sidebar   │  │  Active App Window                              │ │
│  │  (AppBar)  │  │   LidarApp · TelemetryApp · CameraFeedApp      │ │
│  │            │  │   FlightAnalyticsApp · DroneConfig               │ │
│  │  [+] Store │  │   AppRenderer (custom apps)                     │ │
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
                              │  REST + WebSocket
┌─────────────────────────────┴────────────────────────────────────────┐
│                Companion Computer (Raspberry Pi)                     │
│  relay.py → POST /api/rest/{pointcloud,telemetry,camera}/ingest     │
│  job_poller.py → GET /api/trpc/droneJobs.getPendingJobs             │
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
  routers.ts                     ← tRPC procedures (auth, drones, apps, logs)
  rest-api.ts                    ← REST endpoints for companion computers
  websocket.ts                   ← Socket.IO event handling
  parserExecutor.ts              ← Python sandbox for custom app parsers
  db.ts                          ← Database query helpers
  storage.ts                     ← S3 file storage helpers
drizzle/
  schema.ts                      ← Database schema (12 tables)
shared/
  types.ts                       ← Shared TypeScript types
```

---

## Applications

### RPLidar Terrain Mapping (Core)

Real-time 2D LiDAR point cloud visualization from an RPLidar sensor. Supports both a 2D polar canvas view with distance-based color gradient and a 3D WebGL view with orbit controls and elevation mapping. Includes a demo mode for testing without hardware.

### Flight Telemetry

Real-time flight controller dashboard displaying attitude (roll, pitch, yaw), position (lat, lon, altitude), GPS status, battery voltage (FC and UAVCAN), and flight status. Data arrives via MAVLink telemetry relay.

### Camera Feed & Gimbal Control

Gimbal camera interface with D-pad rotation controls, zoom slider, photo/record triggers, and live status display (connection, angles, recording, HDR). Commands relay through WebSocket to the companion computer.

### Flight Analytics

Post-flight log analysis with a full ArduPilot DataFlash binary parser running in the browser. Parses `.BIN` and `.log` files into 18 chart types across 6 categories (Attitude, Navigation, Power, Vibration, Radio, EKF). Features include a color-coded flight mode timeline, GPS track map with altitude gradient, mode-based filtering (click a mode segment to zoom all charts), brush-select zoom (click-and-drag on any chart), flight summary with Markdown export, side-by-side log comparison, and instant restore across app switches via module-level cache.

### Drone Configuration

Administration panel for managing drones and connectivity. Register drones, generate and manage API keys, run multi-endpoint connection tests with latency reporting, upload files for drone delivery, view job history, and generate ready-to-use Python relay configuration snippets.

### Logs & OTA Updates (Indicated)

Remote log streaming and over-the-air firmware updates. The backend job system already supports file delivery; the UI shows a placeholder.

### Mission Planner (Indicated)

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

### Data Ingestion (Pi → Hub)

Python relay scripts POST sensor data to REST endpoints, authenticated with `api_key` and `drone_id`.

| Endpoint | Payload |
|---|---|
| `/api/rest/pointcloud/ingest` | Polar scan points and statistics |
| `/api/rest/telemetry/ingest` | MAVLink attitude, position, GPS, battery |
| `/api/rest/camera/status` | Gimbal angles, recording state, connection |
| `/api/rest/flightlog/upload` | Base64-encoded `.BIN` files |
| `/api/rest/payload/{appId}/ingest` | Custom app JSON payloads |

### Job Execution (Hub → Pi)

A polling-based job queue pushes tasks to the companion computer. Jobs follow a `pending → in_progress → completed/failed` lifecycle.

| Job Type | Description |
|---|---|
| `upload_file` | Download a file from S3 to a target path on the Pi |
| `update_config` | Update configuration files |
| `restart_service` | Restart a service |

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
| `/api/rest/payload/:appId/ingest` | POST | Receive custom app payload |
| `/api/rest/flightlog/upload` | POST | Upload flight log from Pi |

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
| `register_companion` | Client → Server | Companion computer self-registration |
| `camera_command` | Client → Server | Forward gimbal command to companion |
| `pointcloud` | Server → Client | LiDAR scan data |
| `telemetry` | Server → Client | Flight telemetry data |
| `camera_status` | Server → Client | Camera status |
| `app_data` | Server → Client | Custom app parsed data |

---

## Database Schema

Twelve tables organized across four domains.

| Table | Purpose |
|---|---|
| `users` | OAuth user accounts (openId, name, email, role) |
| `drones` | Registered drone inventory (droneId, name, lastSeen) |
| `apiKeys` | Per-drone authentication keys |
| `scans` | Point cloud scan metadata |
| `telemetry` | Flight telemetry snapshots (JSON) |
| `customApps` | App Builder definitions (parser, schema, UI) |
| `userApps` | Per-user app installations |
| `appVersions` | App version history for rollback |
| `appData` | Parsed payload storage for custom apps |
| `droneJobs` | Hub-to-Pi job queue |
| `droneFiles` | Uploaded files for drone delivery |
| `flightLogs` | Flight log metadata and S3 references |

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

---

## Feature Status

| Feature | Status |
|---|---|
| RPLidar Terrain Mapping | **Implemented** |
| Flight Telemetry | **Implemented** |
| Camera Feed & Gimbal | **Implemented** |
| Flight Analytics (18 charts, GPS map, brush zoom, compare) | **Implemented** |
| Drone Configuration & API Keys | **Implemented** |
| App Store & Installation | **Implemented** |
| App Builder (parser + UI wizard) | **Implemented** |
| App Renderer (runtime widget engine) | **Implemented** |
| App Management & Versioning | **Implemented** |
| REST API (Pi integration) | **Implemented** |
| Drone Job Queue (Hub → Pi) | **Implemented** |
| Logs & OTA Updates | **Indicated** |
| Mission Planner | **Indicated** |

---

## License

MIT License

## Acknowledgments

- **RPLidar C1** by SLAMTEC
- **ArduPilot** DataFlash log format
- **shadcn/ui** for UI components
- **tRPC** for type-safe APIs
- **Manus Platform** for hosting and deployment
