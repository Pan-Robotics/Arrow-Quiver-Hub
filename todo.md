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


## File Upload & Output Format

- [x] Add file upload button to AppBuilder UI for .py files
- [x] Implement file reading and validation on upload
- [x] Define standardized output data format for REST endpoints
- [x] Update parser template with output format specification
- [x] Document output format requirements

## UI Builder Implementation

- [x] Design UI builder schema (widget types, layouts, data bindings)
- [x] Create database table for UI configurations (already exists in customApps.uiSchema)
- [x] Build widget palette component
- [x] Implement drag-and-drop canvas (grid-based positioning)
- [x] Create property editor for widget configuration
- [x] Implement data binding system (connect widgets to parser output fields)
- [x] Add preview mode for testing custom app UI
- [x] Backend schema extraction API (extractSchema endpoint)
- [x] Debug schema extraction workflow
- [ ] Create dynamic component renderer
- [ ] Test complete app creation workflow (parser + UI)

## Complete App Lifecycle Implementation

### App Persistence & Deployment
- [ ] Fix schema extraction workflow (Continue to UI Builder button)
- [x] Implement saveApp backend API (save parser + UI schema to database)
- [x] Add app status field (draft, published)
- [ ] Create app publishing workflow

### App Store Integration
- [x] Display saved custom apps in App Store
- [x] Show app cards with name, description, icon
- [x] Add "Install" button for published apps
- [ ] Track installed apps per user
- [ ] Implement app installation logic

### Sidebar Integration
- [ ] Add installed apps to sidebar navigation
- [ ] Generate dynamic routes for custom apps
- [ ] Create app icons/badges for sidebar

### Dynamic App Renderer
- [ ] Create CustomAppRenderer component
- [ ] Implement widget rendering (Text, Gauge, Chart, LED, Map, Video, Canvas)
- [ ] Connect widgets to live data via WebSocket
- [ ] Handle data binding and updates
- [ ] Implement responsive grid layout

### REST Endpoint Generation
- [ ] Generate `/api/rest/payload/{app_id}/ingest` endpoints
- [ ] Execute parser on incoming payload
- [ ] Validate payload against parser
- [ ] Broadcast parsed data via WebSocket to app viewers
- [ ] Add authentication/API key validation

### Parser Enhancement for Quiver
- [ ] Update parser template with REST endpoint creation code
- [ ] Add Flask/FastAPI server setup in parser template
- [ ] Include WebSocket broadcasting in parser
- [ ] Add deployment instructions for Quiver devices
- [ ] Create example parser for rplidar_forwarder.py pattern

## Bug Fixes Needed

### UI Builder Issues
- [x] Fix widget rendering in UI Builder canvas (widgets not appearing after drag-and-drop)
- [x] Test complete workflow: create app → design UI → save → verify in App Store
- [x] Ensure saved UI schema properly stores widget configurations
- [x] Verify app publishing workflow (draft → published status)

## App Installation & Dynamic Rendering

### User-App Installation System
- [x] Create userApps table to track installed apps per user
- [x] Add installApp backend API (database function)
- [x] Add uninstallApp backend API (database function)
- [x] Implement Install button functionality in AppStore
- [x] Update sidebar to show installed custom apps
- [x] Add app icons to sidebar navigation (using Sparkles icon)

### REST API Endpoints
- [x] Create dynamic REST endpoint `/api/rest/payload/{app_id}/ingest`
- [x] Implement parser execution on payload ingestion
- [x] Store parsed data in database (appData table)
- [ ] Add API key validation for REST endpoints (optional - currently public)
- [x] Return parsed data in response

### WebSocket Broadcasting
- [x] Create WebSocket room for each custom app (app:${appId})
- [x] Broadcast parsed data to connected clients
- [x] Implement client-side WebSocket subscription (in AppRenderer)
- [x] Handle real-time data updates in UI (in AppRenderer)

### Dynamic App Renderer
- [x] Create AppRenderer component
- [x] Implement widget rendering from UI schema
- [x] Connect widgets to live data from WebSocket
- [x] Handle Text widget rendering
- [x] Handle Gauge widget rendering
- [x] Handle Line Chart widget rendering (basic)
- [x] Handle Bar Chart widget rendering (basic)
- [x] Handle LED Indicator widget rendering
- [ ] Handle Map widget rendering
- [ ] Handle Video widget rendering
- [ ] Handle Canvas widget rendering

### Dynamic Routing
- [x] Create dynamic route for custom apps (handled by Home.tsx)
- [x] Load app configuration from database
- [x] Render AppRenderer with UI schema
- [x] Add navigation from sidebar to app view
- [x] Handle app not found errors

### Testing & Integration
- [x] Test complete workflow: create → install → view → send data → see live updates
- [ ] Test multiple users installing same app
- [ ] Test uninstalling apps
- [x] Test REST endpoint with real payloads
- [x] Verify WebSocket broadcasting works correctly
- [x] Fix AppRenderer to read dataBinding.field correctly
- [x] Verify real-time widget updates (25 → 85 confirmed working)

## Widget Testing & Enhancement

### Test All Widget Types
- [x] Create comprehensive test app with all 8 widget types
- [x] Test Text Display widget
- [x] Test Gauge widget
- [x] Test Line Chart widget (Fixed - now renders correctly)
- [x] Test Bar Chart widget (Fixed - now renders correctly)
- [x] Test LED Indicator widget
- [x] Test Map widget
- [x] Test Video widget
- [x] Test Canvas widget
- [x] Fix chart widget type naming inconsistency (line-chart, bar-chart)
- [x] Update AppRenderer to recognize line-chart and bar-chart types

### Enhanced Widget Implementations
- [x] Implement Map widget with GPS coordinates (lat/lon display)
- [ ] Add marker support to Map widget (basic lat/lon display implemented)
- [x] Implement Video widget with live stream URL support
- [x] Add video controls (play/pause/fullscreen)
- [x] Implement Canvas widget for custom visualizations (basic placeholder)
- [ ] Add point cloud rendering support to Canvas widget (future enhancement)
- [ ] Test all enhanced widgets with real data

## App Management Dashboard

- [x] Create App Management page (AppManagement.tsx)
- [x] List all installed apps with status
- [x] Add edit functionality (update parser and UI)
- [x] Implement app versioning system
- [x] Add app export functionality (download as JSON package)
- [x] Add app uninstall functionality
- [ ] Show app usage statistics (API calls, data volume)
- [x] Add app details view (parser code, schemas)
- [x] Add Manage Apps button to App Store header
- [x] Integrate AppManagement into Home.tsx routing

## Quiver Deployment Template

- [x] Update parser template with Flask server setup
- [x] Add REST API endpoint creation code
- [x] Include WebSocket broadcasting setup (optional)
- [x] Add deployment instructions for Quiver devices
- [x] Create requirements.txt (flask, requests)
- [x] Add systemd service file template
- [x] Document edge deployment workflow
- [x] Create complete deployment template (QUIVER_DEPLOYMENT_TEMPLATE.md)
- [x] Add reference to deployment docs in AppBuilder parser template

## Widget Testing & Point Cloud Visualization

- [ ] Create comprehensive test app with all 8 widget types
- [ ] Add test data for GPS coordinates (Map widget)
- [ ] Add test data for video URL (Video widget)
- [ ] Add test data for array data (Line Chart, Bar Chart)
- [ ] Add test data for boolean (LED widget)
- [ ] Test Map widget with live GPS data
- [ ] Test Video widget with live stream URL
- [x] Install Recharts library for chart rendering
- [x] Create LineChartWidget component
- [x] Create BarChartWidget component
- [x] Integrate chart widgets into AppRenderer
- [x] Test Line Chart widget rendering (placeholder working)
- [x] Test Bar Chart widget rendering (placeholder working)
- [x] Update comprehensive_widget_test_parser.py to bind temp_history to Line Chart
- [x] Update comprehensive_widget_test_parser.py to bind sensor_readings to Bar Chart
- [x] Update widget data bindings in database
- [x] Create sendTestPayload endpoint for testing apps
- [x] Fix PointCloudCanvas undefined error
- [ ] Test Line Chart with live time-series data (ready for testing)
- [ ] Test Bar Chart with live categorical data (ready for testing)
- [x] Install Three.js for point cloud visualization
- [x] Implement Canvas widget with Three.js renderer
- [x] Add point cloud data format support (x, y, z coordinates)
- [x] Implement camera controls (pan, zoom, rotate)
- [x] Add color mapping for point cloud (by distance/intensity)
- [x] Create PointCloudCanvas component for AppRenderer
- [x] Test Canvas widget rendering (waiting for live data)
- [ ] Test Canvas widget with live RPLidar point cloud data

## App Editing Functionality

- [ ] Add Edit button to App Management Dashboard
- [ ] Create AppEditor component (reuse AppBuilder logic)
- [ ] Load existing parser code and UI schema for editing
- [x] Implement updateApp backend API
- [x] Add app version history schema to database
- [x] Create appVersions table for version tracking
- [x] Add version management database functions
- [x] Implement getVersionHistory and rollbackToVersion endpoints
- [ ] Implement version history display in AppEditor
- [ ] Add rollback functionality UI
- [x] Test app editing workflow (edit → save → verify changes)

## AppBuilder State Management Fix

- [ ] Diagnose React state synchronization issue in AppBuilder
- [ ] Identify why form inputs don't update state properly
- [ ] Fix appName state management
- [ ] Fix description state management
- [ ] Fix parserCode state management
- [ ] Ensure "Continue to UI Builder" button works correctly
- [ ] Test schema extraction with fixed state
- [ ] Test complete app creation workflow through UI
- [ ] Create comprehensive test app with all 8 widget types via UI
- [ ] Verify all widgets (Text, Gauge, LED, Map, Video, Line Chart, Bar Chart, Canvas) render correctly
- [ ] Test with live data for each widget type

## AppBuilder State Management Fix (Current Priority)

- [x] Analyze AppBuilder component structure and state flow
- [x] Identify all state variables and their dependencies
- [x] Check for unnecessary re-renders causing state reset
- [x] Refactor useState initialization to prevent default template resets
- [x] Add useEffect to sync state with localStorage
- [x] Implement form data persistence (save on every change)
- [x] Add form data restoration on component mount
- [ ] Fix "Continue to UI Builder" validation logic
- [ ] Add debug logging for state changes
- [ ] Test manual form filling workflow
- [ ] Test file upload workflow
- [ ] Test schema extraction and UI Builder transition
- [ ] Create comprehensive test app via UI (all 8 widgets)
- [ ] Verify app saves correctly to database
- [ ] Verify app appears in App Store
- [ ] Verify app can be installed and viewed

## Comprehensive App Creation Workflow Test

- [ ] Clear localStorage to start fresh
- [ ] Open App Store through UI
- [ ] Click "Start Building" to open AppBuilder
- [ ] Fill in app name: "Complete Widget Test"
- [ ] Fill in description
- [ ] Verify localStorage saves app name
- [ ] Upload comprehensive parser file (.py)
- [ ] Verify localStorage saves parser code
- [ ] Update test data with comprehensive inputs
- [ ] Test parser execution
- [ ] Click "Continue to UI Builder"
- [ ] Verify schema extraction succeeds
- [ ] Add Text Display widget
- [ ] Add Gauge widget
- [ ] Add LED Indicator widget
- [ ] Add Line Chart widget
- [ ] Add Bar Chart widget
- [ ] Add Map widget
- [ ] Add Video widget
- [ ] Add Canvas widget (placeholder)
- [ ] Configure widget properties and data bindings
- [ ] Click "Save UI"
- [ ] Verify app saves to database
- [ ] Verify localStorage is cleared after save
- [ ] Check App Store for new app
- [ ] Install the app
- [ ] Send test payload via REST API
- [ ] Verify all widgets render with live data
- [ ] Document test results


## "No Apps Installed" Page Bug Fixes

- [x] Fix non-working "Go to App Store" button
- [x] Fix page blocking built-in apps (RPLidar, Flight Telemetry) when no custom apps installed
- [x] Ensure built-in apps remain accessible regardless of custom app installation status
- [x] Test navigation between built-in apps and custom apps


## TypeScript Compilation Errors

- [x] Fix AppSidebar.tsx type error (line 53: Type 'number' is not assignable to type 'never')
- [x] Fix AppStore.tsx type errors (line 166: Type 'string' and 'number' not assignable to type 'never')
- [x] Verify clean TypeScript compilation

## App Installation Bug

- [x] Investigate getUserApps query returning empty list (was empty because no apps installed)
- [x] Fix app installation not persisting to user_apps table (working correctly)
- [x] Test app installation workflow (install → verify in management → uninstall)
- [x] Verify installed apps appear in sidebar


## UI Builder Preview Button Bug

- [ ] Investigate why Preview button doesn't work in UIBuilder
- [ ] Fix Preview button click handler
- [ ] Test Preview functionality with sample app
- [ ] Verify preview shows correct widget layout


## App Edit Functionality Implementation

- [ ] Add Edit button to App Management dashboard
- [ ] Create getAppById tRPC endpoint to fetch app details
- [ ] Update AppBuilder to accept editMode and appId props
- [ ] Load existing app data into AppBuilder form (name, description, parser code)
- [ ] Load existing UI schema into UIBuilder
- [ ] Modify saveApp to create version snapshot before update
- [ ] Update AppStore to support edit mode navigation
- [ ] Test complete edit workflow (load → modify → save → verify version)
- [ ] Add version history display in App Management

## App Deletion Feature

- [x] Add deleteApp backend function with cascade deletion
- [x] Add deleteApp tRPC procedure
- [x] Add Delete button to App Management page
- [x] Add confirmation dialog for app deletion
- [x] Test complete deletion workflow (delete app → verify all related data removed)

## Production Deployment Issues

- [x] Fix Python parser execution error on production server (spawn /usr/bin/python3.11 ENOENT)
- [x] Implement flexible Python version detection (try python3.11, python3, python)
- [x] Test parser execution on production environment

## Convert Flight Telemetry to Installable App

- [x] Restore TelemetryApp component functionality
- [x] Create built-in app installation system
- [x] Make Flight Telemetry installable from App Store
- [x] Test installation and functionality
- [x] Verify sidebar icon appears after installation

## App Uninstall UI

- [x] Add Uninstall button to App Management page
- [x] Implement uninstall mutation and confirmation dialog
- [x] Test uninstalling Flight Telemetry app
- [x] Verify app disappears from sidebar after uninstall

## Protect Built-in Apps from Deletion

- [x] Hide "Delete App Permanently" button for built-in apps in App Management
- [x] Keep Delete button only for custom apps
- [x] Test with Flight Telemetry to verify Delete button is hidden
