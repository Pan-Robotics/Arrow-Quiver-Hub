# RPLidar Terrain Mapping Web Server - TODO

## Core Features

- [x] Point cloud data reception endpoint (HTTP POST)
- [x] WebSocket server for real-time updates
- [x] In-memory buffer for recent scans
- [x] Database schema for point cloud metadata
- [x] Real-time Cartesian visualization (Canvas)
- [x] Statistics display (points, scans, connection status)
- [x] API key authentication
- [x] Multiple drone support (by drone_id)
- [ ] Scan history viewer
- [ ] Export functionality (JSON, CSV)

## UI Components

- [x] Live point cloud canvas visualization
- [x] Connection status indicator
- [x] Statistics panel (scan rate, point count, etc.)
- [x] Drone selector (if multiple drones)
- [x] Zoom and pan controls
- [x] Color coding options (by quality/distance)
- [ ] Time range selector for history

## Backend

- [x] tRPC procedure for receiving point cloud data
- [x] WebSocket broadcast to connected clients
- [x] Ring buffer for recent scans (configurable size)
- [x] Database queries for historical data
- [x] API key validation middleware

## Deployment

- [ ] Environment configuration
- [ ] Production build
- [ ] Documentation

## Critical Bugs

- [x] tRPC endpoint not accepting external HTTP POST requests - create REST endpoint for point cloud ingestion

## Mock Data Testing

- [x] Create mock lidar data generator
- [x] Test REST API with mock data
- [x] Verify WebSocket broadcasting
- [x] Verify frontend visualization displays mock data
- [x] Document final API URLs

## Published Site Issues

- [x] WebSocket not working on published site - implement polling fallback for real-time updates

## Performance Issues

- [x] Forwarder only sending at 0.1 Hz (should be 10 Hz) - 99% packet drop rate
- [x] Identify HTTP request bottleneck
- [x] Fix forwarder to achieve 10 Hz forwarding rate

## Critical Issues After Restart

- [x] Forwarder still at 0.1 Hz TX rate despite optimization (not using new defaults)
- [x] RX rate wildly unstable: 450 Hz → 60 Hz → 10 Hz after restart (was cumulative average display)
- [x] Request timeouts and connection errors occurring (was point format mismatch)
- [x] Old forwarder file still running (optimization not applied) - fixed with verification script

## UAV Data Hub Transformation

- [x] Left sidebar navigation with app icons
- [x] App switcher functionality (toggle between different data pipelines)
- [x] Refactor LiDAR visualization as modular app component
- [x] Add "+" button at bottom of sidebar for app store access
- [x] App store placeholder page
- [ ] App registry/management system
- [ ] Multi-app layout system


## Rebranding to Quiver Hub

- [x] Update site title to "Quiver Hub"
- [ ] Update environment variable VITE_APP_TITLE (user must update via Settings UI)
- [x] Update all page titles and headers
- [x] Update meta tags and descriptions
- [x] Reflect RPLidar as subordinate app in branding


## Documentation

- [x] Update README with Quiver Hub architecture and future direction


## Flight Telemetry Pipeline

- [x] Design telemetry data schema (attitude, position, GPS, battery)
- [x] Create multi-threaded telemetry forwarder (MAVLink + UAVCAN)
- [x] Add REST API endpoint for telemetry ingestion
- [x] Add WebSocket broadcast for real-time telemetry
- [x] Create TelemetryApp component with attitude indicator
- [x] Add position display (lat/lon/alt)
- [x] Add GPS status widget
- [x] Add battery status widgets (FC + UAVCAN)
- [x] Integrate telemetry app into sidebar
- [ ] Test concurrent operation with RPLidar pipeline

## App Builder Platform

### Phase 1: Payload Parser Upload (Current)
- [x] Create database table for custom apps
- [x] Design payload parser interface specification
- [x] Build parser upload UI in app store
- [x] Implement Python script validation
- [x] Create parser testing interface with sample data
- [x] Backend API for parser execution (sandboxed Python 3.11)
- [ ] Generate dynamic REST endpoints for custom apps
- [ ] Test end-to-end parser workflow

### Phase 2: UI Builder (Next)
- [ ] Design app definition schema (JSON format for app config)
- [ ] Design UI component schema (layout, widgets, data bindings)
- [ ] Create database table for UI schemas
- [ ] Design app versioning and update system

### App Builder UI
- [ ] Create app builder page (accessible from app store)
- [ ] Implement drag-and-drop canvas for UI layout
- [ ] Create widget palette (text, charts, gauges, canvas, video, buttons)
- [ ] Add property editor for widget configuration
- [ ] Implement data binding UI (connect widgets to payload fields)
- [ ] Add preview mode for testing app layout

### Payload Parser System
- [x] Create payload parser upload interface
- [x] Implement Python script validation and sandboxing
- [x] Create parser execution environment (isolated Python 3.11)
- [x] Add parser testing interface with sample data
- [x] Write comprehensive tests for parser execution
- [ ] Generate REST API endpoint for each custom app
- [ ] Implement WebSocket broadcasting for custom apps

### UI Component Library
- [ ] Create dynamic component renderer (renders from JSON schema)
- [ ] Implement text display widget
- [ ] Implement chart widget (line, bar, gauge)
- [ ] Implement canvas widget (for custom visualizations)
- [ ] Implement video/image widget
- [ ] Implement button/control widget
- [ ] Add responsive layout system

### App Store Integration
- [ ] Create app publishing workflow
- [ ] Add app metadata editor (name, description, icon, screenshots)
- [ ] Implement app store listing page
- [ ] Add app installation system
- [ ] Create app marketplace with search and categories
- [ ] Implement app ratings and reviews

### Developer Tools
- [ ] Create developer documentation
- [ ] Add example apps and templates
- [ ] Create payload parser API reference
- [ ] Add debugging tools for custom apps
- [ ] Implement app analytics dashboard

