# Quiver SDK Architecture
## Level 4: API Reference & Data Models

**Document Version:** 1.0  
**Date:** January 2026  
**Author:** Manus AI  
**Classification:** Technical Reference

---

## Introduction

This document provides a complete reference for all APIs, protocols, and data models used in the Quiver SDK. It serves as the authoritative source for developers implementing payload drivers, companion computer applications, or ground control extensions. All message formats, function signatures, and data structures are documented with examples.

---

## Payload Discovery Protocol

### HTTP Discovery Endpoint

Payloads that connect via Ethernet must implement an HTTP discovery endpoint that allows the Payload Manager to identify them.

**Endpoint**: `GET http://<payload-ip>/quiver/info`

**Response Format** (JSON):

```json
{
  "payload_type": "camera",
  "manufacturer": "Example Corp",
  "model": "HD-1080",
  "version": "1.2.3",
  "serial_number": "CAM-12345",
  "capabilities": [
    "video_streaming",
    "photo_capture",
    "gimbal_control"
  ],
  "protocols": {
    "control": "http",
    "telemetry": "mqtt",
    "streaming": "rtsp"
  },
  "endpoints": {
    "control_api": "http://192.168.144.11:8080/api",
    "telemetry_topic": "quiver/payloads/camera1",
    "video_stream": "rtsp://192.168.144.11:8554/stream"
  }
}
```

**Field Descriptions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| payload_type | string | Yes | Category of payload (camera, lidar, sensor, actuator, etc.) |
| manufacturer | string | Yes | Manufacturer name |
| model | string | Yes | Model identifier |
| version | string | Yes | Firmware/software version (semantic versioning) |
| serial_number | string | No | Unique device serial number |
| capabilities | array[string] | Yes | List of supported capabilities |
| protocols | object | Yes | Communication protocols used |
| endpoints | object | Yes | URLs/addresses for accessing payload services |

---

## Payload Control API

### HTTP REST API

Payloads that use HTTP for control must implement the following standard endpoints.

#### Health Check

**Endpoint**: `GET /quiver/health`

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2026-01-08T12:34:56.789Z",
  "uptime": 3600
}
```

**Status Values**: `ok`, `degraded`, `error`

#### Get Status

**Endpoint**: `GET /quiver/status`

**Response**:
```json
{
  "power": {
    "voltage": 12.1,
    "current": 0.5,
    "temperature": 35.2
  },
  "operational_state": "active",
  "error_code": 0,
  "error_message": "",
  "custom_fields": {
    "recording": true,
    "storage_remaining_mb": 15360
  }
}
```

#### Send Command

**Endpoint**: `POST /quiver/command`

**Request Body**:
```json
{
  "command": "start_recording",
  "parameters": {
    "resolution": "1920x1080",
    "framerate": 30,
    "bitrate": 5000
  }
}
```

**Response**:
```json
{
  "success": true,
  "message": "Recording started",
  "execution_time_ms": 123
}
```

**Standard Commands**:

| Command | Parameters | Description |
|---------|------------|-------------|
| start_recording | resolution, framerate, bitrate | Begin video/data recording |
| stop_recording | - | Stop recording |
| capture_image | resolution, format | Capture a single image |
| set_parameter | name, value | Modify a configuration parameter |
| reset | - | Reset payload to default state |
| shutdown | - | Graceful shutdown |

#### Get/Set Parameters

**Endpoint**: `GET /quiver/parameters`

**Response**:
```json
{
  "parameters": [
    {
      "name": "exposure_time",
      "value": 10.0,
      "type": "float",
      "min": 0.1,
      "max": 1000.0,
      "unit": "ms",
      "description": "Camera exposure time"
    },
    {
      "name": "gain",
      "value": 2.5,
      "type": "float",
      "min": 1.0,
      "max": 16.0,
      "unit": "dB",
      "description": "Sensor gain"
    }
  ]
}
```

**Endpoint**: `PUT /quiver/parameters/{name}`

**Request Body**:
```json
{
  "value": 15.0
}
```

**Response**:
```json
{
  "success": true,
  "parameter": "exposure_time",
  "old_value": 10.0,
  "new_value": 15.0
}
```

---

## Telemetry Data Models

### MQTT Telemetry Format

Payloads publish telemetry to MQTT topics using JSON format. Each message must include a timestamp and payload identifier.

**Topic Pattern**: `quiver/payloads/<payload_id>/<data_type>`

**Example Topics**:
- `quiver/payloads/camera1/status`
- `quiver/payloads/lidar1/pointcloud`
- `quiver/payloads/sensor1/environment`

**Message Format**:

```json
{
  "timestamp": "2026-01-08T12:34:56.789Z",
  "payload_id": "camera1",
  "data": {
    "temperature": 35.2,
    "voltage": 12.1,
    "recording": true,
    "storage_remaining_mb": 15360
  }
}
```

### Standard Telemetry Types

#### Environmental Sensor

```json
{
  "timestamp": "2026-01-08T12:34:56.789Z",
  "payload_id": "env_sensor1",
  "data": {
    "temperature_c": 25.3,
    "humidity_percent": 65.2,
    "pressure_hpa": 1013.25,
    "air_quality_index": 42
  }
}
```

#### GPS Receiver

```json
{
  "timestamp": "2026-01-08T12:34:56.789Z",
  "payload_id": "gps1",
  "data": {
    "latitude": 37.7749,
    "longitude": -122.4194,
    "altitude_m": 123.45,
    "fix_type": "3d",
    "satellites": 12,
    "hdop": 0.9,
    "speed_mps": 5.2,
    "heading_deg": 45.0
  }
}
```

#### LiDAR Scanner

```json
{
  "timestamp": "2026-01-08T12:34:56.789Z",
  "payload_id": "lidar1",
  "data": {
    "point_count": 1024,
    "scan_rate_hz": 10,
    "range_min_m": 0.15,
    "range_max_m": 120.0,
    "points": [
      {"x": 1.23, "y": 4.56, "z": 0.78, "intensity": 200},
      {"x": 1.24, "y": 4.57, "z": 0.79, "intensity": 195}
    ]
  }
}
```

For high-frequency data (>10 Hz) or large point clouds, use binary formats (Protocol Buffers, MessagePack) or UDP streaming instead of MQTT.

---

## MAVLink Custom Messages

### PAYLOAD_STATUS (ID: 50000)

Reports payload health and operational status.

**Fields**:

| Field | Type | Units | Description |
|-------|------|-------|-------------|
| payload_id | uint8_t | - | Payload identifier (1-3 for C1-C3) |
| status | uint8_t | - | Status flags (see below) |
| temperature | float | °C | Payload temperature |
| voltage | float | V | Supply voltage |
| current | float | A | Current draw |
| uptime | uint32_t | s | Seconds since payload boot |

**Status Flags** (bitmask):
- Bit 0: Active (1 = payload is operational)
- Bit 1: Error (1 = payload has encountered an error)
- Bit 2: Recording (1 = payload is recording data)
- Bit 3: Streaming (1 = payload is streaming data)
- Bit 4-7: Reserved

**Python Example** (using pymavlink):

```python
from pymavlink import mavutil

# Create connection
mav = mavutil.mavlink_connection('udp:127.0.0.1:14550')

# Send PAYLOAD_STATUS message
mav.mav.payload_status_send(
    payload_id=1,
    status=0b00000101,  # Active + Recording
    temperature=35.2,
    voltage=12.1,
    current=0.5,
    uptime=3600
)
```

### LIDAR_SCAN_DATA (ID: 50001)

Transmits compressed LiDAR point cloud data.

**Fields**:

| Field | Type | Units | Description |
|-------|------|-------|-------------|
| payload_id | uint8_t | - | Payload identifier |
| sequence | uint16_t | - | Packet sequence number |
| point_count | uint16_t | - | Number of points in this packet |
| compression | uint8_t | - | Compression type (0=none, 1=zlib, 2=lz4) |
| data | uint8_t[200] | - | Point cloud data (compressed) |

**Data Format** (uncompressed):

Each point is encoded as 12 bytes:
- X coordinate: float (4 bytes)
- Y coordinate: float (4 bytes)
- Z coordinate: float (4 bytes)

For intensity data, add 1 byte per point (uint8_t, 0-255).

### PAYLOAD_COMMAND (ID: 50002)

Sends commands to payloads via MAVLink.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| payload_id | uint8_t | Target payload identifier |
| command_id | uint16_t | Command identifier (see table below) |
| param1 | float | Command parameter 1 |
| param2 | float | Command parameter 2 |
| param3 | float | Command parameter 3 |
| param4 | float | Command parameter 4 |

**Standard Command IDs**:

| ID | Command | param1 | param2 | param3 | param4 |
|----|---------|--------|--------|--------|--------|
| 1 | Activate | Mode (0=off, 1=on) | - | - | - |
| 2 | Start Recording | Resolution width | Resolution height | Framerate | Bitrate |
| 3 | Stop Recording | - | - | - | - |
| 4 | Capture Image | - | - | - | - |
| 5 | Set Parameter | Parameter ID | Value | - | - |

---

## DroneCAN Message Definitions

### Quiver Payload Status

**Message Name**: `com.quiver.PayloadStatus`

**DSDL Definition**:

```
# com/quiver/PayloadStatus.uavcan
#
# Payload status information
#

uint8 payload_id      # Payload identifier (1-3)
uint8 status          # Status flags (same as MAVLink PAYLOAD_STATUS)
float32 temperature   # Temperature in Celsius
float32 voltage       # Supply voltage in Volts
float32 current       # Current draw in Amperes
uint32 uptime         # Uptime in seconds

@assert _offset_ % 8 == {0}
```

**C++ Example** (using libuavcan):

```cpp
#include <uavcan/uavcan.hpp>
#include "com/quiver/PayloadStatus.hpp"

void publishPayloadStatus(uavcan::INode& node)
{
    com::quiver::PayloadStatus msg;
    msg.payload_id = 1;
    msg.status = 0x05;  // Active + Recording
    msg.temperature = 35.2;
    msg.voltage = 12.1;
    msg.current = 0.5;
    msg.uptime = 3600;
    
    static uavcan::Publisher<com::quiver::PayloadStatus> pub(node);
    pub.broadcast(msg);
}
```

---

## Payload Driver API

### Python Driver Interface

Payload drivers implement a standard Python interface that allows the Payload Manager to control them.

**Base Class**:

```python
# /opt/quiver/sdk/payload_driver.py

from abc import ABC, abstractmethod
from typing import Dict, Any

class PayloadDriver(ABC):
    """Base class for all payload drivers"""
    
    def __init__(self, payload_id: str, connection_params: Dict[str, Any]):
        """
        Initialize the driver.
        
        Args:
            payload_id: Unique identifier for this payload instance
            connection_params: Connection parameters (IP address, port, etc.)
        """
        self.payload_id = payload_id
        self.connection_params = connection_params
        self.running = False
    
    @abstractmethod
    async def initialize(self) -> bool:
        """
        Initialize the payload connection.
        
        Returns:
            True if initialization succeeded, False otherwise
        """
        pass
    
    @abstractmethod
    async def get_status(self) -> Dict[str, Any]:
        """
        Get current payload status.
        
        Returns:
            Dictionary containing status fields
        """
        pass
    
    @abstractmethod
    async def send_command(self, command: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """
        Send a command to the payload.
        
        Args:
            command: Command name
            parameters: Command parameters
            
        Returns:
            Dictionary containing command result
        """
        pass
    
    @abstractmethod
    async def shutdown(self):
        """Gracefully shut down the payload connection"""
        pass
    
    async def start(self):
        """Start the driver (called by Payload Manager)"""
        self.running = True
        if not await self.initialize():
            raise RuntimeError(f"Failed to initialize payload {self.payload_id}")
    
    async def stop(self):
        """Stop the driver (called by Payload Manager)"""
        self.running = False
        await self.shutdown()
```

**Example Implementation** (HTTP Camera Driver):

```python
# /opt/quiver/payload-drivers/http_camera.py

import aiohttp
from payload_driver import PayloadDriver

class HTTPCameraDriver(PayloadDriver):
    """Driver for HTTP-based camera payloads"""
    
    async def initialize(self) -> bool:
        self.base_url = f"http://{self.connection_params['ip_address']}:{self.connection_params.get('port', 8080)}"
        self.session = aiohttp.ClientSession()
        
        # Verify payload is reachable
        try:
            async with self.session.get(f"{self.base_url}/quiver/health", timeout=5) as resp:
                return resp.status == 200
        except:
            return False
    
    async def get_status(self) -> Dict[str, Any]:
        async with self.session.get(f"{self.base_url}/quiver/status") as resp:
            return await resp.json()
    
    async def send_command(self, command: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        payload = {
            "command": command,
            "parameters": parameters
        }
        async with self.session.post(f"{self.base_url}/quiver/command", json=payload) as resp:
            return await resp.json()
    
    async def shutdown(self):
        await self.session.close()
```

**Driver Registration**:

Drivers are registered by placing them in `/opt/quiver/payload-drivers/` with a corresponding metadata file:

```json
// http_camera.json
{
  "driver_name": "http_camera",
  "driver_class": "HTTPCameraDriver",
  "supported_payload_types": ["camera"],
  "required_protocols": ["http"],
  "version": "1.0.0"
}
```

---

## Web Interface API

### REST API Endpoints

The companion computer's web server exposes a comprehensive REST API for vehicle and payload control.

#### Authentication

**Endpoint**: `POST /api/auth/login`

**Request**:
```json
{
  "username": "operator",
  "password": "secure_password"
}
```

**Response**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_at": "2026-01-09T12:34:56.789Z"
}
```

All subsequent requests must include the token in the Authorization header:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Vehicle Status

**Endpoint**: `GET /api/vehicle/status`

**Response**:
```json
{
  "armed": true,
  "mode": "AUTO",
  "position": {
    "latitude": 37.7749,
    "longitude": -122.4194,
    "altitude_msl": 123.45,
    "altitude_rel": 50.0
  },
  "attitude": {
    "roll": 2.5,
    "pitch": -1.2,
    "yaw": 45.0
  },
  "velocity": {
    "vx": 5.0,
    "vy": 2.0,
    "vz": -0.5
  },
  "battery": {
    "voltage": 22.2,
    "current": 15.5,
    "remaining_percent": 75
  },
  "gps": {
    "fix_type": "3D",
    "satellites": 12,
    "hdop": 0.9
  }
}
```

#### Payload Management

**Endpoint**: `GET /api/payloads`

**Response**:
```json
{
  "payloads": [
    {
      "id": "camera1",
      "type": "camera",
      "port": "C1",
      "status": "active",
      "manufacturer": "Example Corp",
      "model": "HD-1080",
      "version": "1.2.3"
    },
    {
      "id": "lidar1",
      "type": "lidar",
      "port": "C2",
      "status": "active",
      "manufacturer": "LiDAR Inc",
      "model": "RPLidar A3",
      "version": "2.1.0"
    }
  ]
}
```

**Endpoint**: `GET /api/payloads/{id}/status`

**Response**:
```json
{
  "payload_id": "camera1",
  "status": "active",
  "power": {
    "voltage": 12.1,
    "current": 0.5,
    "temperature": 35.2
  },
  "operational_state": "recording",
  "custom_fields": {
    "resolution": "1920x1080",
    "framerate": 30,
    "storage_remaining_mb": 15360
  }
}
```

**Endpoint**: `POST /api/payloads/{id}/command`

**Request**:
```json
{
  "command": "start_recording",
  "parameters": {
    "resolution": "1920x1080",
    "framerate": 30
  }
}
```

**Response**:
```json
{
  "success": true,
  "message": "Recording started",
  "execution_time_ms": 123
}
```

#### Mission Management

**Endpoint**: `GET /api/mission`

**Response**:
```json
{
  "waypoints": [
    {
      "seq": 0,
      "frame": "MAV_FRAME_GLOBAL_RELATIVE_ALT",
      "command": "MAV_CMD_NAV_WAYPOINT",
      "param1": 0,
      "param2": 0,
      "param3": 0,
      "param4": 0,
      "x": 37.7749,
      "y": -122.4194,
      "z": 50.0
    }
  ],
  "current_waypoint": 0,
  "total_waypoints": 5
}
```

**Endpoint**: `POST /api/mission`

**Request**:
```json
{
  "waypoints": [
    {
      "frame": "MAV_FRAME_GLOBAL_RELATIVE_ALT",
      "command": "MAV_CMD_NAV_WAYPOINT",
      "param1": 0,
      "param2": 0,
      "param3": 0,
      "param4": 0,
      "x": 37.7749,
      "y": -122.4194,
      "z": 50.0
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "waypoints_uploaded": 5
}
```

### WebSocket API

Real-time telemetry is delivered via Socket.IO WebSocket connections.

**Connection**:
```javascript
const socket = io('https://companion-ip:8080', {
  auth: {
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  }
});
```

**Events**:

| Event Name | Direction | Data Format | Description |
|------------|-----------|-------------|-------------|
| vehicle_state | Server → Client | JSON object | Vehicle position, attitude, velocity |
| payload_telemetry | Server → Client | JSON object | Payload-specific telemetry |
| mission_status | Server → Client | JSON object | Mission progress and status |
| alert | Server → Client | JSON object | System alerts and warnings |
| command | Client → Server | JSON object | Send command to vehicle or payload |

**Example Usage**:

```javascript
// Subscribe to vehicle state updates
socket.on('vehicle_state', (data) => {
  console.log('Position:', data.position);
  console.log('Attitude:', data.attitude);
  updateMap(data.position);
  updateHUD(data.attitude);
});

// Subscribe to payload telemetry
socket.on('payload_telemetry', (data) => {
  console.log('Payload:', data.payload_id);
  console.log('Data:', data.data);
  updatePayloadDisplay(data.payload_id, data.data);
});

// Send command to payload
socket.emit('command', {
  target: 'payload',
  payload_id: 'camera1',
  command: 'start_recording',
  parameters: {
    resolution: '1920x1080',
    framerate: 30
  }
});
```

---

## Data Serialization Formats

### JSON Schema for Telemetry

All JSON telemetry messages must conform to the following schema:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["timestamp", "payload_id", "data"],
  "properties": {
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp in UTC"
    },
    "payload_id": {
      "type": "string",
      "pattern": "^[a-z0-9_]+$",
      "description": "Unique payload identifier"
    },
    "data": {
      "type": "object",
      "description": "Payload-specific data fields"
    }
  }
}
```

### Protocol Buffers (Optional)

For high-performance applications, Protocol Buffers can be used instead of JSON.

**Example .proto Definition**:

```protobuf
syntax = "proto3";

package quiver.telemetry;

message PayloadTelemetry {
  string timestamp = 1;
  string payload_id = 2;
  
  oneof data {
    EnvironmentalData environmental = 10;
    GPSData gps = 11;
    LiDARData lidar = 12;
  }
}

message EnvironmentalData {
  float temperature_c = 1;
  float humidity_percent = 2;
  float pressure_hpa = 3;
}

message GPSData {
  double latitude = 1;
  double longitude = 2;
  float altitude_m = 3;
  string fix_type = 4;
  uint32 satellites = 5;
}

message LiDARData {
  uint32 point_count = 1;
  float scan_rate_hz = 2;
  repeated Point3D points = 3;
}

message Point3D {
  float x = 1;
  float y = 2;
  float z = 3;
  uint32 intensity = 4;
}
```

---

## Error Handling

### Error Response Format

All API errors return a standardized JSON response:

```json
{
  "success": false,
  "error": {
    "code": "PAYLOAD_NOT_FOUND",
    "message": "Payload 'camera1' not found",
    "details": {
      "requested_id": "camera1",
      "available_payloads": ["lidar1", "sensor1"]
    }
  }
}
```

### Standard Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| UNAUTHORIZED | 401 | Invalid or expired authentication token |
| FORBIDDEN | 403 | Insufficient permissions for requested operation |
| PAYLOAD_NOT_FOUND | 404 | Requested payload does not exist |
| PAYLOAD_OFFLINE | 503 | Payload is not responding |
| INVALID_COMMAND | 400 | Command format or parameters are invalid |
| COMMAND_FAILED | 500 | Command execution failed |
| TIMEOUT | 504 | Operation timed out |
| RATE_LIMIT_EXCEEDED | 429 | Too many requests in a short period |

---

## Rate Limiting

To prevent bandwidth exhaustion and ensure fair resource allocation, the API implements rate limiting.

**Limits**:
- Authentication: 10 requests per minute per IP
- Telemetry queries: 100 requests per minute per token
- Commands: 20 requests per minute per token
- Mission uploads: 5 requests per minute per token

**Rate Limit Headers**:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1704715200
```

When the rate limit is exceeded, the API returns HTTP 429 with a Retry-After header indicating when the client can retry.

---

## Versioning

The API uses semantic versioning (MAJOR.MINOR.PATCH) and includes the version in the URL path:

```
https://companion-ip:8080/api/v1/vehicle/status
```

**Version Compatibility**:
- MAJOR version changes indicate breaking changes (incompatible API modifications)
- MINOR version changes add functionality in a backward-compatible manner
- PATCH version changes fix bugs without changing the API surface

Clients should specify the API version they are compatible with. The server supports the current major version and one previous major version for a transition period.

---

## Code Examples

### Complete Payload Implementation (Python)

```python
#!/usr/bin/env python3
# example_sensor_payload.py
# Complete example of a simple sensor payload

import asyncio
import aiohttp
from aiohttp import web
import json
from datetime import datetime
import random

class TemperatureSensorPayload:
    def __init__(self, ip='0.0.0.0', port=8080):
        self.ip = ip
        self.port = port
        self.app = web.Application()
        self.setup_routes()
        self.recording = False
        self.temperature = 25.0
        
    def setup_routes(self):
        self.app.router.add_get('/quiver/info', self.handle_info)
        self.app.router.add_get('/quiver/health', self.handle_health)
        self.app.router.add_get('/quiver/status', self.handle_status)
        self.app.router.add_post('/quiver/command', self.handle_command)
        self.app.router.add_get('/quiver/parameters', self.handle_get_parameters)
        self.app.router.add_put('/quiver/parameters/{name}', self.handle_set_parameter)
    
    async def handle_info(self, request):
        return web.json_response({
            "payload_type": "sensor",
            "manufacturer": "Example Corp",
            "model": "TEMP-100",
            "version": "1.0.0",
            "serial_number": "TEMP-12345",
            "capabilities": ["temperature_sensing"],
            "protocols": {
                "control": "http",
                "telemetry": "mqtt"
            },
            "endpoints": {
                "control_api": f"http://{request.host}/quiver",
                "telemetry_topic": "quiver/payloads/temp_sensor1"
            }
        })
    
    async def handle_health(self, request):
        return web.json_response({
            "status": "ok",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "uptime": 3600
        })
    
    async def handle_status(self, request):
        return web.json_response({
            "power": {
                "voltage": 12.1,
                "current": 0.1,
                "temperature": 35.2
            },
            "operational_state": "active",
            "error_code": 0,
            "error_message": "",
            "custom_fields": {
                "recording": self.recording,
                "current_temperature": self.temperature
            }
        })
    
    async def handle_command(self, request):
        data = await request.json()
        command = data.get('command')
        parameters = data.get('parameters', {})
        
        if command == 'start_recording':
            self.recording = True
            return web.json_response({
                "success": True,
                "message": "Recording started",
                "execution_time_ms": 10
            })
        elif command == 'stop_recording':
            self.recording = False
            return web.json_response({
                "success": True,
                "message": "Recording stopped",
                "execution_time_ms": 10
            })
        else:
            return web.json_response({
                "success": False,
                "error": {
                    "code": "INVALID_COMMAND",
                    "message": f"Unknown command: {command}"
                }
            }, status=400)
    
    async def handle_get_parameters(self, request):
        return web.json_response({
            "parameters": [
                {
                    "name": "sample_rate",
                    "value": 1.0,
                    "type": "float",
                    "min": 0.1,
                    "max": 10.0,
                    "unit": "Hz",
                    "description": "Temperature sampling rate"
                }
            ]
        })
    
    async def handle_set_parameter(self, request):
        param_name = request.match_info['name']
        data = await request.json()
        new_value = data.get('value')
        
        # In a real implementation, validate and apply the parameter
        return web.json_response({
            "success": True,
            "parameter": param_name,
            "old_value": 1.0,
            "new_value": new_value
        })
    
    async def telemetry_loop(self):
        """Simulate sensor readings"""
        while True:
            # Simulate temperature reading
            self.temperature = 25.0 + random.uniform(-2.0, 2.0)
            
            if self.recording:
                # In a real implementation, publish to MQTT
                print(f"Telemetry: {self.temperature:.2f}°C")
            
            await asyncio.sleep(1.0)
    
    async def start(self):
        # Start telemetry loop
        asyncio.create_task(self.telemetry_loop())
        
        # Start web server
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, self.ip, self.port)
        await site.start()
        print(f"Payload server running on {self.ip}:{self.port}")
        
        # Keep running
        await asyncio.Event().wait()

if __name__ == '__main__':
    payload = TemperatureSensorPayload()
    asyncio.run(payload.start())
```

### Ground Control Client (JavaScript)

```javascript
// quiver_client.js
// Example ground control client using the Web API

class QuiverClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.token = null;
    this.socket = null;
  }
  
  async login(username, password) {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username, password})
    });
    
    const data = await response.json();
    if (data.success) {
      this.token = data.token;
      this.connectWebSocket();
      return true;
    }
    return false;
  }
  
  connectWebSocket() {
    this.socket = io(this.baseUrl, {
      auth: {token: this.token}
    });
    
    this.socket.on('vehicle_state', (data) => {
      console.log('Vehicle state:', data);
      this.onVehicleState(data);
    });
    
    this.socket.on('payload_telemetry', (data) => {
      console.log('Payload telemetry:', data);
      this.onPayloadTelemetry(data);
    });
  }
  
  async getVehicleStatus() {
    const response = await fetch(`${this.baseUrl}/api/vehicle/status`, {
      headers: {'Authorization': `Bearer ${this.token}`}
    });
    return await response.json();
  }
  
  async getPayloads() {
    const response = await fetch(`${this.baseUrl}/api/payloads`, {
      headers: {'Authorization': `Bearer ${this.token}`}
    });
    return await response.json();
  }
  
  async sendPayloadCommand(payloadId, command, parameters = {}) {
    const response = await fetch(`${this.baseUrl}/api/payloads/${payloadId}/command`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({command, parameters})
    });
    return await response.json();
  }
  
  // Override these methods to handle events
  onVehicleState(data) {}
  onPayloadTelemetry(data) {}
}

// Usage example
const client = new QuiverClient('https://192.168.144.15:8080');

client.onVehicleState = (data) => {
  document.getElementById('altitude').textContent = data.position.altitude_rel.toFixed(1);
  document.getElementById('speed').textContent = Math.sqrt(
    data.velocity.vx**2 + data.velocity.vy**2
  ).toFixed(1);
};

client.onPayloadTelemetry = (data) => {
  if (data.payload_id === 'camera1') {
    document.getElementById('camera_status').textContent = 
      data.data.recording ? 'Recording' : 'Idle';
  }
};

// Login and start
await client.login('operator', 'password');

// Get initial status
const status = await client.getVehicleStatus();
console.log('Vehicle status:', status);

// Send command to payload
await client.sendPayloadCommand('camera1', 'start_recording', {
  resolution: '1920x1080',
  framerate: 30
});
```

---

## Conclusion

This API reference provides the complete technical specification for integrating with the Quiver SDK. Developers should use this document as the authoritative source for message formats, function signatures, and protocol details when implementing payload drivers, companion computer applications, or ground control extensions.

---

## Next Document

- **Level 5: Developer Guide** - Step-by-step tutorials for building and integrating payloads

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Manus AI | Initial release |

**Related Documents**
- Level 1: Executive Overview
- Level 2: System Architecture
- Level 3: Component Specifications
- QuiverPayloadArchitecture.doc (Reference Engineering Pod)
