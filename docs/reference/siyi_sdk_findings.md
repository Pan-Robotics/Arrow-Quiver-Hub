# SIYI A8 Mini SDK Protocol Findings

## Source
- Document: SIYI Gimbal Camera External SDK Protocol Document Update Log V0.1.1
- Date: 2025.02.26
- Total pages: 110

## Protocol Format (Chapter 1)

Binary protocol over TCP with the following frame structure:

| Field    | Index | Bytes    | Description                                           |
|----------|-------|----------|-------------------------------------------------------|
| STX      | 0     | 2        | 0x6655 starting mark (low byte first)                 |
| CTRL     | 2     | 1        | 0: need_ack, 1: ack_pack, 2-7: reserved               |
| Data_len | 3     | 2        | Data field byte length (low byte first)               |
| SEQ      | 5     | 2        | Frame sequence 0-65535 (low byte first)               |
| CMD_ID   | 7     | 1        | Command ID                                            |
| DATA     | 8     | Data_len | Command data payload                                  |
| CRC16    | -     | 2        | CRC16 checksum (low byte first)                       |

**Key Notes:**
- All multi-byte values are little-endian (low byte first)
- TCP connection required
- Camera requires up to 30 seconds startup time

## Communication Commands (Chapter 2)

### 0x00: TCP Heartbeat
- Heartbeat packet: `55 66 01 01 00 00 00 00 00 59 8B`
- Only supported in TCP connection
- No ACK response

### 0x01: Request Firmware Version
- Returns: camera_firmware_ver, gimbal_firmware_ver, zoom_firmware_ver (all uint32_t)
- Example: 0x6E030203 → v3.2.3
- 4th byte (high byte) should be ignored

## Key Commands to Extract (need more pages)
- Gimbal control (pan/tilt)
- Zoom control
- Photo capture
- Video recording
- RTSP stream configuration
- Attitude data


## Gimbal Control Commands

### 0x0B: Function Feedback Response
Returns status info:
- 0: Photo captured successfully
- 1: Photo failed (check TF card)
- 2: HDR on
- 3: HDR off
- 4: Video recording failed (check TF card)
- 5: Recording started
- 6: Recording stopped

### 0x0C: Capture Photo / Record Video
CMD_ID: 0x0C
Send: func_type (uint8_t)
- 0: Capture photo
- 1: HDR toggle (not supported)
- 2: Start recording
- 3: Lock mode
- 4: Follow mode
- 5: FPV mode
- 6: Enable HDMI output (reboot required)
- 7: Enable CVBS output (reboot required)
- 8: Disable HDMI/CVBS (reboot required)
- 9: Tilt downward
- 10: Zoom linkage

No ACK response

### 0x0D: Request Gimbal Attitude Data
Returns (all int16_t, divide by 10 for actual degrees):
- yaw: Yaw angle
- pitch: Pitch angle
- roll: Roll angle
- yaw_velocity: Gyroscope yaw angular velocity
- pitch_velocity: Gyroscope pitch angular velocity
- roll_velocity: Gyroscope roll angular velocity

Notes:
- Use command 0x25 to set data transmission frequency for continuous streaming
- Coordinate system: NED (North-East-Down)
- Yaw angle derived from magnetic encoder

### 0x0E: Set Gimbal Attitude Angles
Send (int16_t, multiply by 10):
- yaw: Target yaw angle
- pitch: Target pitch angle

ACK returns current angles (yaw, pitch, roll)

**A8 mini Angle Control Range:**
- Yaw: -135.0° to 135.0°
- Pitch: -90.0° to 25.0°

### 0x0F: Absolute Zoom Auto Focus
Send:
- Absolute_movement_int (uint8_t): Integer part of zoom (0x1 ~ 0x1E = 1x-30x)
- Absolute_movement_float (uint8_t): Decimal part (0x0 ~ 0x9)

### 0x10: Request Video Stitching Mode
Returns vdisp_mode (for thermal cameras):
- 0: Main=Zoom & Thermal, Sub=Wide angle
- 1: Main=Wide angle & Thermal, Sub=Zoom
- 2: Main=Zoom & Wide angle, Sub=Thermal
- 3: Non-stitching (Main=Zoom, Sub=Thermal)
- 4: Non-stitching (Main=Wide angle)


## Additional Control Commands

### 0x04: Auto Focus
Send: auto_focus (1=trigger), touch_x, touch_y (coordinates for focus point)
Returns: sta (1=success, 0=error)

### 0x05: Manual Zoom with Autofocus
Send: zoom (int8_t) - 1=zoom in, 0=stop, -1=zoom out
Returns: zoom_multiple (uint16_t) - divide by 10 for actual zoom level

### 0x06: Manual Focus
Send: focus (int8_t) - 1=far focus, 0=stop, -1=near focus
Returns: sta (1=success, 0=error)

### 0x07: Gimbal Rotation Control (VELOCITY MODE)
Send:
- turn_yaw (int8_t): -100 to 100, controls rotation speed
- turn_pitch (int8_t): -100 to 100, controls tilt speed
Send 0 to stop rotation.
Returns: sta (1=success, 0=error)

### 0x08: One-Key Centering
Send: center_pos (uint8_t)
- 1: One-key center
- 2: Center downward
- 3: Center
- 4: Downward
Returns: sta (1=success, 0=error)

### 0x0A: Request Camera System Information
Returns:
- hdr_sta: 0=Off, 1=On
- record_sta: 0=Not recording, 1=Recording, 2=No TF card

---

## A8 Mini User Manual Key Information

### Product Overview
- 4K 1/1.7-inch Sony starlight sensor
- Max 6X digital zoom
- 4K video recording and photography
- HDR and starlight night vision
- CVBS (AV) output for analog FPV
- Ethernet video streaming via RTSP

### Video Output Options
1. **Ethernet RTSP** - Primary method for digital video
2. **CVBS** - Analog video output
3. **Micro-HDMI** - Direct HDMI output

### RTSP Video Streaming (Section 2.3.2)
The A8 mini outputs **four video streams** from the same RTSP addresses:
- Main stream (4K)
- Sub stream (lower resolution)

### Common IP Addresses (Section 4.6)
Camera default IP configuration for Ethernet connection.

### Control Methods
1. SIYI Link (proprietary)
2. ArduPilot Driver via UART
3. MAVLink Gimbal Protocol via UART
4. S.Bus signal
5. **SDK Protocol via TCP/Ethernet** (our integration method)

### Network Configuration
- Camera has built-in Ethernet interface
- Connects directly to companion computer
- TCP socket for SDK commands
- RTSP for video streaming


---

## CRITICAL: Network Configuration for Quiver Integration

### IP Addresses (from manual page 60-61)

| Device | IP Address |
|--------|------------|
| SIYI Air Unit | 192.168.144.11 |
| SIYI Ground Unit | 192.168.144.12 |
| SIYI Handheld Ground Station | 192.168.144.20 |
| SIYI Ethernet to HDMI Converter | 192.168.144.50 |
| SIYI AI Camera | 192.168.144.60 |
| **SIYI A8 mini (Gimbal Camera)** | **192.168.144.25** |

### RTSP Video Stream URLs

| Stream | URL |
|--------|-----|
| SIYI AI Camera | rtsp://192.168.144.60:554/video0 |
| **Main Stream (4K)** | **rtsp://192.168.144.25:8554/video1** |
| **Sub Stream (lower res)** | **rtsp://192.168.144.25:8554/video2** |

### SDK Control Port
- **TCP Port 37260** (default SDK command port)

### Integration Summary for Quiver

**Network Path:**
```
A8 mini Camera (192.168.144.25)
    ↓ Ethernet
Integrated Switch
    ↓ Ethernet  
Companion Pi (192.168.144.XX)
    ↓ Wireless
Quiver Hub (cloud)
```

**Two Communication Channels:**
1. **SDK Control (TCP:37260)** - Gimbal control, photo/video, zoom, focus
2. **Video Stream (RTSP:8554)** - Live video feed

