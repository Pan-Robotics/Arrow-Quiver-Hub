# Quiver SDK Research Notes

## Document Analysis: QuiverPayloadArchitecture.doc

### Purpose
An end-to-end easy to modify template pipeline for developing, interacting with, configuring, sending and receiving commands/data, to and from Quiver payload modules, modifying the behaviour of the UAV accordingly.

### Core Components

#### 1. Payload Configuration Framework
- Provides arbitrary Quiver Payload development Template
- Preconfigured with Quiver's connection idiosyncrasies
- Facilitates Cambrian explosion of multi-source payload modules
- Maximizes Quiver use cases, ecosystem integration, and value proposition

**Interface Options:**
- **DroneCAN**: Low-bandwidth high fidelity real-time control
- **Data over TCP and MAVLink-over-Ethernet**: High-bandwidth data
- **Digital I/O and Analog I/O**: Hardware triggers

**Template Provides:**
- C++ & Python firmware setup scripts, code examples with 2 mock modules
- Raspberry Pi, ESP32, STM32 compatible setup
- Forkable GitHub template repository
- Mission Planner plugin support

#### 2. Ground Station Payload Plugins
- DLL add-on written in C# inserted into Mission Planner runtime
- Drop-down menu UI with information window to display attachment module list
- Each menu item opens tailored interface window for each module
- Module developers provide tailored window elements
- Configuration commands and telemetry data sent to UAV over RF link

#### 3. Ground Station Payload Hub WebPortal
Web server with API endpoints from every Quiver unit and "App Store" interface

**Features:**
- Tabbed App Interface (Drone Info Tab, Payload Pipeline Tabs)
- App Store Payload Pipeline Selection Interface
- User Interface Builder to create data controls and display tabs
- Post Pipeline App to Store

**Example Data Pipelines:**
1. Flight Controller → Battery (UAVCAN) → Companion Computer (4G HTTP POST) → Quiver Hub → Display
2. RPLidar → Raspberry Pi → Attachment Interface (Ethernet TCP/UDP) → Companion Computer (HTTP POST) → Web Portal → Live Visualization

**Current Implementation:** https://rplidar-viz-cjlhozxe.manus.space/

#### 4. Companion Computer Command Center
- Triggers programs using MAVSDK communication
- Runs preset actions and routines
- Attachment-specific configuration for data parsing
- Potential for waypoint mission automation
- Potential for OTA firmware updates for FC and payload attachments
- Potential for active log file capture

### Network Topology

**Hardware Components:**
- 3 Payload Attachment Connectors (C1, C2, C3)
- Ethernet Network Switch
- CAN Hub
- Flight Controller (FC)
- Companion Computer (CC): Raspberry Pi 4 or 5
- Mission Planner (laptop/tablet via RF link)

**10-Pin Connector Pinout:**
1. Ethernet TX+ (Transmit positive)
2. Ethernet TX- (Transmit negative)
3. Ethernet RX+ (Receive positive)
4. Ethernet RX- (Receive negative)
5. CAN H (CAN bus high signal 3.3v)
6. CAN L (CAN bus low signal 3.3v)
7. Analog I/O (0-5V)
8. Digital I/O (FMU_CH1 digital I/O 3.3v)
9. 12V Power (12V DC supply 2.0A max)
10. Ground (System ground)

### Example Payload Applications

#### Environmental Sensor
- Temperature, Humidity, Pressure
- Interface: CAN (DroneCAN)
- Power: 12V for heater element
- Message: SCALED_PRESSURE
- DroneCAN: RawSensor

#### Camera System
- HD/4K Video & Photography
- Interface: Ethernet (MAVLink)
- Trigger: Digital I/O (FMU_CH1) - CAMERA_IMAGE_CAPTURE_D
- Streaming: UDP video stream

#### LIDAR System
- 3D Mapping & Obstacle Detection
- Interface: Ethernet (high-bandwidth)
- Power: 12V (high current)
- Message: DISTANCE_SENSOR
- Data: Point cloud streaming

#### Agricultural Sprayer
- Precision Liquid Dispensing
- Pump Control: Analog I/O (0-5V)
- Activation: Digital I/O trigger - COMMAND_LONG
- Safety: Emergency stop via CAN

### Development Process

**Test Setup:**
- Rpi CM4 as Onboard Companion Computer
- Rpi Zero 2 W as Mock Payloads
- Pixhawk CM4 Breakout with Pixhawk 6X as Flight Controller

**Flight Controller Static IP Configuration:**
- Config → Full Parameters List → NET
- Mac Address: 194.175.81.73.30.240
- Flight Controller IP: 192.168.144.10

**Companion Computer Ports (C1, C2, C3, CPC):**
- C1: Port 2, IP 192.168.144.11, UDP Server, MAVlink2, TCP 14540
- C2: Port 3, IP 192.168.144.12, UDP Server, MAVlink2, TCP 14540
- C3: Port 4, IP 192.168.144.13, UDP Server, MAVlink2, TCP 14540
- CPC: Port 1, IP 192.168.144.15, UDP Client, MAVlink2, TCP 14540

**CAN Bus Settings:**
- MCP2515 with Raspberry Pi (38-3D setup)
- Interrupt pin: GPIO26 (PIN 37)
- 16 MHz oscillator

**SPI Setup:**
- CS: GPIO8 (Pin 24, SPI0_CE0)
- SO: GPIO9 (Pin 21, SPI0_MISO)
- SI: GPIO10 (Pin 19, SPI0_MOSI)
- SCK: GPIO11 (Pin 23, SPI0_SCLK)
- INT: GPIO26 (Pin 37)

### SDK Workflow

**User Flow:**
1. Web Portal (quiver-drone.com)
2. Login/Sign up to User Database
3. Add Drones to Setup (via Local Drone GUI)
4. Tabbed App Interface (Drone Info Tab, Payload Pipeline Tab)
5. App Store Payload Pipeline Selection Interface

**Developer Flow:**
1. User Flow
2. Plus button in App Store to Create Payload
3. Upload Payload Firmware (via .py executable)
4. Use Interface Builder to create data controls and display tab
5. Post App to store

**CC Builder Flow:**
1. Base File: Get Cabird
2. .py executables
3. Service Manifestation Server (to manage executables)
4. Executable Run Service
5. 4 Eth Ports, 4 CAN Ports
6. Parse, GET / POST Data to Quiver hub

**Physical System Flow:**
1. LAN Network & Executables Run Service
2. 1 Eth port, 1 CAN port to CC and FC
3. Data Capture / Actuator

### GitHub Repositories

**Plugin and Hub:**
- Empty: https://github.com/Pan-Robotics/quiver-mission-planner-plugin
- Dev Branch Needs Updating: https://github.com/Pan-Robotics/Quiver-Hub

**Payload Firmware:**
- https://github.com/Pan-Robotics/Quiver-RpLidar-Test
- Out of Date: https://github.com/Pan-Robotics/quiver-payload-template

### Functionality Extension

**Data and Firmware Link:**
- Companion Computer Log Downloads and OTA updates

**Configuration Server:**
- How to turn a Raspberry pi into a Router - NextPCB
- Long Range Telemetry

**Fleet Management Tools:**
- Swarming — Mission Planner documentation

### Reference Links
- project-quiver-contract_Alex
- Quiver Payload Integration Guide.pptx
- Quiver Companion Computer
- Mock Quiver Product Brochure: https://quiverbroch-hgorkv9y.manus.space/
- Plugin Setup Repo: https://github.com/ArduPilot/MissionPlanner/tree/master/Plugins
- Template Repo: https://github.com/Pan-Robotics/quiver-mission-planner-plugin
- Plugin Repo: https://github.com/Pan-Robotics/quiver-payload-template (empty)
- DJI Payload Attachment SDK: Build a Drone Aerial-Specific toolkit


## DAO Forum Discussion: Unified Payload and Companion Computer SDK

### Vision
Transform Quiver from a modular UAV into a flexible aerial robotics platform - a "flying computer" with real-world applications and community-built extensions.

### Core Concept
A Payload and Companion Computer SDK that allows third parties to connect new sensors, actuators, or modules to Quiver without modifying firmware or reverse-engineering protocols. Built on top of MAVLink and MAVSDK standards.

### System Architecture Paths

#### Path 1: Direct-to-Flight-Controller Integration
- Payloads register directly as MAVLink modules
- Ideal for deterministic, low-latency systems (sensors, actuators)
- Uses CAN or UART links
- "Lean and fast" approach for immediate response times

#### Path 2: Companion-Computer-Mediated Integration
- Companion computer (e.g., Raspberry Pi 5) acts as intelligent middle layer
- Handles multiple complex payloads, higher-bandwidth data, mission logic
- Enables: perception, mapping, adaptive flight, payload coordination
- Supports OTA firmware updates, log management, AI-based automation
- Turns Quiver into distributed system: part robot, part server, part autonomous explorer

### SDK Building Blocks

1. **Code Templates**: Python or C++ for payloads and companion computer modules
2. **High-level APIs**: Telemetry, control, and mission logic using MAVSDK
3. **Standardized Formats**: Data and event formats for flight and payload communication
4. **Example Applications**: Mission scripts combining sensors, logic, and movement
5. **OTA Update Utilities**: Log management through MAVLink's FTP microservice

### Connectivity and Communication

**Companion Computer as Backbone:**
- 4G and 5G modems for broadband links
- Satellite modules for global reach
- High-power radios for localized operations
- Intelligent routing software for redundant links
- Enables operation anywhere: urban corridors to remote industrial sites

### Companion Computer Capabilities

1. Advanced path planning (dynamic terrain adaptation)
2. Payload coordination (multi-sensor/actuator missions)
3. Real-time perception and mapping (camera/LiDAR)
4. Local inference and decision-making (minimize ground dependence)
5. Over-the-air firmware and configuration management
6. Automated log syncing and maintenance diagnostics

**Result**: Transforms companion from passive link to genuine intelligence layer - an autonomous ecosystem that can reason, respond, and update itself mid-mission.

### Ground Control Evolution

**Extension Approaches:**
- Plugins for Mission Planner or QGroundControl
- Each payload gets own UI window/control tab
- Displays live telemetry, configuration, video feeds
- Web-based interface for unified mission visualization
- OTA management and fleet operations
- Single dashboard merging mission planning, payload control, companion monitoring

### Development Path

1. **Establish SDK Foundations**: Templates, code libraries, example payloads
2. **Release Companion Computer Reference Image**: Pre-installed MAVSDK, telemetry routing, update management
3. **Integrate Ground Systems**: Plugins or web dashboards for operator interfaces
4. **Build Developer Ecosystem**: Documentation, certification standards, shared templates, open repository

**Outcome**: Quiver evolves from single UAV to open robotics platform

### Open Questions

1. Should SDK remain purely MAVSDK-based or grow toward ROS2 for general robotics compatibility?
2. Should companion computer be standardized or open to any hardware meeting performance criteria?
3. Could framework expand to support ground robots, fixed installations, or hybrid systems?
4. What would an open registry of third-party payloads look like in practice?

### Strategic Vision

**Not just technical convenience** - represents making Quiver genuinely extensible as a platform others can experiment with, adapt, and expand upon. Evolution from configurable UAV to **programmable aerial computer** that invites others to build intelligence on top of it.

**Comparison**: Similar to DJI's Payload SDK but with more openness, flexibility, and fewer locked doors.
