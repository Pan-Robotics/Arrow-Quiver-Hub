# Quiver SDK Architecture
## Level 5: Developer Guide

**Document Version:** 1.0  
**Date:** January 2026  
**Author:** Pan Robotics  
**Classification:** Tutorial

---

## Introduction

This guide provides step-by-step tutorials for developers building payloads and integrating them with the Quiver SDK. It assumes familiarity with Python or C++ programming, basic networking concepts, and Linux command-line tools. Each tutorial builds progressively, starting with simple sensors and advancing to complex multi-sensor systems.

---

## Prerequisites

### Hardware Requirements

**Development Workstation**:
- Linux (Ubuntu 22.04 or later recommended), macOS, or Windows with WSL2
- 8 GB RAM minimum, 16 GB recommended
- 20 GB free disk space

**Payload Development Hardware**:
- Raspberry Pi Zero 2 W or Raspberry Pi 4/5 (for Ethernet-based payloads)
- ESP32 or STM32 development board (for CAN-based payloads)
- USB-to-Ethernet adapter (for testing without Quiver hardware)
- Breadboard, jumper wires, and basic electronics tools

**Quiver Test Platform** (optional but recommended):
- Quiver UAV with companion computer
- Flight controller (ArduPilot or PX4)
- Telemetry radio
- Ground control station (laptop with Mission Planner or QGroundControl)

### Software Requirements

**Development Tools**:
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y python3 python3-pip python3-venv git curl

# Python packages
pip3 install aiohttp pymavlink paho-mqtt

# Optional: Protocol Buffers compiler
sudo apt install -y protobuf-compiler
```

**Quiver SDK**:
```bash
# Clone SDK repository
git clone https://github.com/Pan-Robotics/quiver-sdk.git
cd quiver-sdk

# Install SDK
pip3 install -e .
```

---

## Tutorial 1: Simple HTTP Sensor Payload

### Objective

Build a basic temperature sensor payload that communicates via HTTP and publishes telemetry to MQTT.

### Step 1: Hardware Setup

For this tutorial, we'll simulate a temperature sensor using a Raspberry Pi's CPU temperature.

**Hardware**:
- Raspberry Pi Zero 2 W (or any Raspberry Pi)
- Power supply
- Network connection (Ethernet or Wi-Fi)

**Software Setup**:
```bash
# On the Raspberry Pi
sudo apt update
sudo apt install -y python3 python3-pip

pip3 install aiohttp paho-mqtt
```

### Step 2: Create Payload Script

Create a file named `temp_sensor_payload.py`:

```python
#!/usr/bin/env python3
"""
Simple temperature sensor payload for Quiver SDK
Reads CPU temperature and exposes it via HTTP API
"""

import asyncio
from aiohttp import web
import json
from datetime import datetime
import paho.mqtt.client as mqtt

class TemperatureSensorPayload:
    def __init__(self, ip='0.0.0.0', port=8080, mqtt_broker='192.168.144.15'):
        self.ip = ip
        self.port = port
        self.mqtt_broker = mqtt_broker
        self.mqtt_client = None
        self.app = web.Application()
        self.setup_routes()
        self.recording = False
        self.sample_rate = 1.0  # Hz
        
    def setup_routes(self):
        """Setup HTTP API routes"""
        self.app.router.add_get('/quiver/info', self.handle_info)
        self.app.router.add_get('/quiver/health', self.handle_health)
        self.app.router.add_get('/quiver/status', self.handle_status)
        self.app.router.add_post('/quiver/command', self.handle_command)
        self.app.router.add_get('/quiver/parameters', self.handle_get_parameters)
        self.app.router.add_put('/quiver/parameters/{name}', self.handle_set_parameter)
    
    def read_cpu_temperature(self):
        """Read CPU temperature from system"""
        try:
            with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                temp_millidegrees = int(f.read().strip())
                return temp_millidegrees / 1000.0
        except:
            return 25.0  # Default fallback
    
    async def handle_info(self, request):
        """Return payload information"""
        return web.json_response({
            "payload_type": "sensor",
            "manufacturer": "Tutorial Example",
            "model": "CPU-TEMP-1",
            "version": "1.0.0",
            "serial_number": "TUTORIAL-001",
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
        """Return health status"""
        return web.json_response({
            "status": "ok",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "uptime": 3600  # Simplified for tutorial
        })
    
    async def handle_status(self, request):
        """Return current status"""
        temp = self.read_cpu_temperature()
        return web.json_response({
            "power": {
                "voltage": 12.0,
                "current": 0.1,
                "temperature": temp
            },
            "operational_state": "recording" if self.recording else "idle",
            "error_code": 0,
            "error_message": "",
            "custom_fields": {
                "recording": self.recording,
                "current_temperature": temp,
                "sample_rate": self.sample_rate
            }
        })
    
    async def handle_command(self, request):
        """Handle commands"""
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
        """Return configurable parameters"""
        return web.json_response({
            "parameters": [
                {
                    "name": "sample_rate",
                    "value": self.sample_rate,
                    "type": "float",
                    "min": 0.1,
                    "max": 10.0,
                    "unit": "Hz",
                    "description": "Temperature sampling rate"
                }
            ]
        })
    
    async def handle_set_parameter(self, request):
        """Set parameter value"""
        param_name = request.match_info['name']
        data = await request.json()
        new_value = data.get('value')
        
        if param_name == 'sample_rate':
            old_value = self.sample_rate
            self.sample_rate = float(new_value)
            return web.json_response({
                "success": True,
                "parameter": param_name,
                "old_value": old_value,
                "new_value": self.sample_rate
            })
        else:
            return web.json_response({
                "success": False,
                "error": {
                    "code": "INVALID_PARAMETER",
                    "message": f"Unknown parameter: {param_name}"
                }
            }, status=400)
    
    def setup_mqtt(self):
        """Setup MQTT connection"""
        self.mqtt_client = mqtt.Client()
        self.mqtt_client.connect(self.mqtt_broker, 1883, 60)
        self.mqtt_client.loop_start()
        print(f"Connected to MQTT broker at {self.mqtt_broker}")
    
    async def telemetry_loop(self):
        """Publish telemetry data"""
        while True:
            if self.recording:
                temp = self.read_cpu_temperature()
                
                telemetry = {
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                    "payload_id": "temp_sensor1",
                    "data": {
                        "temperature_c": temp,
                        "sample_rate": self.sample_rate
                    }
                }
                
                # Publish to MQTT
                self.mqtt_client.publish(
                    "quiver/payloads/temp_sensor1/temperature",
                    json.dumps(telemetry)
                )
                print(f"Published: {temp:.2f}°C")
            
            # Wait based on sample rate
            await asyncio.sleep(1.0 / self.sample_rate)
    
    async def start(self):
        """Start the payload server"""
        # Setup MQTT
        self.setup_mqtt()
        
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
    # Create and start payload
    payload = TemperatureSensorPayload(
        ip='0.0.0.0',
        port=8080,
        mqtt_broker='192.168.144.15'  # Companion computer IP
    )
    asyncio.run(payload.start())
```

### Step 3: Test Locally

Before deploying to Quiver, test the payload locally:

```bash
# Run the payload
python3 temp_sensor_payload.py

# In another terminal, test the API
curl http://localhost:8080/quiver/info
curl http://localhost:8080/quiver/health
curl http://localhost:8080/quiver/status

# Start recording
curl -X POST http://localhost:8080/quiver/command \
  -H "Content-Type: application/json" \
  -d '{"command": "start_recording"}'

# Change sample rate
curl -X PUT http://localhost:8080/quiver/parameters/sample_rate \
  -H "Content-Type: application/json" \
  -d '{"value": 2.0}'
```

### Step 4: Deploy to Quiver

**Configure Network**:
1. Connect Raspberry Pi to Quiver payload port C1 (IP: 192.168.144.11)
2. Configure static IP on Raspberry Pi:

```bash
# Edit /etc/dhcpcd.conf
sudo nano /etc/dhcpcd.conf

# Add these lines:
interface eth0
static ip_address=192.168.144.11/24
static routers=192.168.144.15
static domain_name_servers=192.168.144.15
```

**Create Systemd Service**:
```bash
# Create service file
sudo nano /etc/systemd/system/quiver-payload.service
```

```ini
[Unit]
Description=Quiver Temperature Sensor Payload
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStart=/usr/bin/python3 /home/pi/temp_sensor_payload.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl enable quiver-payload.service
sudo systemctl start quiver-payload.service

# Check status
sudo systemctl status quiver-payload.service
```

### Step 5: Verify Integration

On the companion computer, verify the payload is discovered:

```bash
# Check payload manager logs
sudo journalctl -u quiver-payload-manager -f

# You should see:
# "Discovered payload: temp_sensor1 at 192.168.144.11"
```

In the web interface, navigate to the Payloads page and verify the temperature sensor appears with status "Active".

---

## Tutorial 2: Camera Payload with Video Streaming

### Objective

Build a camera payload that streams video via RTSP and responds to capture commands.

### Step 1: Hardware Setup

**Hardware**:
- Raspberry Pi 4 or 5
- Raspberry Pi Camera Module 3 (or compatible)
- Ribbon cable

**Connect Camera**:
1. Power off Raspberry Pi
2. Connect camera ribbon cable to CSI port
3. Power on and verify camera is detected:

```bash
libcamera-hello --list-cameras
# Should show: Available cameras
```

### Step 2: Install Dependencies

```bash
sudo apt update
sudo apt install -y python3-picamera2 python3-opencv
pip3 install aiohttp paho-mqtt av
```

### Step 3: Create Camera Payload

Create `camera_payload.py`:

```python
#!/usr/bin/env python3
"""
Camera payload with video streaming for Quiver SDK
"""

import asyncio
from aiohttp import web
import json
from datetime import datetime
from picamera2 import Picamera2
from picamera2.encoders import H264Encoder
from picamera2.outputs import FileOutput
import socket
import threading

class RTSPServer:
    """Simple RTSP server for video streaming"""
    def __init__(self, port=8554):
        self.port = port
        self.clients = []
        self.running = False
        
    def start(self):
        """Start RTSP server"""
        self.running = True
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind(('0.0.0.0', self.port))
        self.server_socket.listen(5)
        
        threading.Thread(target=self._accept_clients, daemon=True).start()
        print(f"RTSP server listening on port {self.port}")
    
    def _accept_clients(self):
        """Accept client connections"""
        while self.running:
            try:
                client_socket, addr = self.server_socket.accept()
                self.clients.append(client_socket)
                print(f"RTSP client connected: {addr}")
            except:
                break
    
    def write(self, data):
        """Write data to all connected clients"""
        for client in self.clients[:]:
            try:
                client.send(data)
            except:
                self.clients.remove(client)

class CameraPayload:
    def __init__(self, ip='0.0.0.0', port=8080):
        self.ip = ip
        self.port = port
        self.app = web.Application()
        self.setup_routes()
        
        # Camera setup
        self.camera = Picamera2()
        self.camera_config = self.camera.create_video_configuration(
            main={"size": (1920, 1080), "format": "RGB888"},
            encode="main"
        )
        self.camera.configure(self.camera_config)
        
        # Streaming
        self.encoder = H264Encoder(bitrate=2000000)
        self.rtsp_server = RTSPServer(port=8554)
        self.streaming = False
        self.recording = False
        
        # Parameters
        self.resolution = (1920, 1080)
        self.framerate = 30
        self.bitrate = 2000000
        
    def setup_routes(self):
        """Setup HTTP API routes"""
        self.app.router.add_get('/quiver/info', self.handle_info)
        self.app.router.add_get('/quiver/health', self.handle_health)
        self.app.router.add_get('/quiver/status', self.handle_status)
        self.app.router.add_post('/quiver/command', self.handle_command)
        self.app.router.add_get('/quiver/parameters', self.handle_get_parameters)
        self.app.router.add_put('/quiver/parameters/{name}', self.handle_set_parameter)
    
    async def handle_info(self, request):
        """Return payload information"""
        return web.json_response({
            "payload_type": "camera",
            "manufacturer": "Tutorial Example",
            "model": "PI-CAM-HD",
            "version": "1.0.0",
            "serial_number": "TUTORIAL-002",
            "capabilities": ["video_streaming", "photo_capture"],
            "protocols": {
                "control": "http",
                "telemetry": "mqtt",
                "streaming": "rtsp"
            },
            "endpoints": {
                "control_api": f"http://{request.host}/quiver",
                "video_stream": f"rtsp://{request.host.split(':')[0]}:8554/stream"
            }
        })
    
    async def handle_health(self, request):
        """Return health status"""
        return web.json_response({
            "status": "ok",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "uptime": 3600
        })
    
    async def handle_status(self, request):
        """Return current status"""
        return web.json_response({
            "power": {
                "voltage": 12.0,
                "current": 0.8,
                "temperature": 45.0
            },
            "operational_state": "streaming" if self.streaming else "idle",
            "error_code": 0,
            "error_message": "",
            "custom_fields": {
                "streaming": self.streaming,
                "recording": self.recording,
                "resolution": f"{self.resolution[0]}x{self.resolution[1]}",
                "framerate": self.framerate,
                "bitrate": self.bitrate
            }
        })
    
    async def handle_command(self, request):
        """Handle commands"""
        data = await request.json()
        command = data.get('command')
        parameters = data.get('parameters', {})
        
        if command == 'start_streaming':
            await self.start_streaming()
            return web.json_response({
                "success": True,
                "message": "Streaming started"
            })
        elif command == 'stop_streaming':
            await self.stop_streaming()
            return web.json_response({
                "success": True,
                "message": "Streaming stopped"
            })
        elif command == 'capture_image':
            filename = await self.capture_image()
            return web.json_response({
                "success": True,
                "message": "Image captured",
                "filename": filename
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
        """Return configurable parameters"""
        return web.json_response({
            "parameters": [
                {
                    "name": "resolution",
                    "value": f"{self.resolution[0]}x{self.resolution[1]}",
                    "type": "string",
                    "options": ["1920x1080", "1280x720", "640x480"],
                    "description": "Video resolution"
                },
                {
                    "name": "framerate",
                    "value": self.framerate,
                    "type": "integer",
                    "min": 10,
                    "max": 60,
                    "unit": "fps",
                    "description": "Video framerate"
                },
                {
                    "name": "bitrate",
                    "value": self.bitrate,
                    "type": "integer",
                    "min": 500000,
                    "max": 10000000,
                    "unit": "bps",
                    "description": "Video bitrate"
                }
            ]
        })
    
    async def handle_set_parameter(self, request):
        """Set parameter value"""
        param_name = request.match_info['name']
        data = await request.json()
        new_value = data.get('value')
        
        if param_name == 'resolution':
            old_value = f"{self.resolution[0]}x{self.resolution[1]}"
            width, height = map(int, new_value.split('x'))
            self.resolution = (width, height)
            return web.json_response({
                "success": True,
                "parameter": param_name,
                "old_value": old_value,
                "new_value": new_value,
                "note": "Restart streaming for changes to take effect"
            })
        elif param_name == 'framerate':
            old_value = self.framerate
            self.framerate = int(new_value)
            return web.json_response({
                "success": True,
                "parameter": param_name,
                "old_value": old_value,
                "new_value": self.framerate
            })
        elif param_name == 'bitrate':
            old_value = self.bitrate
            self.bitrate = int(new_value)
            return web.json_response({
                "success": True,
                "parameter": param_name,
                "old_value": old_value,
                "new_value": self.bitrate
            })
        else:
            return web.json_response({
                "success": False,
                "error": {
                    "code": "INVALID_PARAMETER",
                    "message": f"Unknown parameter: {param_name}"
                }
            }, status=400)
    
    async def start_streaming(self):
        """Start video streaming"""
        if not self.streaming:
            self.rtsp_server.start()
            self.camera.start_recording(self.encoder, FileOutput(self.rtsp_server))
            self.streaming = True
            print("Video streaming started")
    
    async def stop_streaming(self):
        """Stop video streaming"""
        if self.streaming:
            self.camera.stop_recording()
            self.streaming = False
            print("Video streaming stopped")
    
    async def capture_image(self):
        """Capture a single image"""
        filename = f"/tmp/capture_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
        self.camera.capture_file(filename)
        print(f"Image captured: {filename}")
        return filename
    
    async def start(self):
        """Start the payload server"""
        # Start camera
        self.camera.start()
        print("Camera initialized")
        
        # Start web server
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, self.ip, self.port)
        await site.start()
        print(f"Payload server running on {self.ip}:{self.port}")
        
        # Keep running
        await asyncio.Event().wait()

if __name__ == '__main__':
    payload = CameraPayload()
    asyncio.run(payload.start())
```

### Step 4: Test and Deploy

Test locally, then deploy using the same systemd service approach as Tutorial 1.

**View Stream**:
```bash
# Using VLC or ffplay
vlc rtsp://192.168.144.11:8554/stream
# or
ffplay rtsp://192.168.144.11:8554/stream
```

---

## Tutorial 3: DroneCAN Rangefinder Payload

### Objective

Build a rangefinder payload that communicates via DroneCAN for low-latency integration with the flight controller.

### Step 1: Hardware Setup

**Hardware**:
- STM32 development board (e.g., STM32F103C8T6 "Blue Pill")
- MCP2515 CAN transceiver module
- Ultrasonic rangefinder (HC-SR04 or similar)
- Jumper wires

**Connections**:

| STM32 Pin | MCP2515 Pin | Function |
|-----------|-------------|----------|
| PA5 | SCK | SPI Clock |
| PA6 | MISO | SPI MISO |
| PA7 | MOSI | SPI MOSI |
| PA4 | CS | Chip Select |
| PA3 | INT | Interrupt |
| 3.3V | VCC | Power |
| GND | GND | Ground |

| STM32 Pin | HC-SR04 Pin | Function |
|-----------|-------------|----------|
| PB0 | TRIG | Trigger |
| PB1 | ECHO | Echo |
| 5V | VCC | Power |
| GND | GND | Ground |

### Step 2: Install Development Tools

```bash
# Install PlatformIO
pip3 install platformio

# Create project
pio project init --board bluepill_f103c8 --project-option="framework=arduino"
```

### Step 3: Implement Firmware

Create `src/main.cpp`:

```cpp
#include <Arduino.h>
#include <SPI.h>
#include <mcp2515.h>

// DroneCAN configuration
#define CAN_NODE_ID 42
#define CAN_BITRATE CAN_1000KBPS

// Pins
#define TRIG_PIN PB0
#define ECHO_PIN PB1
#define CS_PIN PA4

MCP2515 mcp2515(CS_PIN);

// DroneCAN message IDs
#define UAVCAN_NODE_STATUS_ID 341
#define UAVCAN_RANGE_SENSOR_MEASUREMENT_ID 1050

uint32_t last_heartbeat = 0;
uint32_t last_measurement = 0;

void setup() {
  Serial.begin(115200);
  
  // Setup ultrasonic sensor
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  
  // Setup CAN
  SPI.begin();
  mcp2515.reset();
  mcp2515.setBitrate(CAN_BITRATE, MCP_8MHZ);
  mcp2515.setNormalMode();
  
  Serial.println("DroneCAN Rangefinder initialized");
}

float measureDistance() {
  // Trigger ultrasonic pulse
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  
  // Measure echo duration
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);  // 30ms timeout
  
  // Calculate distance in meters
  float distance = (duration * 0.000343) / 2.0;
  
  // Limit to valid range
  if (distance < 0.02 || distance > 4.0) {
    return -1.0;  // Invalid reading
  }
  
  return distance;
}

void sendNodeStatus() {
  struct can_frame frame;
  frame.can_id = UAVCAN_NODE_STATUS_ID | (CAN_NODE_ID << 8);
  frame.can_dlc = 7;
  
  // Uptime in seconds (4 bytes)
  uint32_t uptime = millis() / 1000;
  frame.data[0] = uptime & 0xFF;
  frame.data[1] = (uptime >> 8) & 0xFF;
  frame.data[2] = (uptime >> 16) & 0xFF;
  frame.data[3] = (uptime >> 24) & 0xFF;
  
  // Health (1 byte): 0 = OK
  frame.data[4] = 0;
  
  // Mode (1 byte): 0 = Operational
  frame.data[5] = 0;
  
  // Sub-mode (1 byte)
  frame.data[6] = 0;
  
  mcp2515.sendMessage(&frame);
}

void sendRangeMeasurement(float distance) {
  struct can_frame frame;
  frame.can_id = UAVCAN_RANGE_SENSOR_MEASUREMENT_ID | (CAN_NODE_ID << 8);
  frame.can_dlc = 8;
  
  // Sensor ID (1 byte)
  frame.data[0] = 0;
  
  // Beam orientation (quaternion, simplified to downward)
  // For downward-facing: [0, 0, 0, 1]
  frame.data[1] = 0;
  frame.data[2] = 0;
  frame.data[3] = 0;
  frame.data[4] = 127;  // Scaled quaternion component
  
  // Range (2 bytes, in cm)
  uint16_t range_cm = (uint16_t)(distance * 100.0);
  frame.data[5] = range_cm & 0xFF;
  frame.data[6] = (range_cm >> 8) & 0xFF;
  
  // Range type (1 byte): 0 = Ultrasonic
  frame.data[7] = 0;
  
  mcp2515.sendMessage(&frame);
  
  Serial.print("Distance: ");
  Serial.print(distance);
  Serial.println(" m");
}

void loop() {
  uint32_t now = millis();
  
  // Send heartbeat every 1 second
  if (now - last_heartbeat >= 1000) {
    sendNodeStatus();
    last_heartbeat = now;
  }
  
  // Send measurement every 50ms (20 Hz)
  if (now - last_measurement >= 50) {
    float distance = measureDistance();
    if (distance > 0) {
      sendRangeMeasurement(distance);
    }
    last_measurement = now;
  }
  
  delay(10);
}
```

### Step 4: Build and Flash

```bash
# Build firmware
pio run

# Flash to STM32
pio run --target upload

# Monitor serial output
pio device monitor
```

### Step 5: Configure Flight Controller

Connect the rangefinder to the Quiver CAN bus and configure ArduPilot:

```
# In Mission Planner, set parameters:
RNGFND1_TYPE = 6  # UAVCAN
RNGFND1_MIN_CM = 20
RNGFND1_MAX_CM = 400
RNGFND1_ORIENT = 25  # Downward facing
```

The rangefinder will now provide terrain data to the flight controller for altitude hold and terrain following.

---

## Tutorial 4: Multi-Sensor Mission Script

### Objective

Create a companion computer mission script that coordinates multiple payloads for an automated survey mission.

### Step 1: Install MAVSDK

```bash
pip3 install mavsdk
```

### Step 2: Create Mission Script

Create `survey_mission.py`:

```python
#!/usr/bin/env python3
"""
Automated survey mission coordinating camera and LiDAR payloads
"""

import asyncio
from mavsdk import System
from mavsdk.mission import MissionItem, MissionPlan
import aiohttp
import json

class SurveyMission:
    def __init__(self, vehicle_address='udp://:14540', companion_api='http://192.168.144.15:8080'):
        self.vehicle_address = vehicle_address
        self.companion_api = companion_api
        self.drone = System()
        
    async def connect_vehicle(self):
        """Connect to flight controller"""
        print(f"Connecting to vehicle at {self.vehicle_address}")
        await self.drone.connect(system_address=self.vehicle_address)
        
        # Wait for vehicle to be ready
        async for state in self.drone.core.connection_state():
            if state.is_connected:
                print("Vehicle connected")
                break
    
    async def send_payload_command(self, payload_id, command, parameters={}):
        """Send command to payload via companion computer API"""
        async with aiohttp.ClientSession() as session:
            url = f"{self.companion_api}/api/payloads/{payload_id}/command"
            payload = {
                "command": command,
                "parameters": parameters
            }
            async with session.post(url, json=payload) as resp:
                result = await resp.json()
                print(f"Payload {payload_id}: {result.get('message', 'Command sent')}")
                return result
    
    async def create_survey_pattern(self, center_lat, center_lon, altitude, spacing=50):
        """Create a lawnmower survey pattern"""
        mission_items = []
        
        # Takeoff
        mission_items.append(MissionItem(
            center_lat, center_lon, altitude,
            10,  # Speed m/s
            True,  # Is fly-through
            float('nan'), float('nan'), float('nan'), float('nan'),
            MissionItem.CameraAction.NONE
        ))
        
        # Survey grid (simplified 4x4 pattern)
        lat_offset = 0.0001  # Approximately 11 meters
        lon_offset = 0.0001
        
        for i in range(4):
            for j in range(4):
                lat = center_lat + (i - 1.5) * lat_offset
                lon = center_lon + (j - 1.5) * lon_offset
                
                mission_items.append(MissionItem(
                    lat, lon, altitude,
                    5,  # Speed m/s
                    True,
                    float('nan'), float('nan'), float('nan'), float('nan'),
                    MissionItem.CameraAction.TAKE_PHOTO if j % 2 == 0 else MissionItem.CameraAction.NONE
                ))
        
        # Return to launch
        mission_items.append(MissionItem(
            center_lat, center_lon, altitude,
            10,
            True,
            float('nan'), float('nan'), float('nan'), float('nan'),
            MissionItem.CameraAction.NONE
        ))
        
        return MissionPlan(mission_items)
    
    async def run_survey(self, center_lat, center_lon, altitude=50):
        """Execute survey mission"""
        print("Starting survey mission")
        
        # Connect to vehicle
        await self.connect_vehicle()
        
        # Start payload recording
        print("Starting payload recording...")
        await self.send_payload_command('camera1', 'start_streaming')
        await self.send_payload_command('lidar1', 'start_recording')
        
        # Create and upload mission
        print("Creating survey pattern...")
        mission_plan = await self.create_survey_pattern(center_lat, center_lon, altitude)
        
        print("Uploading mission...")
        await self.drone.mission.upload_mission(mission_plan)
        
        # Arm and start mission
        print("Arming vehicle...")
        await self.drone.action.arm()
        
        print("Starting mission...")
        await self.drone.mission.start_mission()
        
        # Monitor mission progress
        async for mission_progress in self.drone.mission.mission_progress():
            print(f"Mission progress: {mission_progress.current}/{mission_progress.total}")
            
            if mission_progress.current == mission_progress.total:
                print("Mission complete!")
                break
        
        # Stop payload recording
        print("Stopping payload recording...")
        await self.send_payload_command('camera1', 'stop_streaming')
        await self.send_payload_command('lidar1', 'stop_recording')
        
        print("Survey mission completed")

async def main():
    mission = SurveyMission()
    
    # Example: Survey area around coordinates
    await mission.run_survey(
        center_lat=37.7749,
        center_lon=-122.4194,
        altitude=50  # meters
    )

if __name__ == '__main__':
    asyncio.run(main())
```

### Step 3: Run Mission

```bash
python3 survey_mission.py
```

The script will:
1. Connect to the flight controller
2. Start camera streaming and LiDAR recording
3. Upload a survey pattern
4. Arm and execute the mission
5. Stop recording when complete

---

## Best Practices

### Error Handling

Always implement robust error handling in payload code:

```python
async def handle_command(self, request):
    try:
        data = await request.json()
        command = data.get('command')
        
        # Validate command
        if not command:
            raise ValueError("Missing command field")
        
        # Execute command
        result = await self.execute_command(command)
        
        return web.json_response({
            "success": True,
            "result": result
        })
    
    except ValueError as e:
        return web.json_response({
            "success": False,
            "error": {
                "code": "INVALID_REQUEST",
                "message": str(e)
            }
        }, status=400)
    
    except Exception as e:
        # Log unexpected errors
        print(f"Unexpected error: {e}")
        return web.json_response({
            "success": False,
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "An unexpected error occurred"
            }
        }, status=500)
```

### Logging

Use Python's logging module for structured logging:

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/var/log/quiver/payload.log'),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger('quiver.payload')

# Usage
logger.info("Payload initialized")
logger.warning("Low battery voltage: %.2fV", voltage)
logger.error("Failed to connect to sensor", exc_info=True)
```

### Configuration Management

Use configuration files instead of hardcoding values:

```python
import yaml

# Load configuration
with open('/etc/quiver/payload-config.yaml', 'r') as f:
    config = yaml.safe_load(f)

# Access values
mqtt_broker = config['mqtt']['broker']
sample_rate = config['sensor']['sample_rate']
```

### Testing

Write unit tests for payload logic:

```python
import unittest
from unittest.mock import Mock, patch

class TestPayloadCommands(unittest.TestCase):
    def setUp(self):
        self.payload = TemperatureSensorPayload()
    
    def test_start_recording(self):
        result = self.payload.handle_start_recording()
        self.assertTrue(result['success'])
        self.assertTrue(self.payload.recording)
    
    def test_invalid_command(self):
        with self.assertRaises(ValueError):
            self.payload.handle_command('invalid_command')

if __name__ == '__main__':
    unittest.main()
```

---

## Troubleshooting

### Payload Not Discovered

**Symptoms**: Payload doesn't appear in web interface

**Solutions**:
1. Verify network connectivity: `ping 192.168.144.11`
2. Check payload is responding: `curl http://192.168.144.11:8080/quiver/info`
3. Review payload manager logs: `sudo journalctl -u quiver-payload-manager -f`
4. Verify DHCP lease: `cat /var/lib/dhcp/dhcpd.leases`

### High Latency

**Symptoms**: Slow command response, delayed telemetry

**Solutions**:
1. Check network bandwidth: `iperf3 -c 192.168.144.15`
2. Reduce telemetry rate
3. Use binary formats (Protocol Buffers) instead of JSON
4. Optimize payload code (use async I/O, avoid blocking operations)

### CAN Bus Communication Failures

**Symptoms**: DroneCAN messages not received by flight controller

**Solutions**:
1. Verify CAN bus termination (120Ω resistors at each end)
2. Check bitrate matches flight controller (typically 1 Mbps)
3. Verify node ID is unique (1-127)
4. Use oscilloscope to check CAN_H and CAN_L signal integrity
5. Review DroneCAN logs in flight controller

---

## Next Steps

### Advanced Topics

For developers ready to explore advanced SDK features:

1. **Custom MAVLink Messages**: Define and implement custom MAVLink messages for specialized payloads
2. **ROS2 Integration**: Use ROS2 for complex perception and navigation algorithms
3. **Machine Learning**: Deploy TensorFlow Lite or PyTorch models on the companion computer
4. **Swarm Coordination**: Implement multi-vehicle coordination protocols
5. **Custom Ground Control**: Build specialized ground control interfaces using the Web API

### Community Resources

- **GitHub Repository**: https://github.com/Pan-Robotics/quiver-sdk
- **Developer Forum**: [To be established]
- **Example Payloads**: https://github.com/Pan-Robotics/quiver-payload-examples
- **Documentation**: https://docs.quiver-sdk.org

---

## Conclusion

This developer guide has provided hands-on tutorials for building Quiver SDK payloads, from simple sensors to complex multi-sensor systems. By following these examples and best practices, developers can create robust, production-ready payloads that integrate seamlessly with the Quiver platform.

The SDK's modular architecture and standards-based protocols ensure that payloads remain compatible as the platform evolves, protecting your development investment and enabling long-term maintainability.

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Pan Robotics | Initial release |

**Related Documents**
- Level 1: Executive Overview
- Level 2: System Architecture
- Level 3: Component Specifications
- Level 4: API Reference & Data Models
- QuiverPayloadArchitecture.doc (Reference Engineering Pod)
