# Mission Planner App — Design Document

**Version:** 1.1 — May 2026  
**Author:** Pan Robotics  
**Status:** Approved design — ready for implementation

---

## 1. Overview

The Mission Planner is a new core app for Quiver Hub that enables operators to plan, upload, execute, and monitor autonomous flight missions directly from the web interface. It integrates with ArduPilot's MAVLink mission protocol [1] via the existing MAVSDK-based companion script infrastructure, providing a complete mission lifecycle without requiring Mission Planner desktop software or QGroundControl.

The app covers three ArduPilot mission subsystems: **waypoint missions** (the flight plan itself), **geofence boundaries** (inclusion and exclusion zones), and **rally points** (safe return locations). All three are managed through a unified map-based interface and uploaded to the flight controller as a single coordinated operation.

---

## 2. Design Decisions

The following decisions were confirmed during the design review and shape the architecture throughout this document.

| Decision | Choice | Architectural Consequence |
|---|---|---|
| Arming policy | **Explicit Arm button** — separate from Start Mission | The `start_mission` job does NOT auto-arm. A dedicated `arm` job type is added. The frontend displays a two-step launch sequence: Arm (with safety confirmation dialog) → Start Mission. This prevents accidental motor spin-up and aligns with field safety practices. |
| Multi-drone scope | **Single-drone first**, with open pathway to multi-drone | The `missions` table uses a `droneId` foreign key (not nullable). The schema and API are designed so that a future `missionAssignments` join table can map one mission to multiple drones without breaking the existing single-drone flow. Mission duplication (`mission.duplicate`) enables manual multi-drone assignment in the interim. |
| Survey patterns | **Yes — included in Phase 1** alongside other popular patterns | The planning UI includes a Pattern Generator tool with lawnmower/grid, spiral, crosshatch, and perimeter patrol patterns. This requires a geometry engine (Turf.js) for polygon subdivision and path generation. Pattern parameters (overlap %, camera FOV, altitude) are configurable. |
| Altitude frame | **Selectable between both** — GLOBAL_RELATIVE_ALT and GLOBAL_TERRAIN_ALT | Each waypoint stores a `frame` field. The UI defaults to `GLOBAL_RELATIVE_ALT` (altitude above home) but offers a per-waypoint or per-mission toggle to `GLOBAL_TERRAIN_ALT` (terrain-following). A visual terrain profile chart shows the planned path against elevation data when terrain mode is active. Requires SRTM elevation tile integration for the terrain preview. |
| Offline map tiles | **Yes** — offline tile caching for field use | The frontend implements a Service Worker–based tile cache using IndexedDB. Operators can pre-download a bounding box of tiles at selected zoom levels before going to the field. A "Download Area" tool lets users draw a rectangle and choose zoom levels to cache. Cached tile count and storage usage are shown in settings. |
| Mission templates | **Yes** — pre-built template library | A template system generates waypoints from simple parameters (area polygon, altitude, speed, overlap). Templates are stored as JSON definitions and rendered in a "New Mission" dialog. Users select a template, configure parameters, draw the target area, and the system generates the full waypoint set. |

---

## 3. Design Goals

The Mission Planner app is designed around six principles that align with Quiver Hub's existing architecture and the operational realities of field UAV deployment.

**Web-first planning** means operators can create and edit missions from any device with a browser — no desktop GCS installation required. The map interface supports touch, mouse, and keyboard input equally. **Field-ready offline support** ensures the map and planning tools work without internet connectivity via cached tiles and local-first data persistence. **Persistent mission library** stores all missions in the Hub database with full version history, enabling operators to re-use proven flight plans across sessions and drones. **Offline-safe upload** leverages the existing job queue to push missions to the companion computer, which then uploads to the FC via MAVSDK — the browser does not need a direct MAVLink connection. **Real-time execution monitoring** uses the existing telemetry pipeline to overlay live drone position on the planned mission path, showing waypoint progress and estimated time remaining. **Safety-first defaults** means every mission includes a geofence (at minimum a circular inclusion boundary) and a return-to-launch policy, with explicit arming required before execution can begin.

---

## 4. System Architecture

The Mission Planner follows the same three-tier pattern as all Quiver Hub apps: browser frontend, Node.js server, and companion computer. The data flow is bidirectional — missions are created in the browser, stored on the server, pushed to the companion via the job queue, and uploaded to the FC via MAVSDK. During execution, telemetry flows back through the existing pipeline to provide live tracking.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Mission Planner Frontend                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐    │
│  │  Map Canvas  │  │  Waypoint    │  │  Mission Library            │    │
│  │  (Leaflet)   │  │  Editor      │  │  (list, import, export)     │    │
│  │  + Drawing   │  │  Panel       │  │                             │    │
│  │  + Offline   │  │              │  │  Template Gallery            │    │
│  │    Tiles     │  │              │  │  (survey, patrol, spiral...) │    │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐    │
│  │  Geofence    │  │  Execution   │  │  Pre-flight Checklist       │    │
│  │  Editor      │  │  Monitor     │  │  & Validation               │    │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐    │
│  │  Pattern     │  │  Terrain     │  │  Offline Tile               │    │
│  │  Generator   │  │  Profile     │  │  Manager                    │    │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │  tRPC + Socket.IO
┌──────────────────────────────┴──────────────────────────────────────────┐
│                         Express Server                                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────────┐   │
│  │  mission Router   │  │  WebSocket       │  │  Job Queue          │   │
│  │  (CRUD, validate, │  │  (progress,      │  │  (upload_mission,   │   │
│  │   patterns,       │  │   status_change) │  │   arm, start,       │   │
│  │   templates)      │  │                  │  │   pause, rtl)       │   │
│  └──────────────────┘  └──────────────────┘  └─────────────────────┘   │
│                               │                                          │
│  ┌────────────────────────────┴─────────────────────────────────────┐   │
│  │  MySQL: missions, missionWaypoints, geofences, rallyPoints,      │   │
│  │         missionTemplates                                          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────▲──────────────────────────────────────────┘
                               │  Job polling + REST progress
┌──────────────────────────────┴──────────────────────────────────────────┐
│                 Companion Computer (Raspberry Pi)                         │
│  logs_ota_service.py:                                                    │
│    handle_arm_vehicle()     → MAVSDK action.arm()                        │
│    handle_upload_mission()  → MAVSDK mission.upload_mission()            │
│    handle_upload_geofence() → MAVSDK geofence.upload_geofence()          │
│    handle_download_mission()→ MAVSDK mission.download_mission()          │
│    handle_start_mission()   → MAVSDK mission.start_mission()             │
│    handle_pause_mission()   → MAVSDK action.hold()                       │
│    handle_rtl()             → MAVSDK action.return_to_launch()           │
│    mission_progress subscription → report to Hub                         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Model

### 5.1 Database Tables

The Mission Planner introduces five new tables that follow the existing schema conventions (camelCase columns, auto-increment IDs, droneId foreign keys, timestamp tracking).

| Table | Purpose | Key Fields |
|---|---|---|
| `missions` | Mission definitions (the flight plan container) | id, droneId, name, description, status (draft / uploaded / armed / executing / completed / aborted / failed / archived), totalDistance, estimatedDuration, rtlAfterMission, defaultSpeed, defaultAltitude, defaultFrame (GLOBAL_RELATIVE_ALT / GLOBAL_TERRAIN_ALT), homeLatitude, homeLongitude, homeAltitude, templateId, createdAt, updatedAt |
| `missionWaypoints` | Ordered waypoint items within a mission | id, missionId, sequence, command (MAV_CMD enum), param1–param4, latitude, longitude, altitude, frame (GLOBAL_RELATIVE_ALT / GLOBAL_TERRAIN_ALT), isFlyThrough, speedOverride, holdTime, yawDeg, cameraAction, label |
| `geofences` | Geofence boundaries linked to a mission | id, missionId, type (inclusion_polygon / exclusion_polygon / inclusion_circle / exclusion_circle), vertices (JSON array of {lat, lng}), centerLatitude, centerLongitude, radius, maxAltitude, minAltitude, fenceAction (report / rtl / land / smartRtl / brake) |
| `rallyPoints` | Safe return locations linked to a mission | id, missionId, latitude, longitude, altitude, label |
| `missionTemplates` | Pre-built and user-saved mission templates | id, name, description, category (survey / patrol / inspection / custom), patternType (lawnmower / spiral / crosshatch / perimeter / orbit / vertical_profile), parameters (JSON schema), icon, isBuiltIn, createdBy, createdAt |

### 5.2 Mission Status Lifecycle

A mission progresses through a defined state machine. The explicit Arm step creates a clear separation between "mission uploaded to FC" and "motors ready to spin."

```
draft → uploaded → armed → executing → completed
  │         │        │         │
  │         │        │         └──→ aborted (RTL triggered or operator cancel)
  │         │        └─────────────→ disarmed (operator cancelled before start)
  │         └──────────────────────→ failed (upload rejected by FC)
  └────────────────────────────────→ archived (soft delete)
```

The `armed` state is a critical safety gate. The UI displays a prominent "ARMED" indicator with a countdown timer — if `start_mission` is not issued within 30 seconds of arming, the companion auto-disarms and reverts to `uploaded` status.

### 5.3 Supported MAV_CMD Commands

The initial implementation supports the most commonly used ArduPilot Copter commands, including those needed for survey patterns. Additional commands can be added incrementally.

| Command | MAV_CMD Value | Description | Key Parameters |
|---|---|---|---|
| Takeoff | 22 | Climb to specified altitude | altitude |
| Waypoint | 16 | Navigate to position | hold time, acceptance radius, yaw |
| Spline Waypoint | 82 | Smooth curved path through point | — |
| Loiter Unlimited | 17 | Circle at position indefinitely | radius |
| Loiter Time | 19 | Circle at position for N seconds | duration |
| Loiter Turns | 18 | Circle at position for N turns | turns, radius |
| Return to Launch | 20 | Return to home and land | — |
| Land | 21 | Land at specified position | — |
| Change Speed | 178 | Modify flight speed | speed type, speed, throttle |
| Set ROI | 201 | Point camera at location | lat, lon, alt |
| Delay | 93 | Wait before next command | duration |
| Do Jump | 177 | Repeat a section of mission | target seq, repeat count |
| Camera Trigger Distance | 206 | Take photos at distance intervals | distance |
| Do Set Cam Trigg Dist | 206 | Start/stop distance-based camera trigger | distance (0 to stop) |
| Do Digicam Control | 203 | Trigger single photo | — |
| Condition Yaw | 115 | Rotate to specific heading | angle, speed, direction |

### 5.4 S3 Storage

| Storage Path Pattern | Content |
|---|---|
| `missions/{droneId}/{missionId}.plan` | QGroundControl-compatible `.plan` export (JSON) |
| `missions/{droneId}/{missionId}-history/{version}.json` | Version history snapshots |
| `missions/templates/{templateId}.json` | Custom user-saved templates |

### 5.5 Multi-Drone Pathway

The current schema binds each mission to a single drone via `droneId`. When multi-drone support is needed, the migration path is:

1. Add a `missionAssignments` table: `{ id, missionId, droneId, status, uploadedAt }`
2. Make `missions.droneId` nullable (legacy missions retain their direct binding)
3. New missions created via multi-assign flow use `missionAssignments` instead
4. The companion script receives the same job payload regardless — the Hub handles fan-out

This approach requires no changes to the companion script or MAVSDK layer, only server-side job creation logic.

---

## 6. Job Queue Integration

The Mission Planner adds five new job types to the existing `droneJobs` queue, handled by `logs_ota_service.py` on the companion computer. The explicit `arm_vehicle` job separates arming from mission start for safety.

| Job Type | Direction | Payload | Handler Method |
|---|---|---|---|
| `upload_mission` | Hub → FC | `{ missionId, waypoints[], geofences[], rallyPoints[], rtlAfterMission, defaultFrame }` | `handle_upload_mission()` |
| `arm_vehicle` | Hub → FC | `{ missionId }` | `handle_arm_vehicle()` |
| `start_mission` | Hub → FC | `{ missionId }` | `handle_start_mission()` |
| `pause_mission` | Hub → FC | `{}` | `handle_pause_mission()` |
| `download_mission` | FC → Hub | `{ missionId }` (to store result) | `handle_download_mission()` |

### 6.1 Arm → Start Sequence

The two-step launch sequence enforces a deliberate operator action before motors spin:

**Step 1 — Arm.** The operator clicks "Arm" in the UI. A confirmation dialog warns: "This will arm the motors. Ensure the area is clear." On confirmation, an `arm_vehicle` job is created. The companion calls `drone.action.arm()`. On success, the mission status transitions to `armed` and the frontend shows a pulsing "ARMED" badge with a 30-second auto-disarm countdown.

**Step 2 — Start.** The operator clicks "Start Mission" (only enabled when status is `armed`). A `start_mission` job is created. The companion calls `drone.mission.start_mission()`. The mission status transitions to `executing`.

**Auto-disarm safety.** If the `start_mission` job is not received within 30 seconds of arming, the companion calls `drone.action.disarm()` and reports status back to `uploaded`. This prevents the drone sitting armed indefinitely if the operator is distracted or loses connectivity.

### 6.2 Upload Mission Flow (Hub → FC)

The upload job follows a six-step sequence:

**Step 1 — Validate payload.** The companion script receives the job payload containing waypoints, geofences, and rally points. It validates that coordinates are within reasonable bounds, the sequence is contiguous, a takeoff command exists, and the frame values are valid.

**Step 2 — Build MAVSDK MissionPlan.** Each waypoint from the payload is converted to a MAVSDK `MissionItem` object with the appropriate fields (latitude, longitude, altitude, speed, fly-through, loiter time, yaw, camera action). The `frame` field determines whether each item uses relative or terrain-following altitude. The `set_return_to_launch_after_mission` flag is set according to the mission configuration.

**Step 3 — Upload mission to FC.** Call `drone.mission.upload_mission(mission_plan)` with progress reporting. Each progress callback reports percentage back to the Hub via the existing REST progress endpoint.

**Step 4 — Upload geofence.** If geofence boundaries are defined, build `GeofenceData` with inclusion/exclusion polygons and circles, then call `drone.geofence.upload_geofence(geofence_data)`.

**Step 5 — Upload rally points.** If rally points are defined, upload them via the MAVSDK rally point interface.

**Step 6 — Verify and report.** Download the mission back from the FC to confirm item count matches, then report success to the Hub. The mission status transitions from `draft` to `uploaded`.

### 6.3 Mission Progress Reporting

During mission execution, the companion script subscribes to `drone.mission.mission_progress()` which yields `(current, total)` tuples as the FC advances through waypoints. These are reported to the Hub via a new REST endpoint (`/api/rest/mission/progress`) and broadcast to the browser via Socket.IO `mission_progress` events.

| WebSocket Event | Payload |
|---|---|
| `mission_progress` | `{ droneId, missionId, currentWaypoint, totalWaypoints, status, estimatedTimeRemaining }` |
| `mission_status_change` | `{ droneId, missionId, oldStatus, newStatus }` |

---

## 7. Frontend Design

### 7.1 Layout

The Mission Planner uses a **split-panel layout**: a full-width Leaflet map occupies the primary viewport, with a collapsible right-hand panel for waypoint editing, mission properties, and the pre-flight checklist. A bottom toolbar provides mode switches (Plan / Geofence / Rally / Monitor) and action buttons (Arm, Start, Pause, RTL, Clear).

This layout differs from the existing DashboardLayout sidebar pattern because mission planning is inherently spatial — the map must dominate the screen real estate, with editing controls overlaid or docked to the side.

### 7.2 Planning Mode

In Planning mode, the operator interacts with the map to build the flight path:

**Click-to-add waypoints.** Each click on the map adds a waypoint at the clicked position with the default altitude and speed. Waypoints are connected by a polyline showing the planned path. Drag waypoints to reposition them. Right-click a waypoint to edit its properties (altitude, speed, hold time, command type) or delete it.

**Waypoint list panel.** The right panel shows an ordered list of all waypoints with their sequence number, command type, altitude, and speed. Drag-and-drop reordering is supported. Each waypoint row expands to show advanced parameters (yaw, camera action, acceptance radius, frame selection).

**Altitude frame selector.** A per-waypoint dropdown allows switching between `Relative to Home` and `Terrain Following`. When terrain mode is selected for any waypoint, the Terrain Profile chart (Section 7.8) activates automatically.

**Path statistics.** As waypoints are added, the UI calculates and displays total distance, estimated flight time (based on configured speeds), and maximum altitude. These update in real-time as the path is edited.

**Takeoff and landing.** The first item is always a Takeoff command (auto-inserted when the first waypoint is placed). An RTL or Land command is appended based on the mission's RTL configuration.

### 7.3 Pattern Generator

The Pattern Generator is a dedicated tool accessible from the planning toolbar. It auto-generates waypoint sequences from geometric parameters, eliminating manual waypoint placement for common flight patterns.

**Available patterns:**

| Pattern | Use Case | Parameters |
|---|---|---|
| Lawnmower / Grid | Aerial mapping, photogrammetry | Area polygon, altitude, overlap %, camera FOV, heading angle |
| Crosshatch | Dense mapping with cross-coverage | Same as lawnmower + cross angle (typically 90°) |
| Spiral (inward) | Area search, expanding coverage | Center point, start radius, end radius, altitude, spacing |
| Spiral (outward) | Centrifugal search pattern | Same as inward spiral, reversed |
| Perimeter Patrol | Security, boundary inspection | Polygon boundary, altitude, speed, repeat count |
| Orbit / Circle | Point-of-interest inspection | Center point, radius, altitude, number of orbits, heading (nose-in / nose-out) |
| Vertical Profile | Tower/structure inspection | Base point, min altitude, max altitude, step size, orbit radius per level |
| Corridor Scan | Pipeline/road inspection | Polyline path, corridor width, altitude, overlap % |

**Workflow:** The operator selects a pattern type → draws the target area/point on the map → adjusts parameters in the right panel → clicks "Generate." The system computes the waypoint sequence using Turf.js geometry operations and inserts them into the mission. The operator can then manually adjust individual waypoints if needed.

**Camera integration.** For survey patterns (lawnmower, crosshatch, corridor), the generator automatically inserts `DO_SET_CAM_TRIGG_DIST` commands at the start and end of each survey leg, based on the configured camera FOV and desired overlap percentage.

### 7.4 Mission Templates

The "New Mission" dialog presents a template gallery before the blank-canvas editor:

**Built-in templates:**

| Template | Description | Parameters |
|---|---|---|
| Quick Survey | Lawnmower pattern over a rectangular area | Length, width, altitude, overlap |
| Perimeter Patrol | Fly the boundary of a polygon at constant altitude | Polygon, altitude, speed, laps |
| Orbit Inspection | Circle a point of interest | Center, radius, altitude, orbits |
| Vertical Stack | Inspect a tall structure at multiple altitudes | Base, height, levels, radius |
| Waypoint Route | Simple A→B→C→...→Home route | Altitude, speed |
| Search & Rescue | Expanding square search from a center point | Center, initial leg, expansion, altitude |

**Custom templates.** Operators can save any completed mission as a custom template. The template stores the pattern type, parameters, and relative waypoint positions (normalized to the home point). When applied to a new location, waypoints are translated to the new home position.

**Template parameters** are rendered as a form in the right panel. Each template defines a JSON schema for its configurable parameters, and the UI auto-generates input fields (sliders for altitude/speed, number inputs for counts, polygon draw tools for areas).

### 7.5 Geofence Mode

Switching to Geofence mode enables polygon and circle drawing tools on the map:

**Inclusion fence (green).** Draw a polygon or circle that defines the allowed flight area. The drone will trigger the configured fence action if it exits this boundary. At minimum, one inclusion fence is required before upload.

**Exclusion fence (red).** Draw polygons or circles marking no-fly zones within the inclusion boundary. The drone will avoid these areas.

**Altitude limits.** A panel allows setting maximum and minimum altitude limits that apply globally to the geofence. When terrain-following mode is active, altitude limits are interpreted as AGL (above ground level).

**Fence action selector.** Choose what happens on breach: Report Only, RTL, Land, SmartRTL, or Brake/Land.

### 7.6 Rally Points Mode

In Rally mode, clicks on the map place rally points (orange markers). These are alternative safe-landing locations that the FC can use during RTL if they are closer than home. Each rally point has a configurable altitude.

### 7.7 Execution Monitor Mode

When a mission is executing, the UI switches to Monitor mode:

**Live position overlay.** The drone's current position (from the existing telemetry pipeline) is shown as an animated marker on the map, with a trail showing the actual path flown.

**Waypoint progress.** Completed waypoints turn green, the active waypoint pulses, and upcoming waypoints remain blue. A progress bar shows `current / total` waypoints.

**Estimated time remaining.** Based on current speed and remaining distance, the UI estimates time to mission completion.

**Arm/Start controls.** The bottom toolbar shows a two-step launch sequence:
1. **Arm button** (red, with lock icon) — requires confirmation dialog. On success, shows pulsing "ARMED" badge with 30s countdown.
2. **Start Mission button** (green, enabled only when armed) — begins autonomous flight.

**In-flight controls.** Pause (enters HOLD), Resume, RTL (abort mission and return home), and Jump-to-Waypoint (skip ahead or repeat a section).

### 7.8 Terrain Profile Chart

When any waypoint uses `GLOBAL_TERRAIN_ALT` frame, a collapsible terrain profile chart appears below the map. This chart shows:

**Ground elevation** (brown filled area) along the planned flight path, sourced from SRTM elevation data. **Planned altitude** (blue line) showing the drone's planned height. **Clearance margin** (shaded area between ground and flight path) with color coding: green (>30m clearance), yellow (15–30m), red (<15m).

The terrain data is fetched from a free elevation API (Open-Elevation or MapTiler) and cached locally. This gives operators visual confidence that terrain-following missions maintain safe clearance.

### 7.9 Offline Tile Manager

The Offline Tile Manager is accessible from the map settings panel:

**Download area tool.** The operator draws a rectangle on the map defining the area to cache. A zoom level selector (checkboxes for levels 10–18) determines tile resolution. The UI shows estimated tile count and storage size before download begins.

**Service Worker cache.** A registered Service Worker intercepts tile requests and serves from IndexedDB when offline. When online, tiles are fetched normally and cached opportunistically. Stale tiles (>30 days) are refreshed when connectivity returns.

**Storage management.** A settings panel shows total cached tiles, storage used, and per-area breakdowns. Operators can delete cached areas individually or clear all cached tiles.

**Offline indicator.** When the browser detects no internet connectivity, the map displays an "Offline Mode" badge. Planning, editing, and saving missions to local storage continue to work. Missions are synced to the server when connectivity returns.

### 7.10 Mission Library

A secondary view (accessible via a tab or toggle) shows all saved missions for the selected drone:

**Mission cards.** Each card shows the mission name, waypoint count, total distance, estimated duration, status badge (draft / uploaded / completed), pattern type icon, and a thumbnail map preview.

**Actions.** Duplicate, export as `.plan` file (QGroundControl-compatible), import from `.plan` file, delete, upload to drone, and save as template.

**Version history.** Each mission maintains a version history — editing a previously-uploaded mission creates a new version rather than overwriting.

---

## 8. Companion Script Implementation

### 8.1 New Methods in `LogsOtaJobHandler`

The following methods are added to the existing `LogsOtaJobHandler` class in `logs_ota_service.py`:

```python
async def handle_arm_vehicle(self, job_payload: dict) -> bool:
    """
    Arm the vehicle motors. Does NOT start the mission.
    Starts a 30-second auto-disarm timer if start_mission is not received.
    Reports armed status back to Hub.
    """

async def handle_upload_mission(self, job_payload: dict) -> bool:
    """
    Upload waypoint mission + geofence + rally points to FC via MAVSDK.
    Steps: validate → build MissionPlan → upload mission → upload geofence → upload rally → verify
    Respects per-waypoint frame (GLOBAL_RELATIVE_ALT or GLOBAL_TERRAIN_ALT).
    Reports progress via /api/rest/mission/progress
    """

async def handle_download_mission(self, job_payload: dict) -> bool:
    """
    Download current mission from FC and report back to Hub.
    Used for syncing FC state after manual changes in Mission Planner desktop.
    """

async def handle_start_mission(self, job_payload: dict) -> bool:
    """
    Start mission execution (vehicle must already be armed).
    Cancels the auto-disarm timer.
    Subscribes to mission_progress and reports waypoint advancement.
    """

async def handle_pause_mission(self, job_payload: dict) -> bool:
    """
    Pause the current mission (enters HOLD mode via action.hold()).
    """

async def handle_rtl(self, job_payload: dict) -> bool:
    """
    Trigger immediate Return to Launch, aborting any active mission.
    """
```

### 8.2 MAVSDK Plugin Usage

| MAVSDK Plugin | Methods Used |
|---|---|
| `mission` | `upload_mission`, `download_mission`, `start_mission`, `pause_mission`, `clear_mission`, `set_current_mission_item`, `set_return_to_launch_after_mission`, `mission_progress` |
| `geofence` | `upload_geofence`, `clear_geofence` |
| `action` | `arm`, `disarm`, `return_to_launch`, `hold` |
| `telemetry` | `position`, `armed`, `in_air`, `flight_mode` (for monitoring) |

### 8.3 Auto-Disarm Timer

The companion script maintains an internal timer after a successful arm:

```python
async def _auto_disarm_watchdog(self, mission_id: str):
    """
    If start_mission is not received within 30s of arming,
    disarm the vehicle and report status back to 'uploaded'.
    """
    await asyncio.sleep(30)
    if self._armed_mission_id == mission_id and not self._mission_started:
        logger.warning("Auto-disarm: start_mission not received within 30s")
        await self.drone.action.disarm()
        await self.hub.report_mission_progress(
            mission_id=mission_id,
            status="uploaded",
            message="Auto-disarmed: start not received within 30s"
        )
```

### 8.4 Mission Progress Subscription

During mission execution, the companion script runs a background task that subscribes to `drone.mission.mission_progress()` and reports each waypoint transition to the Hub:

```python
async def _monitor_mission_progress(self, mission_id: str):
    async for progress in self.drone.mission.mission_progress():
        await self.hub.report_mission_progress(
            mission_id=mission_id,
            current_waypoint=progress.current,
            total_waypoints=progress.total,
        )
        if progress.current == progress.total:
            break  # Mission complete
```

---

## 9. API Surface

### 9.1 tRPC Router (`mission`)

| Procedure | Type | Auth | Description |
|---|---|---|---|
| `mission.list` | query | protected | List all missions for a drone |
| `mission.get` | query | protected | Get full mission with waypoints, geofences, rally points |
| `mission.create` | mutation | protected | Create a new mission (draft status) |
| `mission.createFromTemplate` | mutation | protected | Create a mission from a template with parameters |
| `mission.update` | mutation | protected | Update mission metadata and waypoints |
| `mission.delete` | mutation | protected | Soft-delete (archive) a mission |
| `mission.duplicate` | mutation | protected | Clone a mission (for multi-drone interim workflow) |
| `mission.upload` | mutation | protected | Create `upload_mission` job in queue |
| `mission.arm` | mutation | protected | Create `arm_vehicle` job in queue |
| `mission.start` | mutation | protected | Create `start_mission` job in queue |
| `mission.pause` | mutation | protected | Create `pause_mission` job in queue |
| `mission.rtl` | mutation | protected | Create RTL job in queue |
| `mission.download` | mutation | protected | Create `download_mission` job to sync from FC |
| `mission.import` | mutation | protected | Import from `.plan` file (QGC format) |
| `mission.export` | query | protected | Export as `.plan` file (QGC format) |
| `mission.validate` | query | protected | Run pre-flight validation checks |
| `mission.generatePattern` | mutation | protected | Generate waypoints from pattern parameters |
| `mission.saveAsTemplate` | mutation | protected | Save current mission as a reusable template |
| `mission.listTemplates` | query | protected | List available templates (built-in + custom) |
| `mission.getElevationProfile` | query | protected | Fetch terrain elevation along a path |

### 9.2 REST Endpoint (Companion → Hub)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/rest/mission/progress` | POST | Report mission upload, arm, or execution progress |

### 9.3 WebSocket Events

| Event | Direction | Payload |
|---|---|---|
| `mission_progress` | Server → Browser | `{ droneId, missionId, currentWaypoint, totalWaypoints, status, estimatedTimeRemaining }` |
| `mission_status_change` | Server → Browser | `{ droneId, missionId, oldStatus, newStatus, message }` |
| `mission_armed` | Server → Browser | `{ droneId, missionId, autoDisarmAt }` |

---

## 10. Pre-flight Validation

Before a mission can be uploaded, the system runs a validation checklist. All Error-level checks must pass before the upload job is created. Warning-level checks display alerts but allow override.

| Check | Severity | Rule |
|---|---|---|
| Takeoff command present | Error | First NAV command must be MAV_CMD_NAV_TAKEOFF |
| Geofence defined | Error | At least one inclusion boundary required |
| All waypoints inside geofence | Error | No waypoint may fall outside the inclusion fence |
| Path does not cross exclusion zones | Warning | Planned path should not intersect exclusion polygons |
| Maximum altitude within fence limit | Error | No waypoint altitude exceeds geofence max altitude |
| Minimum altitude above floor | Error | No waypoint altitude below geofence min altitude |
| Terrain clearance (if terrain mode) | Error | All terrain-following waypoints maintain >10m AGL clearance |
| RTL or Land at end | Warning | Mission should end with RTL or Land command |
| Reasonable speed values | Warning | Speed between 0.5 and 15 m/s for copter |
| Total distance within battery range | Warning | Estimated distance vs configured battery endurance |
| Rally points inside geofence | Warning | All rally points should be within inclusion boundary |
| Drone connected | Error | Companion computer must be online (lastSeen < 60s) |
| FC armed state | Info | Reports whether FC is currently armed |
| Frame consistency | Warning | Mixed frames (relative + terrain) in same mission flagged for review |
| Pattern overlap check | Info | For survey patterns, reports effective ground coverage % |

---

## 11. Import/Export Compatibility

The Mission Planner supports bidirectional conversion with the QGroundControl `.plan` file format [2], enabling interoperability with existing ground station software.

**Import** parses the JSON `.plan` file and maps each mission item's `command`, `frame`, and `params[1-7]` to the internal waypoint model. Geofence polygons and rally points from the `.plan` file are imported into their respective tables. The `frame` field is preserved during import, maintaining terrain-following settings from QGC.

**Export** generates a compliant `.plan` JSON file containing the mission items, geofence definitions, and rally points. This file can be opened in QGroundControl or Mission Planner for verification or further editing.

---

## 12. Implementation Phases

The Mission Planner is a substantial feature. The following phased approach allows incremental delivery with usable functionality at each stage. Survey patterns and templates are included in Phase 1 per design decision.

| Phase | Scope | Deliverables |
|---|---|---|
| **Phase 1: Core Planning + Patterns** | Map UI, waypoint CRUD, pattern generator (all 8 patterns), mission templates (6 built-in), mission library, database schema, offline tile caching, altitude frame selection | Operators can visually plan missions using patterns/templates, cache tiles for field use, and save missions |
| **Phase 2: Upload Pipeline + Arming** | Job queue integration, companion script handlers, MAVSDK upload, explicit arm/start sequence, auto-disarm timer | Missions can be safely pushed to the FC with two-step arming |
| **Phase 3: Geofence & Rally** | Geofence drawing tools, rally point placement, validation engine, terrain clearance checks | Safety boundaries enforced before upload |
| **Phase 4: Execution Monitor** | Live tracking overlay, progress reporting, pause/resume/RTL controls, terrain profile chart | Real-time mission monitoring from the browser |
| **Phase 5: Import/Export** | `.plan` file parsing and generation, version history, save-as-template | Interoperability with QGC and Mission Planner desktop |
| **Phase 6: Advanced Commands** | Spline waypoints, camera triggers, ROI, DO_JUMP, condition yaw, corridor scan | Full mission command vocabulary |

---

## 13. Technology Dependencies

| Component | Library / Service | Purpose |
|---|---|---|
| Map rendering | Leaflet + leaflet-draw | Interactive map with drawing tools |
| Geometry operations | Turf.js | Pattern generation, geofence containment checks, distance calculations |
| Offline tiles | Service Worker + IndexedDB | Tile caching for field use |
| Terrain elevation | Open-Elevation API (or MapTiler) | SRTM elevation data for terrain profile |
| Drag-and-drop | dnd-kit | Waypoint list reordering |
| Path visualization | Leaflet polyline + decorators | Flight path with direction arrows |
| Companion MAVSDK | mavsdk (Python) | Mission upload/download, arm, start, progress |

---

## References

[1]: https://mavlink.io/en/services/mission.html "MAVLink Mission Protocol"
[2]: https://dev.qgroundcontrol.com/master/en/file_formats/plan.html "QGroundControl Plan File Format"
[3]: http://mavsdk-python-docs.s3-website.eu-central-1.amazonaws.com/plugins/mission.html "MAVSDK Python Mission Plugin"
[4]: https://ardupilot.org/copter/docs/common-mavlink-mission-command-messages-mav_cmd.html "ArduPilot Mission Commands"
[5]: https://ardupilot.org/copter/docs/common-geofencing-landing-page.html "ArduPilot Geofencing"
