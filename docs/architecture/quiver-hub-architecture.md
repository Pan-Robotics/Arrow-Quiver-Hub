# Quiver Hub — Architecture & Feature Reference

**Version:** February 2026  
**Author:** Pan Robotics  
**Status:** Core platform implemented; select modules indicated for future development

---

## 1. Overview

Quiver Hub is a modular, web-based ground station for managing unmanned aerial vehicle (UAV) data pipelines. It aggregates real-time sensor streams, post-flight analytics, drone configuration, and a developer-extensible app framework into a single-page application. The platform is designed around a **hub-and-spoke model**: a persistent sidebar provides instant access to any installed application, while a pluggable App Builder allows third-party developers to create new data pipeline apps without modifying the core codebase.

The system connects to one or more companion computers (typically Raspberry Pi units mounted on drones) that run Python relay scripts. These scripts push sensor data — LiDAR point clouds, MAVLink telemetry, gimbal camera status, and arbitrary payloads — to Quiver Hub's REST endpoints. The server validates, stores, and broadcasts the data in real time over WebSocket to all connected browser clients. A polling-based job queue enables the reverse direction: the web UI can push files, configuration updates, and commands back to the companion computer.

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Recharts, Three.js, Leaflet, Socket.IO client |
| Backend | Express 4, tRPC 11, Socket.IO server, Drizzle ORM |
| Database | MySQL / TiDB (cloud-hosted, SSL) |
| File Storage | S3-compatible object storage (flight logs, drone files, media) |
| Authentication | Manus OAuth with JWT session cookies (users); per-drone API keys (companion computers) |
| Parser Runtime | Python 3.11 subprocess sandbox (custom app payload parsing) |

---

## 2. System Architecture

The architecture consists of three tiers: the browser-based frontend, the Node.js server, and the companion computer fleet. Communication between the browser and server uses tRPC over HTTP for CRUD operations and Socket.IO over WebSocket for real-time data streams. Communication between companion computers and the server uses authenticated REST endpoints for data ingestion and a tRPC-based job queue for reverse command delivery.

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

### Data Flow Summary

The four primary data flows are as follows. First, **companion-to-hub ingestion**: Python relay scripts on the Pi POST sensor data to REST endpoints, authenticated via per-drone API keys. Second, **hub-to-browser broadcast**: the server validates incoming data, stores metadata in MySQL, and broadcasts payloads over Socket.IO to all subscribed browser clients. Third, **browser-to-hub operations**: the React frontend calls tRPC procedures for CRUD operations (drone management, log uploads, app configuration) and receives real-time data via Socket.IO subscriptions. Fourth, **hub-to-companion commands**: the drone jobs system enables reverse communication — the web UI creates jobs (file uploads, config changes), and the Pi polls for pending jobs and executes them.

---

## 3. Windows & Applications

### 3.1 Application Sidebar

The left-hand sidebar is the primary navigation mechanism. At the top sits the **Quiver Hub arrow logomark**. Below it, the sidebar displays **core apps** (always visible, cannot be uninstalled), followed by **installed apps** (built-in or custom apps the user has added from the App Store). At the bottom, **pinned utility apps** (Drone Configuration) appear above the **[+] button**, which opens the App Store to discover and install new apps.

Switching between apps is instantaneous. Each app's state persists through one of several mechanisms: a module-level JavaScript cache (for Flight Analytics), Socket.IO reconnection (for real-time streaming apps), or localStorage (for drone selection and UI preferences). No re-download or re-parse occurs when returning to a previously viewed app within the same browser session.

### 3.2 RPLidar Terrain Mapping (Core App)

The flagship application displays real-time 2D LiDAR point cloud data from an RPLidar sensor mounted on the drone. Data arrives via Socket.IO `pointcloud` events.

| Feature | Description |
|---|---|
| 2D Canvas View | HTML5 Canvas rendering of polar scan data with a distance-based color gradient (green to yellow to red) |
| 3D Canvas View | Three.js WebGL rendering with orbit controls, elevation mapping, and adjustable point size |
| View Toggle | Switch between 2D grid and 3D perspective with a single click |
| Demo Mode | Generates synthetic room-like scan data for testing without a connected drone |
| Drone Selector | Dropdown to select which drone's stream to visualize; persisted per-app in localStorage |
| Connection Status | Live indicator showing WebSocket connection state |
| Scan Statistics | Point count, valid points, min/max/avg distance, average quality |

### 3.3 Flight Telemetry

A real-time flight controller data dashboard receiving data via Socket.IO `telemetry` events. The interface is organized into six panels covering the full MAVLink and UAVCAN telemetry envelope.

| Panel | Data Fields |
|---|---|
| Attitude | Roll, pitch, yaw (degrees) with visual indicators |
| Position | Latitude, longitude, absolute and relative altitude |
| GPS | Satellite count, fix type |
| Battery (FC) | Voltage, remaining percentage |
| Battery (UAVCAN) | Voltage, current, temperature, state of charge |
| Flight Status | In-air or on-ground indicator |

### 3.4 Camera Feed & Gimbal Control

A gimbal camera control and status monitoring interface. Camera status arrives via Socket.IO `camera_status` events, while commands are emitted as `camera_command` events and forwarded to the companion computer's registered socket.

| Feature | Description |
|---|---|
| Gimbal Control | D-pad for yaw/pitch rotation, center and nadir presets |
| Zoom Slider | Adjustable zoom level sent as camera commands |
| Photo / Record | Trigger photo capture or toggle video recording |
| Status Display | Connection state, gimbal angles, recording indicator, HDR and TF card status |
| Command Relay | Commands forwarded via WebSocket to the companion computer |

### 3.5 Flight Analytics

A post-flight log analysis tool with full ArduPilot DataFlash binary parsing running entirely in the browser. Flight logs (`.BIN` or `.log` format) are uploaded either manually through the UI or automatically from the companion computer via the REST API.

| Feature | Description |
|---|---|
| Log Management | Upload, list, and delete flight logs per drone; supports manual and API upload |
| Client-Side Parsing | DataFlash binary parser runs in the browser with no server-side processing |
| 18 Chart Types | Across 6 categories: Attitude, Navigation, Power, Vibration, Radio, EKF |
| Flight Mode Timeline | Color-coded visual timeline of mode transitions (Stabilize, AltHold, Loiter, Auto, RTL, Land, etc.) |
| GPS Track Map | Leaflet map with altitude-based color gradient polyline |
| Mode-Based Filtering | Click any flight mode segment to filter all charts to that time window |
| Brush-Select Zoom | Click-and-drag on any chart to zoom into a custom time range; all charts zoom simultaneously |
| Flight Summary | Auto-generated summary: duration, max altitude, distance, battery usage, mode breakdown |
| Summary Export | Export summary as Markdown text |
| Compare Mode | Side-by-side comparison of two flight logs |
| Instant Restore | Module-level cache preserves full parsed state across app switches without re-downloading or re-parsing |
| Notes & Media | Attach Markdown notes and media files to flight logs (stored in S3) |

The 18 chart definitions span six categories:

| Category | Charts |
|---|---|
| Attitude | Roll & Pitch, Yaw, Rate Roll/Pitch/Yaw |
| Navigation | Altitude (Baro + GPS), Ground Speed, Climb Rate, GPS Accuracy (HDOP/VDOP/NSats) |
| Power | Battery Voltage & Current, Board Voltage, Current Draw |
| Vibration | Vibration X/Y/Z, Clipping Events |
| Radio | RC Input Channels, RSSI |
| EKF | Velocity Variances, Position Variances |

### 3.6 Drone Configuration

An administration panel for managing drones and their connectivity, also accessible at the `/config` route.

| Feature | Description |
|---|---|
| Drone Registry | Register new drones, edit name and ID, delete drones with cascading cleanup |
| API Key Management | Generate, revoke, reactivate, and delete API keys per drone; copy-to-clipboard |
| Connection Test | Multi-endpoint dry-run test (health, auth, pointcloud, telemetry, camera) with latency reporting |
| File Upload | Upload files to S3 and create download jobs for the Pi (supports Python file compression) |
| Job History | View all pending, completed, and failed jobs for a drone |
| Config Script Generation | Generates ready-to-use Python relay configuration snippets |

### 3.7 Logs & OTA Updates (Indicated)

Remote log streaming, system diagnostics, and over-the-air firmware updates. The backend job system (`droneJobs`) already supports the `upload_file` job type, which provides the foundation for OTA file delivery. The UI currently shows a "Coming Soon" placeholder.

### 3.8 Mission Planner (Indicated)

Autonomous flight mission planning with waypoints, geofencing, and return-to-home. A Google Maps integration component (`Map.tsx`) is available in the codebase for future use. The UI currently shows a "Coming Soon" placeholder.

---

## 4. App Store & App Builder

### 4.1 App Store

A discovery and installation interface for both built-in and custom apps. Built-in apps (Telemetry, Camera Feed, Logs & OTA, Mission Planner, Flight Analytics) can be installed or uninstalled with a single click. Custom apps created through the App Builder appear here once published. Per-user installation state is tracked in the `userApps` database table.

### 4.2 App Builder

A guided four-step wizard for creating custom data pipeline apps without modifying the core codebase.

**Step 1 — Data Source Selection.** The developer chooses how the app receives data. Three modes are available: `custom_endpoint` (the app gets its own REST endpoint at `/api/rest/payload/{appId}/ingest`), `stream_subscription` (subscribe to existing data streams such as pointcloud, telemetry, camera, or other custom apps), and `passthrough` (direct WebSocket passthrough without server-side parsing).

**Step 2 — Parser Upload.** The developer writes or uploads a Python `parse_payload()` function that transforms raw payloads into structured data. A companion `SCHEMA` dictionary defines output field types, units, and value ranges. The parser runs in a sandboxed Python 3.11 subprocess on the server. A test runner validates the parser against sample data before proceeding.

**Step 3 — UI Builder.** A drag-and-drop widget layout editor with a configurable grid. Available widget types include Text Display, Gauge, Line Chart, Bar Chart, LED Indicator, Map, Video, and Canvas (2D/3D point cloud). Each widget is bound to a schema field. A preview mode allows testing the layout before publishing.

**Step 4 — Publish.** The app is saved to the database with versioning and made available in the App Store.

### 4.3 App Renderer

The runtime engine that renders custom apps based on their stored UI schema. It instantiates widgets, connects them to live data via Socket.IO subscriptions or REST polling, and supports multi-stream subscriptions with field aliasing for apps that consume data from multiple sources simultaneously. The Canvas widget supports the same 2D/3D toggle as the core LidarApp, and chart widgets maintain rolling time windows.

### 4.4 App Management

An administrative view for managing installed and custom apps. Features include editing custom apps (re-opens the App Builder in edit mode), deleting apps with cascade cleanup (versions, data, user installations), viewing version history, and rolling back to previous versions.

---

## 5. Backend Architecture

### 5.1 tRPC Router Map

All client-server communication (except real-time streams and companion computer ingestion) flows through typed tRPC procedures. The following table summarizes the router structure.

| Router | Key Procedures | Auth Level |
|---|---|---|
| `auth` | `me`, `logout` | Public |
| `pointcloud` | `ingest`, `getDrones`, `getRecentScans`, `getStats` | Mixed (API key for ingest) |
| `telemetry` | `ingest`, `getRecentTelemetry` | Mixed (API key for ingest) |
| `appBuilder` | `saveApp`, `updateApp`, `deleteApp`, `listApps`, `installApp`, `uninstallApp`, `getUserApps`, `testParser`, `validateParser`, `extractSchema`, `getAvailableStreams`, `sendTestPayload`, `rollbackToVersion`, `getVersionHistory`, `getAppById` | Mixed |
| `drones` | `list`, `register`, `update`, `delete`, `generateApiKey`, `revokeApiKey`, `reactivateApiKey`, `deleteApiKey`, `updateApiKeyDescription`, `testConnection` | Protected |
| `droneJobs` | `createJob`, `getPendingJobs`, `acknowledgeJob`, `completeJob`, `getAllJobs`, `uploadFile`, `getFile`, `getFiles`, `deleteFile` | Mixed |
| `flightLogs` | `list`, `getById`, `upload`, `update`, `delete`, `uploadNotes`, `uploadMedia`, `downloadBinary` | Protected |

### 5.2 REST API Endpoints

These endpoints are designed for non-tRPC clients, primarily the companion computer's Python relay scripts. All ingest endpoints require `api_key` and `drone_id` in the request body. The server validates the key against the `apiKeys` table and verifies the drone ID matches.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/rest/health` | GET | Health check |
| `/api/rest/test-connection` | POST | Validate API key and drone ID |
| `/api/rest/pointcloud/ingest` | POST | Receive LiDAR scan data |
| `/api/rest/pointcloud/latest/:droneId` | GET | Polling fallback for latest scan |
| `/api/rest/telemetry/ingest` | POST | Receive flight telemetry |
| `/api/rest/camera/status` | POST | Receive camera and gimbal status |
| `/api/rest/payload/:appId/ingest` | POST | Receive custom app payload data |
| `/api/rest/flightlog/upload` | POST | Upload flight log from companion computer |

### 5.3 WebSocket Events

Socket.IO handles all real-time data distribution. The server uses room-based routing: clients subscribe to specific drones, cameras, apps, or named streams, and broadcasts are scoped to those rooms.

| Event | Direction | Description |
|---|---|---|
| `subscribe` / `unsubscribe` | Client → Server | Join or leave a drone's data room |
| `subscribe_camera` / `unsubscribe_camera` | Client → Server | Join or leave a camera status room |
| `subscribe_app` / `unsubscribe_app` | Client → Server | Join or leave a custom app data room |
| `subscribe_stream` / `unsubscribe_stream` | Client → Server | Join or leave a named data stream |
| `register_companion` | Client → Server | Companion computer self-registration |
| `camera_command` | Client → Server | Forward gimbal or camera command to companion |
| `pointcloud` | Server → Client | LiDAR scan data broadcast |
| `telemetry` | Server → Client | Flight telemetry broadcast |
| `camera_status` | Server → Client | Camera status broadcast |
| `camera_response` | Server → Client | Camera command response |
| `app_data` | Server → Client | Custom app parsed data broadcast |
| `pointcloud_update` / `telemetry_update` | Server → Client | Lightweight dashboard notifications |

### 5.4 Database Schema

The database uses 12 tables organized around four domains: user management, drone fleet, custom apps, and flight data.

| Table | Purpose | Key Fields |
|---|---|---|
| `users` | OAuth user accounts | openId, name, email, role (user / admin) |
| `drones` | Registered drone inventory | droneId, name, lastSeen, isActive |
| `apiKeys` | Per-drone authentication keys | key, droneId, description, isActive |
| `scans` | Point cloud scan metadata | droneId, timestamp, pointCount, min/max distance, avgQuality |
| `telemetry` | Flight telemetry snapshots | droneId, timestamp, telemetryData (JSON) |
| `customApps` | App Builder definitions | appId, name, dataSource, parserCode, dataSchema, uiSchema, published |
| `userApps` | Per-user app installations | userId, appId, installedAt |
| `appVersions` | App version history | appId, version, parserCode, dataSchema, uiSchema |
| `appData` | Parsed payload storage | appId, data (JSON), rawPayload (JSON) |
| `droneJobs` | Hub-to-Pi job queue | droneId, type, payload, status (pending / in_progress / completed / failed) |
| `droneFiles` | Uploaded files for drone delivery | fileId, filename, storageKey, url, droneId |
| `flightLogs` | Flight log metadata | droneId, filename, storageKey, url, format (bin / log), uploadSource (manual / api) |

### 5.5 File Storage (S3)

All binary data is stored in S3-compatible object storage. The database holds only metadata and URLs. No file bytes are stored in database columns.

| Storage Path Pattern | Content |
|---|---|
| `drone-files/{droneId}/{fileId}-{filename}` | Files uploaded for drone delivery (scripts, configs) |
| `flight-logs/{droneId}/{nanoid}-{filename}` | ArduPilot `.BIN` or `.log` flight log files |
| `flight-logs/{droneId}/notes/{nanoid}-notes.md` | Markdown notes attached to flight logs |
| `flight-logs/{droneId}/media/{nanoid}-{filename}` | Media files (images, video) attached to flight logs |

---

## 6. Companion Computer Integration

### 6.1 Data Ingestion (Pi → Hub)

Python relay scripts running on the Pi POST sensor data to REST endpoints at a configurable interval. Each request includes an `api_key` and `drone_id` for authentication. The Drone Configuration page generates ready-to-use Python configuration snippets for each registered drone.

| Relay Function | Endpoint | Payload |
|---|---|---|
| LiDAR relay | `/api/rest/pointcloud/ingest` | Polar scan points (angle, distance, quality, x, y) and statistics |
| Telemetry relay | `/api/rest/telemetry/ingest` | MAVLink attitude, position, GPS, battery (FC and UAVCAN) |
| Camera relay | `/api/rest/camera/status` | Gimbal angles, recording state, connection status |
| Flight log upload | `/api/rest/flightlog/upload` | Base64-encoded `.BIN` files (up to 100 MB) |
| Custom payload | `/api/rest/payload/{appId}/ingest` | Arbitrary JSON matching the app's parser schema |

### 6.2 Job Execution (Hub → Pi)

A polling-based job queue enables the Hub to push tasks to the companion computer. Jobs follow a four-state lifecycle: `pending` (created by the web UI), `in_progress` (acknowledged by the Pi), then either `completed` or `failed`.

| Job Type | Description |
|---|---|
| `upload_file` | Download a file from S3 to a target path on the Pi; supports gzip compression for Python files |
| `update_config` | Update configuration files on the Pi |
| `restart_service` | Restart a service on the Pi |

The Pi polls `droneJobs.getPendingJobs` at a regular interval, acknowledges each job, executes it, and reports completion or failure back to the Hub.

---

## 7. Client-Side Architecture

### 7.1 State Management

The frontend uses a layered state management approach, with each mechanism scoped to the appropriate lifetime.

| Mechanism | Scope | Use Case |
|---|---|---|
| React `useState` | Component lifetime | UI state, form inputs, toggles |
| Module-level cache | Browser tab lifetime (survives unmount) | Flight Analytics parsed data for instant restore on app switch |
| `localStorage` | Browser session (persists across refreshes) | Selected drone per app, active tab, selected log ID |
| tRPC query cache (React Query) | React tree lifetime | Server data with automatic invalidation on mutations |
| Socket.IO subscriptions | WebSocket connection lifetime | Real-time data streams |

### 7.2 Shared Hooks

Two custom hooks are shared across multiple applications. `useAuth()` provides the current user state, login URL, and logout function. `useDroneSelection(appId)` manages per-app drone selection with localStorage persistence and automatic fallback to the first available drone when the stored value becomes stale.

### 7.3 Reusable Widget Components

Four widget components are shared between the core apps and the App Renderer for custom apps.

| Widget | Description |
|---|---|
| `PointCloudCanvas` | Three.js 3D point cloud renderer with orbit controls and elevation mapping |
| `PointCloudCanvas2D` | HTML5 Canvas 2D polar point cloud renderer with distance-based color gradient |
| `LineChartWidget` | Rolling time-series line chart with configurable data fields |
| `BarChartWidget` | Bar chart with configurable data fields |

---

## 8. Authentication & Authorization

Authentication operates on two separate planes. **User authentication** flows through Manus OAuth, which completes at `/api/oauth/callback` and drops a JWT session cookie. The `users` table supports two roles — `user` and `admin` — with the admin role auto-assigned to the project owner. Backend procedures are gated by `protectedProcedure` (requires valid session) or `publicProcedure` (allows anonymous access).

**Companion computer authentication** uses per-drone API keys stored in the `apiKeys` table. Every REST ingest request must include both an `api_key` and a `drone_id`; the server validates the key and verifies the drone ID matches before processing the payload. API keys can be generated, revoked, reactivated, and deleted through the Drone Configuration interface.

---

## 9. Feature Status Summary

| Feature | Status | Notes |
|---|---|---|
| RPLidar Terrain Mapping | **Implemented** | 2D/3D views, demo mode, real-time WebSocket streaming |
| Flight Telemetry | **Implemented** | Full MAVLink + UAVCAN telemetry dashboard |
| Camera Feed & Gimbal | **Implemented** | Status display and command relay to companion computer |
| Flight Analytics | **Implemented** | 18 chart types, mode timeline, GPS map, brush zoom, compare mode, instant restore |
| Drone Configuration | **Implemented** | API keys, connection test, file upload, job management, config script generation |
| App Store | **Implemented** | Install and uninstall built-in and custom apps |
| App Builder | **Implemented** | 4-step wizard: data source, parser, UI builder, publish |
| App Renderer | **Implemented** | Runtime widget rendering with multi-stream data binding |
| App Management | **Implemented** | Edit, delete, version history, rollback for custom apps |
| REST API (Pi Integration) | **Implemented** | Point cloud, telemetry, camera, custom payload, and flight log endpoints |
| Drone Job Queue | **Implemented** | Two-way Hub-to-Pi communication with file delivery |
| Logs & OTA Updates | **Indicated** | Placeholder UI present; job system provides the backend foundation |
| Mission Planner | **Indicated** | Placeholder UI present; Google Maps component available in codebase |
| Crosshair Sync | **Indicated** | Hover-linked cursors across Flight Analytics charts |
| PARM Table View | **Indicated** | Searchable ArduPilot parameter table from DataFlash logs |
