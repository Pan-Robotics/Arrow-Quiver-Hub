# Quiver Camera Feed Application Architecture

## Overview

The Camera Feed application provides live video streaming and gimbal control for the built-in SIYI A8 mini gimbal camera on Quiver aircraft. Unlike payload devices that occupy payload slots (C1/C2/C3), the A8 mini is integrated directly into the airframe and connects to the companion computer via the onboard Ethernet switch.

This document describes how the Camera Feed application fits into the existing Quiver Hub architecture, leveraging the same patterns established for telemetry forwarding and point cloud visualization.

---

## System Context

### Network Topology

![Camera Feed Network Topology](https://private-us-east-1.manuscdn.com/sessionFile/EubhX8eorZmpnfu4bIKC1W/sandbox/TY62bFD1Botdh7S4iMUMwK-images_1769331821181_na1fn_L2hvbWUvdWJ1bnR1L2NhbWVyYV9mZWVkX25ldHdvcmtfdG9wb2xvZ3k.png?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvRXViaFg4ZW9yWm1wbmZ1NGJJS0MxVy9zYW5kYm94L1RZNjJiRkQxQm90ZGg3UzRpTVVNd0staW1hZ2VzXzE3NjkzMzE4MjExODFfbmExZm5fTDJodmJXVXZkV0oxYm5SMUwyTmhiV1Z5WVY5bVpXVmtYMjVsZEhkdmNtdGZkRzl3YjJ4dlozay5wbmciLCJDb25kaXRpb24iOnsiRGF0ZUxlc3NUaGFuIjp7IkFXUzpFcG9jaFRpbWUiOjE3OTg3NjE2MDB9fX1dfQ__&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=M7kp6QVdntuDa1csDlszPM3VAdRdJ2rVUg21rjWxAHQIhJhjY2onLeWyXrLDyhRag9H~iUcurrw2~O19uqPsvDPLs1f1eTCOlolT4KSvhWa8W~Z1Egw89yv0bVUwht7mSlyXo38j1hHBK1dZtY96Cq4dLt8mTC26xV-AuEEpCCDHFxeESN6wEYzmvGtyTXOZRnOhiIEUmSJALLjU9dv8Qx9QFYqLdqlCGhgjDskTEjlvsHBRPZXtLguJxs1eJ5t2O6NUUAQdUV0DvUTBYjZvRl~r6LmAG-frTZ5Z4S407iEL2BYFAYaeIJKG3miOCPygDqiwbG~EkX52o9BV263anQ__)

The A8 mini camera sits on the same `192.168.144.0/24` network as the companion computer. The companion acts as a bridge, receiving commands from Quiver Hub over the internet and forwarding them to the camera over the local Ethernet network.

### Communication Channels

The camera exposes two distinct interfaces that the Camera Feed application must handle:

| Channel | Protocol | Port | Purpose |
|---------|----------|------|---------|
| Control | TCP (binary) | 37260 | Gimbal movement, zoom, focus, photo/video capture |
| Video | RTSP | 8554 | Live H.264/H.265 video stream |

---

## Architecture Components

### 1. Companion Computer: Camera Controller Service

A Python service running on the Raspberry Pi manages the TCP connection to the A8 mini and exposes a WebSocket interface for Quiver Hub.

**Responsibilities:**
- Maintain persistent TCP connection to camera (192.168.144.25:37260)
- Send heartbeat packets every 2 seconds to keep connection alive
- Translate JSON commands from WebSocket into binary SDK protocol
- Parse binary responses and forward status updates to Hub
- Handle connection recovery on network interruption

**Data Flow (Control):**

![Camera Control Data Flow](https://private-us-east-1.manuscdn.com/sessionFile/EubhX8eorZmpnfu4bIKC1W/sandbox/TY62bFD1Botdh7S4iMUMwK-images_1769331821182_na1fn_L2hvbWUvdWJ1bnR1L2NhbWVyYV9mZWVkX2RhdGFfZmxvdw.png?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvRXViaFg4ZW9yWm1wbmZ1NGJJS0MxVy9zYW5kYm94L1RZNjJiRkQxQm90ZGg3UzRpTVVNd0staW1hZ2VzXzE3NjkzMzE4MjExODJfbmExZm5fTDJodmJXVXZkV0oxYm5SMUwyTmhiV1Z5WVY5bVpXVmtYMlJoZEdGZlpteHZkdy5wbmciLCJDb25kaXRpb24iOnsiRGF0ZUxlc3NUaGFuIjp7IkFXUzpFcG9jaFRpbWUiOjE3OTg3NjE2MDB9fX1dfQ__&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=VRXYjFsd9ADLaJfWKO9E52Uk4JK~1SFoLXsSDgfU-QXxSCYmjfKZ16cu2F6uSb8GRi3fubCtjul6WaxwvXHHgzT-TQnC4yjDsHITCGKltoJ~FHWVFDeE3TaZOZablPNGFk7fI3a3pZv2FQteT713tUotpFL4FE1KfFTZzhDXbUKggabEQoYHpmXIFHXATSVE3iCB79j1tvX4fkuGyPf2RNRfK~1chtKxlJJbZItKJzzdKMxFU5gpTi6b88kiSRob32GDfmQE8P97Rt7S9VPyiBP-hAPX3In873xFJ3JSijyPw2AigZuDDDq5wCW7sdPI3LGG7lUY5~56oEPQfTsIvg__)

### 2. Companion Computer: RTSP Proxy

Video streaming requires special handling because RTSP cannot traverse NAT directly. The companion computer runs a lightweight proxy that:

1. Connects to the camera's RTSP stream locally
2. Re-encodes or relays the stream to Quiver Hub via WebRTC or HLS

**Option A: WebRTC (Low Latency)**
- Use GStreamer or FFmpeg to decode RTSP and pipe to a WebRTC server
- Sub-second latency, suitable for real-time gimbal control
- Requires STUN/TURN infrastructure

**Option B: HLS/DASH (Simpler)**
- Transcode RTSP to HLS segments
- Upload segments to Quiver Hub storage
- 5-10 second latency, simpler infrastructure
- Better for recording and playback

**Recommended Approach:** Start with HLS for simplicity, add WebRTC later for operators who need real-time control.

### 3. Quiver Hub: Camera Feed Application

The Camera Feed app in Quiver Hub provides the user interface for viewing video and controlling the gimbal.

**UI Components:**
- **Video Player**: HLS.js or WebRTC player for live stream
- **Gimbal Control**: Virtual joystick or click-to-point interface
- **Zoom Controls**: Slider for 1x-6x digital zoom
- **Camera Actions**: Photo capture, video recording toggle
- **Status Panel**: Connection status, gimbal angles, recording state

**Integration with Existing Apps:**
The Camera Feed app follows the same patterns as other Quiver Hub applications:
- Registered in the app catalog with icon and description
- Uses WebSocket for real-time communication (like point cloud viewer)
- Stores captured photos/videos in S3 (like file management)
- Logs events to telemetry database (like flight telemetry)

---

## SDK Protocol Implementation

### Frame Format

All SDK commands use a binary frame format with little-endian byte ordering:

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 2 | STX | Start marker: 0x55 0x66 |
| 2 | 1 | CTRL | 0=need ACK, 1=is ACK |
| 3 | 2 | DATA_LEN | Payload length |
| 5 | 2 | SEQ | Sequence number (0-65535) |
| 7 | 1 | CMD_ID | Command identifier |
| 8 | N | DATA | Command payload |
| 8+N | 2 | CRC16 | Checksum |

### Essential Commands

The Camera Feed application requires these SDK commands:

| CMD_ID | Name | Purpose |
|--------|------|---------|
| 0x00 | Heartbeat | Keep connection alive |
| 0x07 | Gimbal Rotation | Pan/tilt velocity control |
| 0x0E | Set Gimbal Angles | Absolute position control |
| 0x0D | Get Gimbal Attitude | Current yaw/pitch/roll |
| 0x05 | Manual Zoom | Zoom in/out |
| 0x0C | Capture/Record | Take photo or start/stop video |
| 0x0A | Camera Status | HDR state, recording state |

### Python Implementation Sketch

```python
import socket
import struct
from dataclasses import dataclass

CAMERA_IP = "192.168.144.25"
CAMERA_PORT = 37260

@dataclass
class SIYIFrame:
    cmd_id: int
    data: bytes
    seq: int = 0
    need_ack: bool = False
    
    def encode(self) -> bytes:
        ctrl = 0 if self.need_ack else 1
        data_len = len(self.data)
        header = struct.pack('<HBHHB', 
            0x6655,      # STX (little-endian)
            ctrl,        # CTRL
            data_len,    # DATA_LEN
            self.seq,    # SEQ
            self.cmd_id  # CMD_ID
        )
        frame = header + self.data
        crc = crc16(frame)
        return frame + struct.pack('<H', crc)

class SIYIController:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.seq = 0
        
    def connect(self):
        self.sock.connect((CAMERA_IP, CAMERA_PORT))
        
    def send_heartbeat(self):
        frame = SIYIFrame(cmd_id=0x00, data=b'')
        self.sock.send(frame.encode())
        
    def rotate_gimbal(self, yaw_speed: int, pitch_speed: int):
        """Velocity control: -100 to +100 for each axis"""
        data = struct.pack('<bb', yaw_speed, pitch_speed)
        frame = SIYIFrame(cmd_id=0x07, data=data)
        self.sock.send(frame.encode())
        
    def set_gimbal_angles(self, yaw: float, pitch: float):
        """Absolute position: yaw ±135°, pitch -90° to +25°"""
        yaw_int = int(yaw * 10)    # Protocol uses 0.1° units
        pitch_int = int(pitch * 10)
        data = struct.pack('<hh', yaw_int, pitch_int)
        frame = SIYIFrame(cmd_id=0x0E, data=data)
        self.sock.send(frame.encode())
        
    def capture_photo(self):
        data = struct.pack('<B', 0)  # 0 = capture photo
        frame = SIYIFrame(cmd_id=0x0C, data=data)
        self.sock.send(frame.encode())
        
    def start_recording(self):
        data = struct.pack('<B', 2)  # 2 = start recording
        frame = SIYIFrame(cmd_id=0x0C, data=data)
        self.sock.send(frame.encode())
        
    def stop_recording(self):
        data = struct.pack('<B', 2)  # Toggle - send again to stop
        frame = SIYIFrame(cmd_id=0x0C, data=data)
        self.sock.send(frame.encode())
```

---

## Video Streaming Pipeline

### RTSP Source

The A8 mini provides two RTSP streams:

| Stream | URL | Resolution | Use Case |
|--------|-----|------------|----------|
| Main | rtsp://192.168.144.25:8554/video1 | 4K (3840x2160) | Recording, detailed inspection |
| Sub | rtsp://192.168.144.25:8554/video2 | 720p | Real-time monitoring, lower bandwidth |

### HLS Transcoding (Recommended Initial Approach)

The companion computer runs FFmpeg to convert RTSP to HLS:

```bash
ffmpeg -i rtsp://192.168.144.25:8554/video2 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -f hls -hls_time 2 -hls_list_size 3 -hls_flags delete_segments \
  /tmp/camera/stream.m3u8
```

A simple HTTP server exposes the HLS segments, which the companion's WebSocket bridge uploads to Quiver Hub or serves directly if the operator is on the same network.

### Integration with Camera Feed App

The Camera Feed application in Quiver Hub uses HLS.js to play the stream:

```typescript
// In CameraFeedApp.tsx
import Hls from 'hls.js';

function VideoPlayer({ streamUrl }: { streamUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    if (Hls.isSupported() && videoRef.current) {
      const hls = new Hls();
      hls.loadSource(streamUrl);
      hls.attachMedia(videoRef.current);
    }
  }, [streamUrl]);
  
  return <video ref={videoRef} autoPlay muted />;
}
```

---

## User Interface Design

### Camera Feed App Layout

![Camera Feed UI Mockup](https://private-us-east-1.manuscdn.com/sessionFile/EubhX8eorZmpnfu4bIKC1W/sandbox/TY62bFD1Botdh7S4iMUMwK-images_1769331821183_na1fn_L2hvbWUvdWJ1bnR1L2NhbWVyYV9mZWVkX3VpX21vY2t1cA.png?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvRXViaFg4ZW9yWm1wbmZ1NGJJS0MxVy9zYW5kYm94L1RZNjJiRkQxQm90ZGg3UzRpTVVNd0staW1hZ2VzXzE3NjkzMzE4MjExODNfbmExZm5fTDJodmJXVXZkV0oxYm5SMUwyTmhiV1Z5WVY5bVpXVmtYM1ZwWDIxdlkydDFjQS5wbmciLCJDb25kaXRpb24iOnsiRGF0ZUxlc3NUaGFuIjp7IkFXUzpFcG9jaFRpbWUiOjE3OTg3NjE2MDB9fX1dfQ__&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=W4CXEEBdow9gs8wCWczzXgKXXKnFdDS6FZ4ZmxybkW76ZwVOeM6rsGF66OQbHrGSGC0PqUn8slparUVWPUIrpoF-qoysUwcJ8fRoEU5zR5DQFtfwFkpkGY2XCRHKdRuMAJDlFz6QrL9exxUGD5rBWeNLgwu7yOk0xzeM9QeeVXWgfomlYGKOarYbxg2CX4T6sFHVzELDeFUpRDf3uvRJxWQSv4ZOMqbcEbXmjD1opM4DXYOkWlCs4Zsh3zRlzADATQS8APv8aAwpAHDaB3HcSvfWHRLacJPMP1cZbTwSUx~Akz~QWYNeWKz0iPhQM4QKwXN8ecW~IRwN1GBN9C6d~A__)

### Control Interactions

| Control | Action | SDK Command |
|---------|--------|-------------|
| Gimbal arrows | Hold to rotate at constant speed | 0x07 (velocity) |
| Click on video | Point camera at clicked location | 0x0E (absolute) |
| Center button | Return to forward-facing | 0x08 (center_pos=1) |
| Nadir button | Point straight down | 0x08 (center_pos=4) |
| Zoom slider | Adjust digital zoom 1x-6x | 0x05 |
| Photo button | Capture still image | 0x0C (func_type=0) |
| Record button | Toggle video recording | 0x0C (func_type=2) |

---

## Data Flow Summary

### Command Path (Hub → Camera)

1. User clicks gimbal control in Camera Feed app
2. React component sends WebSocket message to Quiver Hub server
3. Hub server forwards command to companion computer via existing drone WebSocket
4. Companion's camera controller service receives JSON command
5. Service encodes command as SIYI binary protocol
6. TCP packet sent to camera at 192.168.144.25:37260
7. Camera executes command and sends ACK
8. Status update flows back through same path

### Video Path (Camera → Hub)

1. Camera streams H.264 video via RTSP on port 8554
2. Companion computer's FFmpeg process transcodes to HLS
3. HLS segments uploaded to Quiver Hub storage (or served locally)
4. Camera Feed app fetches playlist and plays segments
5. ~5 second latency (acceptable for monitoring, not for precision control)

---

## Implementation Phases

### Phase 1: Basic Control (Week 1)

- Implement SIYI protocol encoder/decoder in Python
- Create camera controller service on companion
- Add WebSocket command routing for camera
- Build minimal Camera Feed UI with gimbal controls
- Test with physical A8 mini camera

### Phase 2: Video Streaming (Week 2)

- Set up FFmpeg RTSP→HLS pipeline on companion
- Implement HLS segment upload to Hub storage
- Integrate HLS.js player in Camera Feed app
- Add stream quality selector (main vs sub)

### Phase 3: Full Features (Week 3)

- Photo capture with S3 storage and gallery view
- Video recording status and file management
- Gimbal angle telemetry logging
- Click-to-point camera control
- Connection status and error handling

### Phase 4: Polish (Week 4)

- Keyboard shortcuts for gimbal control
- Gamepad/joystick support
- Picture-in-picture mode
- Integration with mission planning (waypoint camera actions)

---

## References

1. SIYI Gimbal Camera External SDK Protocol Document V0.1.1
2. SIYI A8 mini User Manual v1.10
3. Quiver Hub existing WebSocket architecture (telemetry_forwarder.py)
4. Quiver Hub point cloud visualization patterns (LidarApp.tsx)
