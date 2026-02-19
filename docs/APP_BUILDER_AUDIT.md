# App Builder Developer Experience Audit

## Current Workflow (Step by Step)

1. Click "+" in sidebar → App Store opens
2. Click "Start Building" → AppBuilder opens
3. Enter app name and description
4. Write/upload Python parser code (with SCHEMA definition)
5. Enter test JSON data and click "Test Parser"
6. Click "Continue to UI Builder" → schema extracted from parser's SCHEMA dict
7. Add widgets from palette (Text, Gauge, Line Chart, Bar Chart, LED, Map, Video, Canvas)
8. Configure each widget: data binding (field from schema), position, size, styling
9. Click "Save UI" → app saved to database with status "published"
10. App appears in App Store → user clicks "Install" → app appears in sidebar
11. Data arrives via `POST /api/rest/payload/{appId}/ingest` → parser executes → data broadcast via WebSocket → AppRenderer displays

## Identified Limitations

### Critical Limitations (Blocking Real Use Cases)

| # | Limitation | Impact | Example |
|---|-----------|--------|---------|
| 1 | **No cross-app data subscription** | Apps can only receive data via their own REST endpoint. Cannot tap into existing streams (RPLidar, telemetry). | A developer building a "Terrain Analyzer" can't subscribe to the RPLidar point cloud stream — they'd need to duplicate the forwarder. |
| 2 | **Parser is the only data source** | Every app must have a Python parser. No option for "passthrough" (raw JSON → widgets) or "subscribe to existing stream". | A simple dashboard that just displays RPLidar stats doesn't need a parser — it just needs to subscribe to the pointcloud stream. |
| 3 | **No data source configuration in UI** | The App Builder has no way to configure WHERE data comes from. It assumes the app's own REST endpoint is the only source. | Developer can't select "Subscribe to RPLidar stream" or "Subscribe to Telemetry stream" as a data source. |
| 4 | **Single data binding per widget** | Each widget can only bind to ONE field. Canvas widget can't bind to both `point_cloud` (array) and `point_count` (number). | A canvas widget showing a point cloud can't also display a stat overlay from a different field. |
| 5 | **No API key management for custom apps** | Custom app REST endpoints (`/api/rest/payload/{appId}/ingest`) have no authentication. Anyone can push data. | Security risk for production deployments. |

### Moderate Limitations (Reducing Developer Flexibility)

| # | Limitation | Impact |
|---|-----------|--------|
| 6 | **No widget-level data transformation** | Can't apply formulas (e.g., `distance_mm / 1000` to get meters) in the UI Builder. Must do it in the parser. |
| 7 | **No conditional widget visibility** | Can't show/hide widgets based on data values (e.g., show warning only when battery < 20%). |
| 8 | **No inter-widget communication** | Clicking a button widget can't trigger an action or filter data in another widget. |
| 9 | **Limited canvas widget config in UI Builder** | Canvas widget has only backgroundColor and renderMode in the properties panel. No config for pointSize, colorMode, distance range, etc. |
| 10 | **No real drag-and-drop** | Widgets are added by clicking, positioned by typing row/col numbers. Not true drag-and-drop. |
| 11 | **No widget templates/presets** | No "RPLidar Point Cloud" preset that pre-configures a canvas widget with the right settings. |
| 12 | **Parser output schema is static** | SCHEMA must be defined at build time. Can't have dynamic fields that appear based on the payload. |

### Minor Limitations (Polish/UX)

| # | Limitation | Impact |
|---|-----------|--------|
| 13 | **No live preview with real data** | Preview mode shows placeholder values, not actual data from the REST endpoint. |
| 14 | **No undo/redo in UI Builder** | Accidentally deleting a widget requires re-adding and reconfiguring it. |
| 15 | **No widget duplication** | Can't clone a configured widget to create a similar one. |
| 16 | **No import/export of app definitions** | Can't share app configurations between Quiver Hub instances. |

## Proposed Solutions (Priority Order)

### P0: Data Source Configuration (Solves #1, #2, #3)

Add a "Data Source" configuration step to the App Builder that lets developers choose:

1. **Own REST Endpoint** (current behavior) — app gets its own `/api/rest/payload/{appId}/ingest` endpoint with a Python parser
2. **Subscribe to Existing Stream** — app subscribes to an existing WebSocket channel:
   - `pointcloud` (RPLidar data)
   - `telemetry` (Flight telemetry)
   - `camera_status` (Camera feed)
   - Any other custom app's stream (by appId)
3. **Passthrough (No Parser)** — raw JSON is passed directly to widgets without transformation

This would allow developers to build visualization-only apps that consume existing data streams without needing to set up their own forwarder.

### P1: Enhanced Canvas Widget Config (Solves #9)

Add canvas-specific configuration options to the UI Builder properties panel:
- Point size slider
- Color mode selector (distance/intensity/angle)
- Distance range (min/max)
- Background color
- Show/hide grid and axes
- Canvas height

### P2: Widget Presets/Templates (Solves #11)

Add pre-configured widget templates:
- "RPLidar Point Cloud" → Canvas widget with distance coloring, 2D default
- "GPS Map" → Map widget with lat/lon bindings
- "Battery Gauge" → Gauge widget with 0-100% range
- "Attitude Indicator" → Custom canvas for roll/pitch/yaw

### P3: API Key for Custom Apps (Solves #5)

Generate an API key when a custom app is created, and require it in the REST endpoint.
