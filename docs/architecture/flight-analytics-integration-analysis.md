# Flight Log Analyser → Quiver Hub Flight Analytics: Integration Analysis

**Author:** Manus AI | **Date:** February 21, 2026

---

## 1. Executive Summary

The [Flight-Log-Analyser](https://github.com/Pan-Robotics/Flight-Log-Analyser) is a standalone Flask application that parses ArduPilot flight logs (`.BIN` / `.log`), generates matplotlib plots across 11 data categories, supports markdown flight-test documentation, video attachments, GPS anonymization, and session history. This document maps every component of that tool against the Quiver Hub's existing architecture to determine what can be **directly reused**, what needs **adaptation**, and what must be **built new** — all before any implementation begins.

---

## 2. Flight-Log-Analyser Architecture Breakdown

The original tool has three core subsystems:

### 2.1 Log Parsing Engine (`parse_log`)

The parser reads ArduPilot `.log` or `.BIN` text-format files line-by-line, extracting data into structured dictionaries for 11 message types:

| Message Type | Fields Extracted | Plot Category |
|---|---|---|
| **ATT** | Roll, DesRoll, Pitch, DesPitch, Yaw, DesYaw | Attitude |
| **RATE** | R, RDes, P, PDes, Y, YDes | Rate |
| **BARO** / **GPS** | Alt (2 sources) | Altitude |
| **ESC** (×4 instances) | RPM, RawRPM, Voltage, Current, Temp | ESC Performance |
| **BAT** | Volt, Curr, Temp | Battery |
| **GPA** | HAcc, SAcc, VAcc | GPS Accuracy |
| **VIBE** | VibeX, VibeY, VibeZ, Clip | Vibration |
| **RCIN** | C1–C4 | RC Input |
| **RCOU** | C1–C4 | RC Output |
| **XKF4** | SV, SP, SH, SM, SVT | EKF Variance |

The parser is purely functional — it takes a file path and returns 11 data dictionaries. All time values are converted from microseconds to seconds.

### 2.2 Plot Generation Engine (`generate_plots`)

Each data category produces a separate matplotlib figure saved as a PNG file. The engine generates up to **11 plot images** per log file (attitude, rate, altitude, ESC×4, battery, GPA, VIBE, RCIN, RCOU, XKF4). Plots use subplots for multi-series data (e.g., battery has 3 subplots for voltage, current, temperature).

### 2.3 Application Layer (Flask Routes)

The Flask app provides: file upload (log + markdown + videos), GitHub OAuth, SQLite session storage, GPS anonymization, progress tracking, and a tabbed results view with Bootstrap.

---

## 3. Quiver Hub Architecture — Relevant Integration Points

The Quiver Hub already has infrastructure that directly maps to many Flight-Log-Analyser requirements:

| Quiver Hub Component | Relevant Capability |
|---|---|
| **S3 Storage** (`storagePut` / `storageGet`) | File upload/download for logs, plots, videos |
| **Manus OAuth** (built-in) | User authentication (replaces GitHub OAuth) |
| **MySQL/TiDB** (Drizzle ORM) | Session/analysis storage (replaces SQLite) |
| **tRPC Procedures** | API layer for upload, parse, query (replaces Flask routes) |
| **REST API** (`/api/rest/*`) | External ingest endpoints for Pi-uploaded logs |
| **WebSocket** (`broadcastAppData`) | Real-time progress updates (replaces polling `/progress`) |
| **Drone Management** (drones table, API keys) | Per-drone log association |
| **DroneFiles table** | File metadata tracking with S3 references |
| **DroneJobs table** | Job queue for async processing |
| **App Framework** (built-in app system) | Flight Analytics is already registered as a built-in app |
| **React + shadcn/ui + Tailwind** | Frontend (replaces Bootstrap + Jinja templates) |

---

## 4. Component-by-Component Integration Mapping

### 4.1 Log Parsing — Can Be Directly Reused (~90%)

The `parse_log` function is the most valuable piece of the original tool. It is a **pure function** with no framework dependencies — it reads lines and populates dictionaries.

**Reuse strategy:** Port the Python parsing logic to TypeScript/JavaScript for server-side execution. The line-by-line CSV parsing translates directly:

| Original (Python) | Quiver Hub (TypeScript) | Effort |
|---|---|---|
| `line.startswith("ATT")` | `line.startsWith("ATT")` | Trivial |
| `parts = line.split(",")` | `parts = line.split(",")` | Identical |
| `float(parts[n])` | `parseFloat(parts[n])` | Trivial |
| `time / 1e6` (μs → s) | `time / 1e6` | Identical |
| Dictionary accumulation | Object/Map accumulation | Trivial |

**What changes:** The Python function returns 11 separate variables; the TypeScript version should return a single typed object with all categories. The `.BIN` binary format would need a separate binary parser (the original only handles text `.log` format despite accepting `.BIN` in the upload form).

**Estimated reuse: 90%** — Logic is identical, only syntax changes.

### 4.2 Plot Generation — Needs Adaptation (~60% reuse)

The original uses server-side matplotlib to generate static PNG images. For the Quiver Hub, there are two viable approaches:

**Option A: Server-side plot generation (higher reuse, simpler)**

Port the matplotlib logic to a server-side charting library (e.g., run Python matplotlib via a child process, or use a Node.js charting library like `chartjs-node-canvas`). Upload generated PNGs to S3. This preserves the original plot layouts almost exactly.

**Option B: Client-side interactive charts (lower reuse, better UX)**

Use Chart.js or Recharts in the React frontend to render interactive, zoomable charts. The data structures from the parser feed directly into chart datasets. Users can zoom, pan, toggle series, and hover for values — a significant UX upgrade over static PNGs.

| Aspect | Option A (Server PNG) | Option B (Client Charts) |
|---|---|---|
| Reuse of original plot code | ~80% (layout, colors, labels) | ~40% (data mapping only) |
| User experience | Static images, same as original | Interactive, zoomable, modern |
| Performance | Server CPU for rendering | Client-side, no server load |
| Storage | S3 for each plot image | No storage needed |
| Implementation effort | Medium | Medium-High |
| Fits Quiver Hub design | Adequate | Excellent |

**Recommendation:** Option B (client-side interactive charts) is the better fit for the Quiver Hub's React architecture. The data extraction logic (which fields map to which chart) is fully reusable; only the rendering layer changes.

### 4.3 File Upload & Storage — Fully Covered by Existing Infrastructure

| Original Feature | Quiver Hub Equivalent | Status |
|---|---|---|
| Flask file upload | tRPC procedure + `storagePut` | **Already exists** |
| Local filesystem storage | S3 via `storagePut` / `storageGet` | **Already exists** |
| `UPLOAD_FOLDER` / `PLOT_FOLDER` | S3 keys like `flight-logs/{droneId}/{filename}` | **Map to S3** |
| Serve uploaded files | S3 public URLs | **Already exists** |
| Serve plot images | S3 URLs or client-rendered | **Already exists** |

**Estimated reuse: 0% code, 100% capability** — No original code needed; Hub infrastructure handles it all.

### 4.4 Authentication — Fully Replaced

The original uses GitHub OAuth with Flask-Login and SQLite user storage. The Quiver Hub has Manus OAuth with JWT sessions and MySQL user storage. **No code from the original is needed.**

### 4.5 Session/Analysis Management — Needs New Schema (~30% conceptual reuse)

The original stores sessions in SQLite with columns: `user_id`, `log_file`, `markdown_file`, `videos`, `created_at`. The Quiver Hub needs a new `flightAnalyses` table:

```
flightAnalyses table (new):
  id              INT AUTO_INCREMENT PRIMARY KEY
  userId          INT NOT NULL (FK → users.id)
  droneId         VARCHAR(64) (FK → drones.droneId)
  title           VARCHAR(255)
  logFileUrl      VARCHAR(1024) — S3 URL
  logFileKey      VARCHAR(512) — S3 key
  markdownUrl     VARCHAR(1024) — S3 URL (optional)
  markdownKey     VARCHAR(512) — S3 key (optional)
  parsedData      JSON — full parsed log data for chart rendering
  plotSummary     JSON — metadata about which plots are available
  anonymized      BOOLEAN DEFAULT false
  status          ENUM('uploading','parsing','complete','failed')
  createdAt       TIMESTAMP
  updatedAt       TIMESTAMP

flightAnalysisMedia table (new):
  id              INT AUTO_INCREMENT PRIMARY KEY
  analysisId      INT NOT NULL (FK → flightAnalyses.id)
  type            ENUM('video','image','document')
  filename        VARCHAR(255)
  url             VARCHAR(1024) — S3 URL
  storageKey      VARCHAR(512) — S3 key
  fileSize        INT
  createdAt       TIMESTAMP
```

**Estimated reuse: 30%** — The concept of "session = log + markdown + videos" maps over, but the schema is new.

### 4.6 GPS Anonymization — Directly Reusable (~95%)

The `anonymize_gps_log` function is a standalone text-processing utility that zeroes out GPS coordinates in specific message types (GPS, AHR2, EAHR, POS, TERR, ORGN). It has no dependencies beyond file I/O.

**Reuse strategy:** Port directly to TypeScript. The logic is simple string manipulation on CSV lines. Can operate on the file content in memory (Buffer/string) rather than file paths.

**Estimated reuse: 95%** — Near-identical logic.

### 4.7 Markdown Rendering — Already Available

The original uses Python's `markdown` library with `fenced_code` and `tables` extensions. The Quiver Hub already has the `Streamdown` component for markdown rendering in React. **No code needed.**

### 4.8 Progress Tracking — Better Alternative Available

The original uses a global variable polled via `/progress` endpoint. The Quiver Hub has WebSocket infrastructure (`broadcastAppData`) that can push real-time progress updates to the Flight Analytics app. **No code from original needed; WebSocket is superior.**

### 4.9 Video Playback — Needs New UI Component

The original simply links to uploaded video files. The Quiver Hub can store videos in S3 and render them with HTML5 `<video>` tags in the React frontend. A simple video gallery component is needed.

---

## 5. Reuse Summary Matrix

| Component | Lines of Code (Original) | Reuse % | Effort to Port | Priority |
|---|---|---|---|---|
| Log Parser (`parse_log`) | ~130 lines | **90%** | Low | **P0 — Core** |
| GPS Anonymizer | ~40 lines | **95%** | Very Low | P1 |
| Plot Data Mapping | ~140 lines | **60%** | Medium | **P0 — Core** |
| Plot Rendering (matplotlib) | ~140 lines | **0–40%** | Replaced by Chart.js/Recharts | P0 |
| File Upload Routes | ~60 lines | **0%** | Replaced by tRPC + S3 | P0 |
| Session Management | ~30 lines | **30%** | New Drizzle schema | P0 |
| Authentication | ~40 lines | **0%** | Already exists | N/A |
| Progress Tracking | ~15 lines | **0%** | Replaced by WebSocket | P1 |
| Markdown Rendering | ~5 lines | **0%** | Already exists (Streamdown) | N/A |
| Video Handling | ~10 lines | **0%** | New React component | P2 |
| HTML Templates | ~140 lines | **0%** | Replaced by React pages | P0 |

**Overall: ~170 lines of core logic (parser + anonymizer) can be ported almost directly. ~140 lines of plot data mapping inform the chart configuration. The remaining ~360 lines are replaced by existing Quiver Hub infrastructure.**

---

## 6. Proposed Architecture for Quiver Hub Flight Analytics

```
┌─────────────────────────────────────────────────────────────────┐
│                    FLIGHT ANALYTICS APP                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  Upload Flow  │    │  Log Parser  │    │  Chart Renderer  │  │
│  │              │    │  (TypeScript) │    │  (Recharts/      │  │
│  │  .log/.BIN   │───▶│              │───▶│   Chart.js)      │  │
│  │  .md notes   │    │  parse_log() │    │                  │  │
│  │  videos      │    │  anonymize() │    │  11 chart types  │  │
│  └──────┬───────┘    └──────┬───────┘    └──────────────────┘  │
│         │                   │                                   │
│         ▼                   ▼                                   │
│  ┌──────────────┐    ┌──────────────┐                          │
│  │  S3 Storage  │    │   Database   │                          │
│  │              │    │              │                          │
│  │  Log files   │    │  flightAna-  │                          │
│  │  Videos      │    │  lyses table │                          │
│  │  Markdown    │    │  parsedData  │                          │
│  └──────────────┘    └──────────────┘                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    REST API Ingest                        │  │
│  │  POST /api/rest/flight-log/upload                        │  │
│  │  (Pi can upload .log files directly via API key)         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    tRPC Procedures                        │  │
│  │  analytics.upload    — Upload log + attachments           │  │
│  │  analytics.list      — List analyses for drone/user       │  │
│  │  analytics.get       — Get full parsed data for charts    │  │
│  │  analytics.delete    — Remove analysis + S3 files         │  │
│  │  analytics.anonymize — Re-process with GPS anonymization  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Frontend Views                         │  │
│  │  Upload View     — Drag-drop log + markdown + videos      │  │
│  │  Analysis List   — Table of past analyses per drone       │  │
│  │  Analysis Detail — Tabbed charts + markdown + video       │  │
│  │  Drone Selector  — useDroneSelection("analytics")         │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Integration with Existing Quiver Hub Systems

### 7.1 Drone Association

Every flight analysis is linked to a `droneId` via the drone selector (using the existing `useDroneSelection` hook). This enables per-drone flight history, which the original tool lacked.

### 7.2 API Key–Authenticated Log Upload

The companion computer (Pi) can upload `.log` files directly via a new REST endpoint `POST /api/rest/flight-log/upload`, authenticated with the same API key used for telemetry/pointcloud. This enables **automated post-flight log upload** without manual browser interaction.

### 7.3 Cross-App Data Correlation

Since the Hub already stores real-time telemetry in the `telemetry` table, the Flight Analytics app could optionally overlay real-time telemetry data alongside parsed log data for the same time window — enabling comparison between what the flight controller recorded and what the Hub received.

### 7.4 DroneFiles Integration

Uploaded log files and videos can be tracked in the existing `droneFiles` table (or the new `flightAnalysisMedia` table), making them visible in the Drone Config file management view.

---

## 8. Implementation Phases (Recommended)

| Phase | Scope | Depends On | Estimated Effort |
|---|---|---|---|
| **Phase 1: Schema & Parser** | New DB tables, TypeScript log parser ported from Python, GPS anonymizer | Nothing | 1 session |
| **Phase 2: Upload & Storage** | tRPC upload procedure, S3 storage for logs/markdown/videos, analysis creation | Phase 1 |  1 session |
| **Phase 3: Chart Rendering** | 11 interactive chart types in React (Recharts), tabbed analysis view | Phase 1 | 1–2 sessions |
| **Phase 4: Analysis Management** | List/view/delete analyses, drone selector, analysis history table | Phase 2 | 1 session |
| **Phase 5: REST API Ingest** | Pi-side log upload endpoint, auto-analysis trigger | Phase 2 | 1 session |
| **Phase 6: Polish** | Progress indicators, markdown rendering, video gallery, export | Phase 3–4 | 1 session |

---

## 9. Key Decisions Needed Before Implementation

1. **Chart library choice:** Recharts (React-native, declarative) vs Chart.js (canvas-based, more performant for large datasets). Given that flight logs can contain 100K+ data points, **Chart.js with downsampling** may be the better choice for performance.

2. **Binary `.BIN` support:** The original parser only handles text `.log` format. Should we add binary `.BIN` parsing (requires understanding MAVLink DataFlash binary format), or require users to convert to `.log` first?

3. **Auto-upload from Pi:** Should the companion computer automatically upload flight logs after each flight, or should this remain a manual process?

4. **Parsed data storage:** Store the full parsed data as JSON in the database (fast retrieval, ~1–5MB per log) or re-parse from S3 on each view (slower, less storage)?

5. **Cross-app telemetry overlay:** Should the Flight Analytics charts be able to overlay real-time telemetry data from the `telemetry` table for the same time window?

---

## 10. Conclusion

Approximately **40–50% of the Flight-Log-Analyser's functional logic** can be ported to the Quiver Hub with minimal changes. The core log parser (~130 lines) and GPS anonymizer (~40 lines) translate almost line-for-line from Python to TypeScript. The plot data mapping (~140 lines of field-to-chart configuration) informs the client-side chart setup. The remaining application infrastructure (auth, storage, routing, templates, progress tracking) is entirely replaced by the Quiver Hub's existing systems, which are more capable in every dimension.

The most significant upgrade over the original tool is the shift from static matplotlib PNGs to **interactive, zoomable charts** in the browser, combined with **per-drone association**, **API key–authenticated auto-upload from the Pi**, and **session history with S3-backed storage**. The Quiver Hub's WebSocket infrastructure also enables real-time parsing progress updates, replacing the original's polling mechanism.
