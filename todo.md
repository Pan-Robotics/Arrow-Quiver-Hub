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
