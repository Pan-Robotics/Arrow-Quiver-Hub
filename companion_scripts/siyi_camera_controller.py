#!/usr/bin/env python3
"""
SIYI A8 Mini Gimbal Camera Controller

This script provides a Python interface to control the SIYI A8 mini gimbal camera
via its TCP SDK protocol. It handles:
- Gimbal rotation (velocity and absolute position)
- Zoom control
- Photo capture and video recording
- Camera status monitoring
- Socket.IO bridge for Quiver Hub integration

Protocol Reference: SIYI Gimbal Camera External SDK Protocol V0.1.1

Dependencies:
    pip install 'python-socketio[asyncio_client]' aiohttp

Usage:
    python siyi_camera_controller.py --hub-url https://your-quiver-hub.com --drone-id quiver_001 --api-key YOUR_KEY
"""

import asyncio
import socket
import struct
import time
import json
import argparse
import logging
import signal
from typing import Optional, Tuple, Callable
from dataclasses import dataclass
from enum import IntEnum

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('siyi_camera')

# ============================================================================
# SIYI Protocol Constants
# ============================================================================

SIYI_CAMERA_IP = "192.168.144.25"
SIYI_SDK_PORT = 37260
SIYI_RTSP_PORT = 8554

# Frame markers
STX_LOW = 0x55
STX_HIGH = 0x66

# Control byte values
CTRL_NEED_ACK = 0x00
CTRL_ACK_PACK = 0x01

# Command IDs
class CmdId(IntEnum):
    HEARTBEAT = 0x00
    FIRMWARE_VERSION = 0x01
    AUTO_FOCUS = 0x04
    MANUAL_ZOOM = 0x05
    MANUAL_FOCUS = 0x06
    GIMBAL_ROTATION = 0x07  # Velocity mode
    CENTER_GIMBAL = 0x08
    CAMERA_INFO = 0x0A
    FUNCTION_FEEDBACK = 0x0B
    PHOTO_VIDEO = 0x0C
    GIMBAL_ATTITUDE = 0x0D
    SET_GIMBAL_ANGLES = 0x0E
    ABSOLUTE_ZOOM = 0x0F

# Photo/Video function types
class FuncType(IntEnum):
    CAPTURE_PHOTO = 0
    TOGGLE_HDR = 1
    START_RECORDING = 2
    LOCK_MODE = 3
    FOLLOW_MODE = 4
    FPV_MODE = 5
    TILT_DOWN = 9

# Center position types
class CenterPos(IntEnum):
    ONE_KEY_CENTER = 1
    CENTER_DOWN = 2
    CENTER = 3
    DOWN = 4


# ============================================================================
# CRC16 Calculation (CCITT)
# ============================================================================

def crc16_ccitt(data: bytes) -> int:
    """Calculate CRC16-CCITT checksum for SIYI protocol."""
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ 0x1021
            else:
                crc <<= 1
            crc &= 0xFFFF
    return crc


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class GimbalAttitude:
    """Gimbal attitude data."""
    yaw: float      # degrees
    pitch: float    # degrees
    roll: float     # degrees
    yaw_velocity: float
    pitch_velocity: float
    roll_velocity: float


@dataclass
class CameraStatus:
    """Camera system status."""
    hdr_enabled: bool
    recording: bool
    tf_card_present: bool


@dataclass
class FirmwareVersion:
    """Firmware version information."""
    camera: str
    gimbal: str
    zoom: str


# ============================================================================
# SIYI Camera Controller
# ============================================================================

class SIYICameraController:
    """
    Controller for SIYI A8 mini gimbal camera.
    
    Handles TCP communication with the camera using the SIYI SDK protocol.
    All commands are sent as binary frames with CRC16 checksums.
    """
    
    def __init__(self, ip: str = SIYI_CAMERA_IP, port: int = SIYI_SDK_PORT):
        self.ip = ip
        self.port = port
        self.socket: Optional[socket.socket] = None
        self.sequence = 0
        self.connected = False
        self.last_attitude: Optional[GimbalAttitude] = None
        self.last_status: Optional[CameraStatus] = None
        self._lock = asyncio.Lock()
        
    def _next_sequence(self) -> int:
        """Get next sequence number (0-65535)."""
        seq = self.sequence
        self.sequence = (self.sequence + 1) % 65536
        return seq
    
    def _build_frame(self, cmd_id: int, data: bytes = b'', need_ack: bool = True) -> bytes:
        """
        Build a SIYI protocol frame.
        
        Frame structure:
        - STX (2 bytes): 0x55 0x66
        - CTRL (1 byte): 0x00 (need_ack) or 0x01 (ack_pack)
        - Data_len (2 bytes): little-endian
        - SEQ (2 bytes): little-endian
        - CMD_ID (1 byte)
        - DATA (variable)
        - CRC16 (2 bytes): little-endian
        """
        ctrl = CTRL_NEED_ACK if need_ack else CTRL_ACK_PACK
        data_len = len(data)
        seq = self._next_sequence()
        
        # STX (2) + CTRL (1) + Data_len (2) + SEQ (2) + CMD_ID (1) = 8 bytes header
        frame = bytes([STX_LOW, STX_HIGH, ctrl]) + \
                struct.pack('<H', data_len) + \
                struct.pack('<H', seq) + \
                bytes([cmd_id]) + \
                data
        
        # Calculate CRC16 over entire frame (excluding CRC itself)
        crc = crc16_ccitt(frame)
        frame += struct.pack('<H', crc)
        
        return frame
    
    def _parse_response(self, data: bytes) -> Tuple[int, bytes]:
        """
        Parse a SIYI protocol response frame.
        
        Returns:
            Tuple of (cmd_id, payload_data)
        """
        if len(data) < 10:  # Minimum frame size
            raise ValueError(f"Response too short: {len(data)} bytes")
        
        # Verify STX
        if data[0] != STX_LOW or data[1] != STX_HIGH:
            raise ValueError(f"Invalid STX: {data[0]:02x} {data[1]:02x}")
        
        # Parse header
        ctrl = data[2]
        data_len = struct.unpack('<H', data[3:5])[0]
        seq = struct.unpack('<H', data[5:7])[0]
        cmd_id = data[7]
        
        # Extract payload
        payload = data[8:8+data_len]
        
        # Verify CRC
        received_crc = struct.unpack('<H', data[8+data_len:10+data_len])[0]
        calculated_crc = crc16_ccitt(data[:8+data_len])
        
        if received_crc != calculated_crc:
            logger.warning(f"CRC mismatch: received {received_crc:04x}, calculated {calculated_crc:04x}")
        
        return cmd_id, payload
    
    async def connect(self) -> bool:
        """Connect to the camera."""
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(5.0)
            self.socket.connect((self.ip, self.port))
            self.socket.setblocking(False)
            self.connected = True
            logger.info(f"Connected to SIYI camera at {self.ip}:{self.port}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to camera: {e}")
            self.connected = False
            return False
    
    async def disconnect(self):
        """Disconnect from the camera."""
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        self.connected = False
        logger.info("Disconnected from camera")
    
    async def _send_command(self, cmd_id: int, data: bytes = b'', 
                           expect_response: bool = True, timeout: float = 2.0) -> Optional[bytes]:
        """Send a command and optionally wait for response."""
        if not self.connected or not self.socket:
            logger.error("Not connected to camera")
            return None
        
        async with self._lock:
            try:
                frame = self._build_frame(cmd_id, data)
                
                # Send command
                loop = asyncio.get_event_loop()
                await loop.sock_sendall(self.socket, frame)
                
                if not expect_response:
                    return b''
                
                # Wait for response
                self.socket.settimeout(timeout)
                response = await loop.sock_recv(self.socket, 256)
                self.socket.setblocking(False)
                
                if response:
                    _, payload = self._parse_response(response)
                    return payload
                    
            except asyncio.TimeoutError:
                logger.warning(f"Timeout waiting for response to command {cmd_id:02x}")
            except Exception as e:
                logger.error(f"Error sending command {cmd_id:02x}: {e}")
                
        return None
    
    # ========================================================================
    # High-Level Camera Control Methods
    # ========================================================================
    
    async def send_heartbeat(self) -> bool:
        """Send heartbeat packet to keep connection alive."""
        heartbeat = bytes([0x55, 0x66, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x59, 0x8B])
        if self.socket:
            try:
                loop = asyncio.get_event_loop()
                await loop.sock_sendall(self.socket, heartbeat)
                return True
            except Exception as e:
                logger.error(f"Heartbeat failed: {e}")
        return False
    
    async def get_firmware_version(self) -> Optional[FirmwareVersion]:
        """Request firmware version information."""
        response = await self._send_command(CmdId.FIRMWARE_VERSION)
        if response and len(response) >= 12:
            camera_ver = struct.unpack('<I', response[0:4])[0]
            gimbal_ver = struct.unpack('<I', response[4:8])[0]
            zoom_ver = struct.unpack('<I', response[8:12])[0]
            
            def format_version(v: int) -> str:
                return f"{(v >> 16) & 0xFF}.{(v >> 8) & 0xFF}.{v & 0xFF}"
            
            return FirmwareVersion(
                camera=format_version(camera_ver),
                gimbal=format_version(gimbal_ver),
                zoom=format_version(zoom_ver)
            )
        return None
    
    async def get_gimbal_attitude(self) -> Optional[GimbalAttitude]:
        """Request current gimbal attitude."""
        response = await self._send_command(CmdId.GIMBAL_ATTITUDE)
        if response and len(response) >= 12:
            yaw, pitch, roll = struct.unpack('<hhh', response[0:6])
            yaw_vel, pitch_vel, roll_vel = struct.unpack('<hhh', response[6:12])
            
            attitude = GimbalAttitude(
                yaw=yaw / 10.0,
                pitch=pitch / 10.0,
                roll=roll / 10.0,
                yaw_velocity=yaw_vel / 10.0,
                pitch_velocity=pitch_vel / 10.0,
                roll_velocity=roll_vel / 10.0
            )
            self.last_attitude = attitude
            return attitude
        return None
    
    async def get_camera_status(self) -> Optional[CameraStatus]:
        """Request camera system information."""
        response = await self._send_command(CmdId.CAMERA_INFO)
        if response and len(response) >= 2:
            hdr_sta = response[0]
            record_sta = response[1]
            
            status = CameraStatus(
                hdr_enabled=(hdr_sta == 1),
                recording=(record_sta == 1),
                tf_card_present=(record_sta != 2)
            )
            self.last_status = status
            return status
        return None
    
    async def rotate_gimbal(self, yaw_speed: int, pitch_speed: int) -> bool:
        """
        Rotate gimbal at specified velocity.
        
        Args:
            yaw_speed: -100 to 100 (negative = left, positive = right)
            pitch_speed: -100 to 100 (negative = down, positive = up)
        
        Send (0, 0) to stop rotation.
        """
        yaw_speed = max(-100, min(100, yaw_speed))
        pitch_speed = max(-100, min(100, pitch_speed))
        
        data = struct.pack('<bb', yaw_speed, pitch_speed)
        response = await self._send_command(CmdId.GIMBAL_ROTATION, data)
        
        if response and len(response) >= 1:
            return response[0] == 1
        return False
    
    async def set_gimbal_angles(self, yaw: float, pitch: float) -> Optional[GimbalAttitude]:
        """
        Set gimbal to absolute angles.
        
        Args:
            yaw: Target yaw angle (-135.0 to 135.0 degrees)
            pitch: Target pitch angle (-90.0 to 25.0 degrees)
        """
        yaw = max(-135.0, min(135.0, yaw))
        pitch = max(-90.0, min(25.0, pitch))
        
        yaw_int = int(yaw * 10)
        pitch_int = int(pitch * 10)
        
        data = struct.pack('<hh', yaw_int, pitch_int)
        response = await self._send_command(CmdId.SET_GIMBAL_ANGLES, data)
        
        if response and len(response) >= 6:
            yaw_r, pitch_r, roll_r = struct.unpack('<hhh', response[0:6])
            return GimbalAttitude(
                yaw=yaw_r / 10.0,
                pitch=pitch_r / 10.0,
                roll=roll_r / 10.0,
                yaw_velocity=0, pitch_velocity=0, roll_velocity=0
            )
        return None
    
    async def center_gimbal(self, mode: CenterPos = CenterPos.ONE_KEY_CENTER) -> bool:
        """Center the gimbal."""
        data = bytes([mode])
        response = await self._send_command(CmdId.CENTER_GIMBAL, data)
        if response and len(response) >= 1:
            return response[0] == 1
        return False
    
    async def nadir_gimbal(self) -> bool:
        """Point gimbal straight down (nadir)."""
        return await self.center_gimbal(CenterPos.DOWN)
    
    async def zoom(self, direction: int) -> Optional[float]:
        """
        Manual zoom with autofocus.
        
        Args:
            direction: 1 = zoom in, 0 = stop, -1 = zoom out
        """
        direction = max(-1, min(1, direction))
        data = struct.pack('<b', direction)
        response = await self._send_command(CmdId.MANUAL_ZOOM, data)
        
        if response and len(response) >= 2:
            zoom_level = struct.unpack('<H', response[0:2])[0]
            return zoom_level / 10.0
        return None
    
    async def set_zoom(self, level: float) -> bool:
        """
        Set absolute zoom level.
        
        Args:
            level: Zoom level 1.0 to 6.0 (A8 mini max is 6x digital)
        """
        level = max(1.0, min(6.0, level))
        integer_part = int(level)
        decimal_part = int((level - integer_part) * 10)
        
        data = bytes([integer_part, decimal_part])
        response = await self._send_command(CmdId.ABSOLUTE_ZOOM, data)
        return response is not None
    
    async def capture_photo(self) -> bool:
        """Capture a photo."""
        data = bytes([FuncType.CAPTURE_PHOTO])
        await self._send_command(CmdId.PHOTO_VIDEO, data, expect_response=False)
        logger.info("Photo capture command sent")
        return True
    
    async def start_recording(self) -> bool:
        """Start video recording."""
        data = bytes([FuncType.START_RECORDING])
        await self._send_command(CmdId.PHOTO_VIDEO, data, expect_response=False)
        logger.info("Start recording command sent")
        return True
    
    async def stop_recording(self) -> bool:
        """Stop video recording (same command toggles)."""
        return await self.start_recording()
    
    async def auto_focus(self, x: int = 0, y: int = 0) -> bool:
        """
        Trigger auto focus.
        
        Args:
            x, y: Touch coordinates for focus point (0-1000 range)
        """
        data = struct.pack('<BHH', 1, x, y)
        response = await self._send_command(CmdId.AUTO_FOCUS, data)
        if response and len(response) >= 1:
            return response[0] == 1
        return False


# ============================================================================
# Socket.IO Bridge for Quiver Hub
# ============================================================================

class CameraWebSocketBridge:
    """
    Socket.IO bridge connecting SIYI camera to Quiver Hub.
    
    The Hub server uses Socket.IO (not raw WebSocket), so this bridge uses
    python-socketio's async client to communicate. It:
    
    1. Connects to the Hub via Socket.IO
    2. Emits 'register_companion' to join the companion room for this drone
    3. Listens for 'camera_command' events from the frontend
    4. Forwards commands to the SIYI camera via TCP SDK
    5. Emits 'camera_status' updates at 2 Hz
    6. Emits 'camera_response' after each command execution
    
    The Hub's Socket.IO server listens on /socket.io/ (the default path).
    Authentication is passed as a query parameter since Socket.IO doesn't
    support custom headers on the initial handshake in all transports.
    """
    
    def __init__(self, hub_url: str, drone_id: str, api_key: str):
        self.hub_url = hub_url
        self.drone_id = drone_id
        self.api_key = api_key
        self.camera = SIYICameraController()
        self.running = False
        self.sio = None
        self._connected_to_hub = False
        
    async def connect_camera(self) -> bool:
        """Connect to the SIYI camera."""
        return await self.camera.connect()
    
    async def handle_command(self, command: dict) -> dict:
        """
        Handle a command from Quiver Hub.
        
        Command format:
        {
            "type": "camera_command",
            "droneId": "quiver_001",
            "action": "rotate" | "center" | "nadir" | "zoom" | ...,
            "params": { ... }
        }
        """
        action = command.get('action', '')
        params = command.get('params', {})
        result = {"success": False, "action": action}
        
        try:
            if action == 'rotate':
                yaw = params.get('yaw', 0)
                pitch = params.get('pitch', 0)
                success = await self.camera.rotate_gimbal(yaw, pitch)
                result["success"] = success
                
            elif action == 'set_angles':
                yaw = params.get('yaw', 0)
                pitch = params.get('pitch', 0)
                attitude = await self.camera.set_gimbal_angles(yaw, pitch)
                if attitude:
                    result["success"] = True
                    result["attitude"] = {
                        "yaw": attitude.yaw,
                        "pitch": attitude.pitch,
                        "roll": attitude.roll
                    }
                    
            elif action == 'center':
                result["success"] = await self.camera.center_gimbal()
                
            elif action == 'nadir':
                result["success"] = await self.camera.nadir_gimbal()
                
            elif action == 'zoom':
                direction = params.get('direction', 0)
                zoom_level = await self.camera.zoom(direction)
                if zoom_level is not None:
                    result["success"] = True
                    result["zoom_level"] = zoom_level
                    
            elif action == 'set_zoom':
                level = params.get('level', 1.0)
                result["success"] = await self.camera.set_zoom(level)
                
            elif action == 'photo':
                result["success"] = await self.camera.capture_photo()
                
            elif action == 'record':
                result["success"] = await self.camera.start_recording()
                
            elif action == 'stop_record':
                result["success"] = await self.camera.stop_recording()
                
            elif action == 'focus':
                x = params.get('x', 0)
                y = params.get('y', 0)
                result["success"] = await self.camera.auto_focus(x, y)
                
            elif action == 'get_status':
                attitude = await self.camera.get_gimbal_attitude()
                status = await self.camera.get_camera_status()
                result["success"] = True
                if attitude:
                    result["attitude"] = {
                        "yaw": attitude.yaw,
                        "pitch": attitude.pitch,
                        "roll": attitude.roll
                    }
                if status:
                    result["status"] = {
                        "recording": status.recording,
                        "hdr_enabled": status.hdr_enabled,
                        "tf_card_present": status.tf_card_present
                    }
            else:
                result["error"] = f"Unknown action: {action}"
                
        except Exception as e:
            result["error"] = str(e)
            logger.error(f"Error handling command {action}: {e}")
            
        return result
    
    def _get_hub_http_url(self) -> str:
        """
        Convert the hub_url to an HTTP(S) URL for Socket.IO connection.
        
        Socket.IO connects over HTTP(S), not WS. The library handles
        the upgrade to WebSocket transport internally.
        """
        url = self.hub_url
        url = url.replace("wss://", "https://").replace("ws://", "http://")
        # Strip any path suffixes — socketio client adds /socket.io/ itself
        for suffix in ["/ws", "/socket.io/", "/socket.io"]:
            if url.endswith(suffix):
                url = url[:-len(suffix)]
        url = url.rstrip("/")
        return url
    
    async def run(self):
        """Main loop connecting to Quiver Hub via Socket.IO and handling commands."""
        try:
            import socketio
        except ImportError:
            logger.error(
                "python-socketio package not installed. Run:\n"
                "  pip install 'python-socketio[asyncio_client]' aiohttp"
            )
            return
        
        self.running = True
        
        while self.running:
            try:
                # Connect to camera first
                if not self.camera.connected:
                    logger.info("Connecting to SIYI camera...")
                    if not await self.connect_camera():
                        logger.warning("Camera connection failed, retrying in 5s...")
                        await asyncio.sleep(5)
                        continue
                
                # Create Socket.IO async client
                self.sio = socketio.AsyncClient(
                    reconnection=False,  # We handle reconnection in the outer loop
                    logger=False,
                    engineio_logger=False,
                )
                
                hub_url = self._get_hub_http_url()
                logger.info(f"Connecting to Quiver Hub via Socket.IO: {hub_url}")
                
                # ---- Register event handlers ----
                
                @self.sio.event
                async def connect():
                    logger.info("Connected to Quiver Hub (Socket.IO)")
                    self._connected_to_hub = True
                    # Register as companion computer for this drone
                    await self.sio.emit('register_companion', {
                        'droneId': self.drone_id,
                        'type': 'camera'
                    })
                    logger.info(f"Registered as camera companion for drone: {self.drone_id}")
                
                @self.sio.event
                async def disconnect():
                    logger.warning("Disconnected from Quiver Hub")
                    self._connected_to_hub = False
                
                @self.sio.event
                async def connect_error(data):
                    logger.error(f"Socket.IO connection error: {data}")
                    self._connected_to_hub = False
                
                @self.sio.on('camera_command')
                async def on_camera_command(data):
                    """Handle camera command from frontend via Hub."""
                    logger.info(f"Received camera command: {data.get('action', 'unknown')}")
                    result = await self.handle_command(data)
                    # Send response back to Hub for frontend
                    await self.sio.emit('camera_response', {
                        'type': 'camera_response',
                        'droneId': self.drone_id,
                        **result
                    })
                
                # ---- Connect ----
                # Socket.IO handles the HTTP -> WebSocket upgrade internally.
                # We use transports=['websocket'] to skip long-polling and go
                # straight to WebSocket for lower latency.
                await self.sio.connect(
                    hub_url,
                    transports=['websocket'],
                )
                
                # Start background tasks for heartbeat and status updates
                heartbeat_task = asyncio.create_task(self._heartbeat_loop())
                status_task = asyncio.create_task(self._status_update_loop())
                
                try:
                    # Block until disconnected or stopped
                    await self.sio.wait()
                finally:
                    heartbeat_task.cancel()
                    status_task.cancel()
                    try:
                        await heartbeat_task
                    except asyncio.CancelledError:
                        pass
                    try:
                        await status_task
                    except asyncio.CancelledError:
                        pass
                    
            except Exception as e:
                logger.error(f"Socket.IO error: {e}")
                self._connected_to_hub = False
                if self.sio and self.sio.connected:
                    try:
                        await self.sio.disconnect()
                    except:
                        pass
                await asyncio.sleep(5)
    
    async def _heartbeat_loop(self):
        """Send heartbeat to camera periodically."""
        while self.running:
            try:
                await self.camera.send_heartbeat()
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Heartbeat error: {e}")
    
    async def _status_update_loop(self):
        """Send status updates to Quiver Hub periodically at 2 Hz."""
        while self.running:
            try:
                if self._connected_to_hub and self.sio and self.sio.connected:
                    await self._send_status_update()
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Status update error: {e}")
    
    async def _send_status_update(self):
        """Send current camera status to Quiver Hub via Socket.IO."""
        if not self.sio or not self.sio.connected:
            return
            
        try:
            attitude = await self.camera.get_gimbal_attitude()
            status = await self.camera.get_camera_status()
            
            update = {
                "type": "camera_status",
                "drone_id": self.drone_id,
                "connected": self.camera.connected,
                "timestamp": time.time()
            }
            
            if attitude:
                update["attitude"] = {
                    "yaw": attitude.yaw,
                    "pitch": attitude.pitch,
                    "roll": attitude.roll
                }
            
            if status:
                update["recording"] = status.recording
                update["hdr_enabled"] = status.hdr_enabled
                update["tf_card_present"] = status.tf_card_present
            
            await self.sio.emit('camera_status', update)
            
        except Exception as e:
            logger.error(f"Failed to send status update: {e}")
    
    def stop(self):
        """Stop the bridge."""
        self.running = False


# ============================================================================
# Main Entry Point
# ============================================================================

async def main():
    parser = argparse.ArgumentParser(description='SIYI A8 Mini Camera Controller')
    parser.add_argument('--hub-url', type=str, 
                       default='https://localhost:3000',
                       help='Quiver Hub URL (HTTP/HTTPS — Socket.IO handles the upgrade)')
    parser.add_argument('--drone-id', type=str, 
                       default='quiver_001',
                       help='Drone identifier')
    parser.add_argument('--api-key', type=str,
                       default='',
                       help='API key for Quiver Hub authentication')
    parser.add_argument('--test', action='store_true',
                       help='Run in test mode (direct camera control)')
    parser.add_argument('--debug', action='store_true',
                       help='Enable debug logging')
    
    args = parser.parse_args()
    
    if args.debug:
        logging.getLogger('siyi_camera').setLevel(logging.DEBUG)
        logging.getLogger('socketio').setLevel(logging.DEBUG)
        logging.getLogger('engineio').setLevel(logging.DEBUG)
    
    if args.test:
        # Test mode: direct camera control
        logger.info("Running in test mode...")
        camera = SIYICameraController()
        
        if await camera.connect():
            version = await camera.get_firmware_version()
            if version:
                logger.info(f"Firmware - Camera: {version.camera}, Gimbal: {version.gimbal}, Zoom: {version.zoom}")
            
            attitude = await camera.get_gimbal_attitude()
            if attitude:
                logger.info(f"Attitude - Yaw: {attitude.yaw}, Pitch: {attitude.pitch}, Roll: {attitude.roll}")
            
            status = await camera.get_camera_status()
            if status:
                logger.info(f"Status - Recording: {status.recording}, HDR: {status.hdr_enabled}, TF Card: {status.tf_card_present}")
            
            logger.info("Centering gimbal...")
            await camera.center_gimbal()
            await asyncio.sleep(2)
            
            logger.info("Testing rotation...")
            await camera.rotate_gimbal(30, 0)
            await asyncio.sleep(1)
            await camera.rotate_gimbal(0, 0)
            
            await camera.disconnect()
        else:
            logger.error("Failed to connect to camera")
    else:
        # Production mode: Socket.IO bridge
        bridge = CameraWebSocketBridge(
            hub_url=args.hub_url,
            drone_id=args.drone_id,
            api_key=args.api_key
        )
        
        def signal_handler(sig, frame):
            logger.info("Shutdown signal received")
            bridge.stop()
        
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        try:
            await bridge.run()
        except KeyboardInterrupt:
            logger.info("Shutting down...")
            bridge.stop()


if __name__ == '__main__':
    asyncio.run(main())
