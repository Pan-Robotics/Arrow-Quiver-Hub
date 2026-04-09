# Quiver SDK Architecture
## Level 3: Component Specifications

**Document Version:** 1.0  
**Date:** January 2026  
**Author:** Pan Robotics  
**Classification:** Technical

---

## Introduction

This document provides detailed specifications for the major software and hardware components that comprise the Quiver SDK. It targets system engineers, firmware developers, and integration specialists who need to understand internal component behavior, interfaces, and implementation constraints. Each component is described in terms of its purpose, internal architecture, external interfaces, configuration options, and operational characteristics.

---

## Companion Computer Components

### Payload Manager Service

**Purpose**: The Payload Manager is the central orchestration service on the companion computer, responsible for discovering connected payloads, loading appropriate drivers, managing payload lifecycle, and coordinating inter-payload communication.

#### Internal Architecture

The Payload Manager operates as a system daemon (systemd service) that starts automatically during boot. It consists of several subsystems that work in concert to provide seamless payload integration.

**Discovery Subsystem**: Monitors multiple sources to detect newly connected payloads. The DHCP monitor watches the DHCP server logs (dnsmasq or systemd-networkd) for new lease assignments on payload subnets (192.168.144.11-13). When a new IP address is assigned, the discovery subsystem attempts to identify the payload by querying a well-known HTTP endpoint (`http://<payload-ip>/quiver/info`) that returns a JSON descriptor containing payload type, version, and capabilities. For DroneCAN payloads, the discovery subsystem listens for uavcan.protocol.NodeStatus messages on the CAN bus, extracting node IDs and querying node information via the uavcan.protocol.GetNodeInfo service. MAVLink payloads are detected via HEARTBEAT messages with unique component IDs.

**Driver Loader**: Once a payload is identified, the driver loader searches a plugin directory (`/opt/quiver/payload-drivers/`) for a matching driver module. Drivers are Python scripts or compiled binaries that implement a standard interface defined by the Payload Manager API. The loader instantiates the driver in a separate process (using Python's multiprocessing or systemd's dynamic service activation), passing it the payload's connection parameters (IP address, CAN node ID, or MAVLink component ID). If no specific driver is found, the loader attempts to use a generic driver based on the payload's declared protocol (HTTP REST, MQTT, raw TCP/UDP).

**Lifecycle Manager**: Tracks the state of each payload (DISCOVERED, INITIALIZING, ACTIVE, ERROR, DISCONNECTED) and manages state transitions. When a payload becomes ACTIVE, the lifecycle manager registers it with the telemetry router (so its data can be forwarded to the ground station) and the command dispatcher (so it can receive commands from operators). If a payload enters the ERROR state (due to repeated communication failures or driver crashes), the lifecycle manager attempts to restart the driver up to three times before marking the payload as DISCONNECTED and alerting the operator.

**Health Monitor**: Periodically polls active payloads to verify they are responsive. For HTTP-based payloads, this involves sending a GET request to a health check endpoint (`/quiver/health`) and verifying a 200 OK response. For DroneCAN payloads, the monitor checks that NodeStatus messages are received within expected intervals. For MAVLink payloads, it verifies that HEARTBEAT messages continue to arrive. If a payload fails to respond within a configurable timeout (default: 5 seconds), the health monitor increments a failure counter and triggers a driver restart if the threshold is exceeded.

#### External Interfaces

**Configuration API**: The Payload Manager exposes a D-Bus interface that allows other system components (web server, mission scripts) to query payload status, manually trigger discovery, or force a payload restart. Example methods include `ListPayloads()` (returns array of payload descriptors), `GetPayloadStatus(payload_id)` (returns current state and health metrics), and `RestartPayload(payload_id)` (forces driver restart).

**Driver API**: Payload drivers implement a standard interface consisting of initialization, command handling, and shutdown methods. Drivers communicate with the Payload Manager via Unix domain sockets or stdin/stdout pipes, using a JSON-RPC protocol. Example messages include `{"method": "send_command", "params": {"command": "start_recording"}}` (sent from Payload Manager to driver) and `{"method": "telemetry_update", "params": {"temperature": 25.3}}` (sent from driver to Payload Manager).

**Telemetry Router Integration**: The Payload Manager publishes payload telemetry to a local MQTT broker (Mosquitto) running on the companion computer. Each payload has a dedicated topic hierarchy (`quiver/payloads/<payload_id>/<data_type>`), allowing other components to subscribe to relevant data streams. The telemetry router subscribes to all payload topics and forwards selected messages to the ground station via MAVLink or the web interface.

#### Configuration

The Payload Manager's behavior is controlled by a YAML configuration file (`/etc/quiver/payload-manager.conf`):

```yaml
discovery:
  dhcp_monitor: true
  dronecan_monitor: true
  mavlink_monitor: true
  scan_interval: 5  # seconds

drivers:
  plugin_directory: /opt/quiver/payload-drivers
  default_driver: generic_http
  restart_attempts: 3
  restart_delay: 10  # seconds

health:
  check_interval: 30  # seconds
  timeout: 5  # seconds
  failure_threshold: 3

logging:
  level: INFO
  file: /var/log/quiver/payload-manager.log
  max_size: 10MB
  rotation: 7  # days
```

#### Performance Characteristics

The Payload Manager is designed to be lightweight, consuming less than 50 MB of RAM and minimal CPU (<1% on Raspberry Pi 5) under normal operation. Payload discovery typically completes within 1-2 seconds of connection. Driver instantiation adds 0.5-1 second per payload. The health monitoring loop runs every 30 seconds, adding negligible overhead.

---

### MAVLink Routing Daemon

**Purpose**: The MAVLink Routing Daemon (mavlink-routerd) is a message broker that manages multiple MAVLink connections, forwarding messages between the flight controller, payloads, and ground station based on routing rules.

#### Internal Architecture

The daemon maintains a connection table that tracks all active MAVLink endpoints (serial ports, UDP sockets, TCP connections). Each endpoint is associated with a set of system IDs and component IDs that it is authorized to send and receive. The router uses an event-driven architecture (based on epoll or kqueue) to efficiently handle multiple connections without blocking.

**Message Parsing**: Incoming MAVLink messages are parsed to extract the system ID, component ID, and message ID. The router validates the message CRC and signature (if message signing is enabled) before processing.

**Routing Logic**: The router consults a routing table to determine which endpoints should receive each message. The default routing rules are:

- **Broadcast messages** (component ID = 0) are forwarded to all endpoints except the sender.
- **Targeted messages** (specific component ID) are forwarded only to the endpoint that registered that component ID.
- **Telemetry messages** (ATTITUDE, GPS_RAW_INT, etc.) are forwarded to all ground station endpoints.
- **Command messages** (COMMAND_LONG, MISSION_ITEM_INT) are forwarded to the flight controller and logged for audit purposes.

**Rate Limiting**: To prevent bandwidth exhaustion on low-speed links (e.g., 915 MHz telemetry radio), the router implements rate limiting for high-frequency messages. For example, ATTITUDE messages (typically sent at 10 Hz by the flight controller) may be downsampled to 2 Hz before forwarding to the ground station, while the full 10 Hz stream is available to payloads on the local Ethernet network.

**Message Logging**: All routed messages are optionally logged to a binary file (MAVLink .tlog format) for post-flight analysis. Logging can be enabled/disabled via a configuration parameter and filtered by message type to reduce storage requirements.

#### External Interfaces

**Flight Controller Connection**: The router connects to the flight controller via a dedicated Ethernet port (UDP on port 14540) or serial port (typically /dev/ttyAMA0 at 921600 baud). This connection is configured as a MAVLink 2.0 endpoint with system ID 1, component ID 1 (autopilot).

**Payload Connections**: Payloads connect to the router via UDP (port 14550) or TCP (port 5760). Each payload must send a HEARTBEAT message with a unique component ID to register itself with the router. The router assigns a slot in the connection table and begins forwarding relevant messages.

**Ground Station Connection**: The router listens on UDP port 14550 (for QGroundControl and Mission Planner) and provides a WebSocket interface on port 5761 (for web-based ground control). Ground stations are automatically detected when they send their first message to the router.

#### Configuration

The routing daemon is configured via a JSON file (`/etc/quiver/mavlink-routerd.conf`):

```json
{
  "endpoints": [
    {
      "type": "serial",
      "device": "/dev/ttyAMA0",
      "baudrate": 921600,
      "description": "Flight Controller"
    },
    {
      "type": "udp_server",
      "port": 14550,
      "description": "Payload and Ground Station"
    },
    {
      "type": "websocket_server",
      "port": 5761,
      "description": "Web Ground Control"
    }
  ],
  "routing": {
    "rate_limit": {
      "ATTITUDE": 2,
      "VFR_HUD": 2,
      "GLOBAL_POSITION_INT": 2
    },
    "filters": {
      "ground_station": ["HEARTBEAT", "ATTITUDE", "GPS_RAW_INT", "BATTERY_STATUS"],
      "payloads": ["all"]
    }
  },
  "logging": {
    "enabled": true,
    "directory": "/var/log/quiver/mavlink",
    "max_file_size": "100MB",
    "rotation": "daily"
  }
}
```

#### Performance Characteristics

The routing daemon is highly optimized for throughput and latency. On a Raspberry Pi 5, it can handle over 10,000 messages per second with sub-millisecond forwarding latency. Memory usage scales linearly with the number of active connections, typically 5-10 MB per endpoint.

---

### Web Interface Server

**Purpose**: The Web Interface Server provides a browser-based ground control interface that allows operators to monitor vehicle status, control payloads, view live video streams, and manage missions.

#### Internal Architecture

The server is built on Node.js using the Express.js framework for HTTP routing and Socket.IO for WebSocket communication. It follows a Model-View-Controller (MVC) architecture, with clear separation between data models (vehicle state, payload status), business logic (command processing, authentication), and presentation (HTML/CSS/JavaScript).

**Authentication Module**: Implements JWT-based authentication. Operators log in with a username and password (validated against a local user database or LDAP server), receiving a signed JWT token that must be included in all subsequent API requests. Tokens expire after 24 hours and can be refreshed or revoked.

**Telemetry Aggregator**: Subscribes to the local MQTT broker to receive real-time telemetry from the Payload Manager and MAVLink Routing Daemon. Telemetry is aggregated into a unified data model (vehicle state, payload states, mission status) and pushed to connected web clients via WebSocket messages. The aggregator implements delta encoding to minimize bandwidth: only changed values are transmitted, reducing typical telemetry message size from several kilobytes to a few hundred bytes.

**Command Dispatcher**: Receives commands from the web interface (via HTTP POST requests) and translates them into appropriate protocol messages. For example, a "Start Recording" button click generates an HTTP POST to `/api/payloads/camera1/command` with body `{"action": "start_recording"}`. The command dispatcher looks up the camera payload's driver, determines the appropriate protocol (MAVLink COMMAND_LONG, HTTP POST to payload, etc.), and sends the command. It waits for an acknowledgment (with a 5-second timeout) and returns success or failure to the web client.

**Video Streaming Proxy**: Receives video streams from payloads (typically H.264 over UDP or RTSP) and re-encodes them for web delivery using WebRTC or HLS (HTTP Live Streaming). WebRTC provides the lowest latency (50-100 ms) but requires modern browsers and STUN/TURN servers for NAT traversal. HLS has higher latency (2-5 seconds) but works on all browsers and is easier to deploy. The proxy can transcode multiple streams simultaneously, adjusting bitrate and resolution based on available bandwidth.

**Mission Planner**: Provides a map-based interface for creating and editing waypoint missions. The interface uses Leaflet.js for map rendering, allowing operators to click on the map to add waypoints, draw survey areas, or define geofence boundaries. The mission planner generates MAVLink MISSION_ITEM_INT messages and uploads them to the flight controller via the MAVLink Routing Daemon.

#### External Interfaces

**RESTful API**: The server exposes a comprehensive REST API for all control and configuration functions:

- `GET /api/vehicle/status` - Returns current vehicle state (position, attitude, battery, etc.)
- `GET /api/payloads` - Returns list of connected payloads with status
- `POST /api/payloads/{id}/command` - Sends a command to a specific payload
- `GET /api/mission` - Returns current mission (waypoints, parameters)
- `POST /api/mission` - Uploads a new mission to the flight controller
- `GET /api/logs` - Returns list of available flight logs
- `GET /api/logs/{id}/download` - Downloads a specific log file

**WebSocket Interface**: Real-time telemetry is delivered via Socket.IO WebSocket connections. Clients connect to `ws://companion-ip:8080/socket.io` and subscribe to specific data streams:

```javascript
socket.on('vehicle_state', (data) => {
  // data contains position, attitude, velocity, etc.
  updateMap(data.position);
  updateHUD(data.attitude);
});

socket.on('payload_telemetry', (data) => {
  // data contains payload-specific telemetry
  updatePayloadDisplay(data.payload_id, data.values);
});
```

**Video Streaming Endpoints**:
- `rtsp://companion-ip:8554/camera1` - RTSP stream for external players (VLC, ffplay)
- `http://companion-ip:8080/hls/camera1/index.m3u8` - HLS stream for web browsers
- WebRTC signaling via Socket.IO for low-latency streaming

#### Configuration

The web server is configured via environment variables and a JSON configuration file (`/etc/quiver/web-server.conf`):

```json
{
  "server": {
    "port": 8080,
    "ssl": {
      "enabled": true,
      "cert": "/etc/quiver/ssl/server.crt",
      "key": "/etc/quiver/ssl/server.key"
    }
  },
  "authentication": {
    "jwt_secret": "CHANGE_THIS_SECRET",
    "token_expiry": "24h",
    "user_database": "/etc/quiver/users.db"
  },
  "video": {
    "encoder": "h264_v4l2m2m",  # Hardware encoding on Raspberry Pi
    "bitrate": "2000k",
    "resolution": "1280x720",
    "framerate": 30
  },
  "telemetry": {
    "mqtt_broker": "localhost:1883",
    "update_rate": 10  # Hz
  }
}
```

#### Performance Characteristics

The web server can support up to 10 concurrent clients with full telemetry updates and video streaming on a Raspberry Pi 5. Each client consumes approximately 2-5 Mbps of bandwidth (depending on video quality) and 50-100 MB of RAM on the server. CPU usage is dominated by video encoding, typically 30-50% per stream when using hardware acceleration.

---

### DroneCAN Interface Service

**Purpose**: The DroneCAN Interface Service provides a bridge between the CAN bus (where DroneCAN devices communicate) and the companion computer's software stack, enabling payloads to use DroneCAN for real-time sensor integration.

#### Internal Architecture

The service consists of a kernel-level CAN driver (SocketCAN) and a user-space daemon (libuavcan-based) that implements the DroneCAN protocol stack.

**SocketCAN Driver**: The Linux kernel's SocketCAN subsystem provides a network-like interface to CAN hardware. The MCP2515 SPI-to-CAN controller is configured via device tree overlays, creating a network interface (`can0`) that applications can access using standard socket APIs. The driver handles bit timing, arbitration, and error detection, presenting a clean interface to user-space software.

**DroneCAN Daemon**: The user-space daemon (quiver-dronecan-bridge) uses the libuavcan library to implement DroneCAN node functionality. It acts as a DroneCAN node with a configurable node ID (default: 100) and responds to standard services (GetNodeInfo, GetDataTypeInfo, param.GetSet). The daemon subscribes to relevant DroneCAN message types (sensor measurements, actuator commands) and publishes them to the local MQTT broker for consumption by other companion computer services. Conversely, it subscribes to MQTT topics for outgoing DroneCAN messages, translating them into DroneCAN frames and transmitting them on the CAN bus.

**Parameter Server**: The daemon implements a parameter server that exposes DroneCAN node parameters via both the DroneCAN param service and an HTTP REST API. This allows operators to configure DroneCAN devices from the web interface without requiring specialized tools.

#### External Interfaces

**CAN Bus**: The service communicates with DroneCAN devices via the SocketCAN interface (`can0`), operating at 1 Mbps with standard 11-bit CAN identifiers.

**MQTT Bridge**: DroneCAN messages are published to MQTT topics following a standardized naming convention:
- `quiver/dronecan/in/<message_type>/<node_id>` - Incoming messages from DroneCAN devices
- `quiver/dronecan/out/<message_type>/<node_id>` - Outgoing messages to DroneCAN devices

For example, a rangefinder measurement from node 42 would be published to `quiver/dronecan/in/uavcan.equipment.range_sensor.Measurement/42` with a JSON payload containing the measurement data.

**HTTP API**: The service exposes a REST API for parameter management:
- `GET /api/dronecan/nodes` - Returns list of discovered DroneCAN nodes
- `GET /api/dronecan/nodes/{id}/params` - Returns all parameters for a specific node
- `PUT /api/dronecan/nodes/{id}/params/{name}` - Sets a parameter value

#### Configuration

The DroneCAN service is configured via `/etc/quiver/dronecan.conf`:

```yaml
can_interface: can0
node_id: 100
node_name: "Quiver Companion Computer"

subscriptions:
  - uavcan.equipment.range_sensor.Measurement
  - uavcan.equipment.gnss.Fix2
  - uavcan.equipment.ahrs.MagneticFieldStrength2
  - uavcan.equipment.air_data.StaticPressure

publications:
  - uavcan.protocol.NodeStatus  # Heartbeat

mqtt:
  broker: localhost:1883
  topic_prefix: quiver/dronecan

logging:
  level: INFO
  file: /var/log/quiver/dronecan.log
```

#### Performance Characteristics

The DroneCAN service adds minimal overhead, consuming less than 20 MB of RAM and <2% CPU on a Raspberry Pi 5. Message latency from CAN bus reception to MQTT publication is typically 1-2 milliseconds. The service can handle up to 1000 DroneCAN messages per second (the theoretical maximum for a 1 Mbps CAN bus with typical message sizes).

---

## Flight Controller Integration

### Custom MAVLink Dialect

**Purpose**: The Quiver SDK defines a custom MAVLink dialect that extends the standard MAVLink message set with payload-specific messages and commands.

#### Message Definitions

The dialect is defined in XML format (`quiver.xml`) and compiled into C/C++ headers using the MAVLink code generator. Example message definitions:

```xml
<message id="50000" name="PAYLOAD_STATUS">
  <description>Status information from a Quiver payload</description>
  <field type="uint8_t" name="payload_id">Payload identifier (1-3 for C1-C3)</field>
  <field type="uint8_t" name="status">Status flags (bit 0: active, bit 1: error, bit 2: recording)</field>
  <field type="float" name="temperature">Payload temperature (Celsius)</field>
  <field type="float" name="voltage">Payload supply voltage (Volts)</field>
  <field type="uint32_t" name="uptime">Payload uptime (seconds)</field>
</message>

<message id="50001" name="LIDAR_SCAN_DATA">
  <description>LiDAR point cloud data (compressed)</description>
  <field type="uint8_t" name="payload_id">Payload identifier</field>
  <field type="uint16_t" name="point_count">Number of points in this packet</field>
  <field type="uint8_t[200]" name="data">Compressed point cloud data</field>
</message>
```

#### Command Definitions

Custom commands are defined using the MAVLink COMMAND_LONG message with command IDs in the range 50000-59999 (reserved for custom use):

```xml
<enum name="MAV_CMD">
  <entry value="50000" name="MAV_CMD_PAYLOAD_ACTIVATE">
    <description>Activate a payload</description>
    <param index="1">Payload ID (1-3)</param>
    <param index="2">Activation mode (0=off, 1=on, 2=toggle)</param>
  </entry>
  
  <entry value="50001" name="MAV_CMD_PAYLOAD_CONFIGURE">
    <description>Configure payload parameters</description>
    <param index="1">Payload ID</param>
    <param index="2">Parameter ID</param>
    <param index="3">Parameter value</param>
  </entry>
</enum>
```

#### Integration with Flight Controller

The custom dialect is integrated into the flight controller firmware by including the generated header files and registering message handlers. For ArduPilot, this involves creating a new library in `libraries/AP_Quiver/` that implements the Quiver-specific logic. For PX4, a new module is added to `src/modules/quiver/`.

The flight controller firmware is modified to:
1. Forward Quiver-specific messages between the companion computer and ground station
2. Respond to Quiver commands (e.g., MAV_CMD_PAYLOAD_ACTIVATE) by sending corresponding messages to the companion computer
3. Log Quiver telemetry to onboard flash storage for post-flight analysis

---

## Payload Hardware Reference Design

### Ethernet-Based Payload Module

**Purpose**: Provides a reference hardware design for payloads that communicate via Ethernet, suitable for high-bandwidth sensors (cameras, LiDAR) or computationally intensive processing (machine vision, AI inference).

#### Hardware Architecture

The reference design uses a Raspberry Pi Zero 2 W as the payload controller, providing a balance of cost, power consumption, and performance. Alternative platforms (ESP32 with Ethernet PHY, STM32 with Ethernet MAC) are also supported.

**Connector Interface**: The payload connects to the Quiver 10-pin connector via a custom PCB that breaks out the Ethernet differential pairs (TX+/TX-, RX+/RX-) to an RJ45 jack or direct PHY connection. The PCB includes:
- Ethernet transformer and common-mode chokes for signal integrity
- 12V to 5V buck converter (2A capacity) for payload power
- Reverse polarity protection diode
- TVS diodes on all signal lines for ESD protection
- Status LEDs (power, Ethernet link, activity)

**Sensor Interface**: The payload controller provides multiple interfaces for connecting sensors:
- CSI camera connector (for Raspberry Pi Camera Module)
- USB 2.0 host port (for USB cameras, LiDAR, GPS)
- I2C and SPI buses (for environmental sensors, IMUs)
- GPIO pins (for digital triggers, status indicators)

#### Software Stack

The reference software runs on Raspberry Pi OS Lite and consists of:

**Payload Service**: A Python application that implements the Quiver payload protocol. It listens on HTTP port 8080 for control commands, publishes telemetry via MQTT or HTTP POST, and streams sensor data via UDP or RTSP. The service uses systemd for automatic startup and restart on failure.

**Sensor Drivers**: Modular Python scripts that interface with specific sensors. For example, a camera driver uses the picamera2 library to capture frames, encode them as H.264, and stream via RTSP. A LiDAR driver reads point cloud data from a USB-connected scanner and publishes it as JSON over UDP.

**Configuration Interface**: A web-based configuration UI (Flask application) that allows developers to set payload parameters (sensor settings, network configuration, calibration values) without SSH access.

#### Example Implementation: Camera Payload

A complete camera payload implementation includes:

**Hardware**:
- Raspberry Pi Zero 2 W
- Raspberry Pi Camera Module 3 (12MP, autofocus)
- Custom interface PCB
- 3D-printed enclosure with vibration damping

**Software**:
```python
# /opt/quiver/camera_payload.py
import picamera2
import socket
import json

class CameraPayload:
    def __init__(self):
        self.camera = picamera2.Picamera2()
        self.camera.configure(self.camera.create_video_configuration())
        self.udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.recording = False
    
    def start_recording(self):
        self.camera.start_recording(self.udp_socket, format='h264')
        self.recording = True
    
    def stop_recording(self):
        self.camera.stop_recording()
        self.recording = False
    
    def get_status(self):
        return {
            'recording': self.recording,
            'resolution': self.camera.camera_config['main']['size'],
            'framerate': self.camera.camera_config['main']['framerate']
        }
```

---

## Ground Control Plugins

### Mission Planner Plugin Architecture

**Purpose**: Extend Mission Planner with payload-specific UI panels and control logic.

#### Plugin Structure

Mission Planner plugins are .NET DLLs that implement the `MissionPlanner.Plugin.Plugin` interface. The plugin is loaded at runtime and can access Mission Planner's API to send MAVLink messages, display UI elements, and respond to events.

**Minimum Plugin Implementation**:

```csharp
using MissionPlanner.Plugin;
using System.Windows.Forms;

namespace QuiverCameraPlugin
{
    public class CameraPlugin : Plugin
    {
        public override string Name => "Quiver Camera Control";
        public override string Version => "1.0";
        public override string Author => "Quiver SDK";
        
        private ToolStripMenuItem menuItem;
        private CameraControlForm controlForm;
        
        public override bool Init()
        {
            // Create menu item
            menuItem = new ToolStripMenuItem("Camera Control");
            menuItem.Click += (sender, e) => ShowControlForm();
            Host.FDMenuMap.Items.Add(menuItem);
            
            return true;
        }
        
        public override bool Loaded()
        {
            return true;
        }
        
        public override bool Exit()
        {
            controlForm?.Close();
            return true;
        }
        
        private void ShowControlForm()
        {
            if (controlForm == null || controlForm.IsDisposed)
            {
                controlForm = new CameraControlForm(Host.comPort);
                controlForm.Show();
            }
            else
            {
                controlForm.Focus();
            }
        }
    }
}
```

**Control Form Implementation**:

```csharp
public class CameraControlForm : Form
{
    private MAVLinkInterface mavlink;
    private Button btnStartRecording;
    private Button btnStopRecording;
    private PictureBox videoPreview;
    
    public CameraControlForm(MAVLinkInterface mav)
    {
        this.mavlink = mav;
        InitializeUI();
    }
    
    private void InitializeUI()
    {
        this.Text = "Camera Control";
        this.Size = new Size(400, 300);
        
        btnStartRecording = new Button();
        btnStartRecording.Text = "Start Recording";
        btnStartRecording.Click += (s, e) => SendCommand(50000, 1, 1);  // MAV_CMD_PAYLOAD_ACTIVATE
        
        btnStopRecording = new Button();
        btnStopRecording.Text = "Stop Recording";
        btnStopRecording.Click += (s, e) => SendCommand(50000, 1, 0);
        
        // Layout controls...
    }
    
    private void SendCommand(ushort command, float param1, float param2)
    {
        mavlink.doCommand(1, 1, (MAVLink.MAV_CMD)command, param1, param2, 0, 0, 0, 0, 0);
    }
}
```

---

## Configuration Management

### Parameter System

**Purpose**: Provide a unified interface for configuring flight controller, companion computer, and payload parameters.

#### Parameter Storage

Parameters are stored in multiple locations depending on their scope:

**Flight Controller Parameters**: Stored in the flight controller's EEPROM, managed via MAVLink's PARAM protocol. Examples: `QUIVER_PAYLOAD1_EN` (enable payload 1), `QUIVER_TELEM_RATE` (telemetry rate for Quiver messages).

**Companion Computer Parameters**: Stored in `/etc/quiver/params.yaml`, managed via the web interface or command-line tool. Examples: `payload_discovery_interval`, `video_bitrate`, `telemetry_logging_enabled`.

**Payload Parameters**: Stored locally on each payload (in EEPROM, flash, or configuration file), accessible via payload-specific APIs (HTTP, DroneCAN param service, MAVLink PARAM).

#### Parameter Synchronization

The companion computer maintains a unified parameter database that aggregates parameters from all sources. When a parameter is changed via the web interface, the companion computer determines the appropriate backend (flight controller, companion computer, payload) and sends the update via the corresponding protocol. Parameter changes are logged for audit purposes and can be rolled back if needed.

---

## Logging and Diagnostics

### Flight Data Logging

**Purpose**: Record all telemetry, commands, and events for post-flight analysis and debugging.

#### Log Formats

The system generates multiple log files in standard formats:

**MAVLink Telemetry Logs (.tlog)**: Binary files containing all MAVLink messages exchanged between the flight controller, companion computer, and ground station. Compatible with Mission Planner, QGroundControl, and MAVExplorer for analysis.

**Payload Data Logs (.jsonl)**: JSON Lines format containing timestamped payload telemetry. Each line is a self-contained JSON object with a timestamp and payload-specific data fields. Example:

```json
{"timestamp": "2026-01-08T12:34:56.789Z", "payload_id": "camera1", "temperature": 25.3, "voltage": 12.1, "recording": true}
{"timestamp": "2026-01-08T12:34:57.789Z", "payload_id": "lidar1", "point_count": 1024, "scan_rate": 10}
```

**System Logs (syslog)**: Standard Linux system logs containing service startup/shutdown messages, errors, and warnings. Managed by systemd-journald with automatic rotation.

#### Log Management

The companion computer's log management service monitors disk usage and automatically rotates or compresses old logs to prevent storage exhaustion. Logs can be downloaded via the web interface or synced to cloud storage (S3, Google Drive) when internet connectivity is available.

---

## Over-the-Air Updates

### Firmware Update System

**Purpose**: Enable remote updates of flight controller firmware, companion computer software, and payload firmware without physical access to the vehicle.

#### Update Process

**Flight Controller Updates**: The companion computer downloads the new firmware binary (ArduPilot .apj file or PX4 .px4 file) from a trusted update server. It verifies the digital signature to ensure authenticity, then uploads the firmware to the flight controller using MAVLink's FTP protocol. The flight controller reboots into bootloader mode, flashes the new firmware, and reboots into normal operation. The entire process takes 2-3 minutes and can be performed remotely over cellular or satellite links.

**Companion Computer Updates**: Software updates are delivered as Debian packages (.deb) or Docker images. The update service downloads the package, verifies its signature, and installs it using apt or docker pull. Services are restarted automatically, and the system performs a health check to verify successful update. If the health check fails, the system automatically rolls back to the previous version.

**Payload Updates**: Payloads that support OTA updates implement a firmware update protocol (HTTP POST with binary payload, or DroneCAN firmware update service). The companion computer coordinates the update process, ensuring that payloads are not updated during active missions.

#### Rollback Mechanism

All updates are transactional: if an update fails or causes system instability, the previous version is automatically restored. The companion computer maintains two root filesystem partitions (A/B partitioning), booting from the active partition. When an update is applied, it is written to the inactive partition, and the bootloader is instructed to try booting from it on the next reboot. If the boot succeeds and health checks pass, the update is marked as successful. If the boot fails or health checks fail, the bootloader automatically reverts to the previous partition.

---

## Security Hardening

### Attack Surface Reduction

**Purpose**: Minimize the system's vulnerability to unauthorized access and malicious payloads.

#### Network Segmentation

The companion computer uses Linux network namespaces to isolate payload networks from the flight controller and ground station networks. Payloads cannot directly communicate with the flight controller or send MAVLink messages without going through the Payload Manager, which enforces access control policies.

#### Mandatory Access Control

SELinux or AppArmor policies restrict what payload processes can access. Payloads run in confined contexts that prevent them from:
- Reading or modifying flight-critical files
- Accessing other payloads' data
- Opening network connections to arbitrary destinations
- Executing arbitrary code with elevated privileges

#### Secure Boot

The companion computer's bootloader (U-Boot or UEFI) verifies the digital signature of the kernel and initramfs before booting, ensuring that only trusted code runs on the system. The root filesystem is mounted read-only, with writable directories (logs, configuration) mounted as separate partitions.

---

## Conclusion

The component specifications detailed in this document provide the technical foundation for implementing and integrating with the Quiver SDK. Each component is designed with modularity, security, and performance in mind, ensuring that the system can accommodate diverse payloads while maintaining flight safety and reliability. Developers and integrators should refer to these specifications when building payload drivers, extending ground control interfaces, or customizing the companion computer software stack.

---

## Next Documents

- **Level 4: API Reference & Data Models** - Complete protocol specifications, message formats, and code examples
- **Level 5: Developer Guide** - Step-by-step tutorials for building and integrating payloads

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Pan Robotics | Initial release |

**Related Documents**
- Level 1: Executive Overview
- Level 2: System Architecture
- QuiverPayloadArchitecture.doc (Reference Engineering Pod)
