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
    python3 -m pip install --break-system-packages 'python-socketio[asyncio_client]' aiohttp

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
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Optional, Tuple
from dataclasses import dataclass
from enum import IntEnum
from companion_config import load_environment


# Resolve .env files before connection constants and CLI defaults are created.
CONFIG = load_environment()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('siyi_camera')

# ============================================================================
# SIYI Protocol Constants
# ============================================================================

SIYI_CAMERA_IP = CONFIG.get("SIYI_CAMERA_IP", "")
SIYI_SDK_PORT = CONFIG.get("SIYI_SDK_PORT", "37260")
SIYI_RTSP_PORT = CONFIG.get("SIYI_RTSP_PORT", "8554")

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
        try:
            self.port = int(port)
        except (ValueError, TypeError):
            raise ValueError('SIYI_SDK_PORT must be an integer from 1 to 65535') from None
        if not 1 <= self.port <= 65535:
            raise ValueError('SIYI_SDK_PORT must be from 1 to 65535')
        self.socket: Optional[socket.socket] = None
        self.sequence = 0
        self.connected = False
        self.last_attitude: Optional[GimbalAttitude] = None
        self.last_status: Optional[CameraStatus] = None
        self._lock = asyncio.Lock()
        self._receive_buffer = bytearray()
        
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
    
    def _parse_response_details(self, data: bytes) -> Tuple[int, bytes, int]:
        """
        Parse one complete SIYI protocol response frame.
        
        The hardware protocol documentation contains conflicting examples for
        the CTRL byte.  Accept both documented values here, but do not change
        the outgoing command convention without a captured hardware exchange.
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
        expected_length = 10 + data_len
        if len(data) != expected_length:
            raise ValueError(f"Invalid response length: expected {expected_length}, got {len(data)}")
        if ctrl not in (CTRL_NEED_ACK, CTRL_ACK_PACK):
            raise ValueError(f"Invalid response CTRL byte: {ctrl:02x}")
        
        # Extract payload
        payload = data[8:8+data_len]
        
        # Verify CRC
        received_crc = struct.unpack('<H', data[8+data_len:10+data_len])[0]
        calculated_crc = crc16_ccitt(data[:8+data_len])
        
        if received_crc != calculated_crc:
            raise ValueError(f"CRC mismatch: received {received_crc:04x}, calculated {calculated_crc:04x}")
        
        return cmd_id, payload, seq

    def _parse_response(self, data: bytes) -> Tuple[int, bytes]:
        """Parse one complete response, retaining the legacy two-value API."""
        cmd_id, payload, _ = self._parse_response_details(data)
        return cmd_id, payload

    def _take_next_frame(self) -> Optional[bytes]:
        """Extract one length-delimited TCP frame from the accumulated buffer."""
        marker = bytes([STX_LOW, STX_HIGH])
        marker_index = self._receive_buffer.find(marker)
        if marker_index < 0:
            # Keep a trailing STX_LOW in case the marker spans recv calls.
            self._receive_buffer[:] = self._receive_buffer[-1:] if self._receive_buffer[-1:] == marker[:1] else b''
            return None
        if marker_index:
            del self._receive_buffer[:marker_index]
        if len(self._receive_buffer) < 8:
            return None
        data_len = struct.unpack('<H', self._receive_buffer[3:5])[0]
        frame_length = 10 + data_len
        if len(self._receive_buffer) < frame_length:
            return None
        frame = bytes(self._receive_buffer[:frame_length])
        del self._receive_buffer[:frame_length]
        return frame

    async def _receive_response(self, expected_cmd_id: int, expected_sequence: int) -> bytes:
        """Read complete frames until the matching response arrives.

        TCP may fragment/coalesce frames.  Invalid frames and unsolicited
        function feedback are discarded rather than being mistaken for the
        response to the current serialized command.
        """
        if not self.socket:
            raise ConnectionError("camera socket is unavailable")
        loop = asyncio.get_running_loop()
        while True:
            frame = self._take_next_frame()
            if frame is None:
                received = await loop.sock_recv(self.socket, 4096)
                if not received:
                    raise ConnectionError("SIYI camera closed the TCP connection")
                self._receive_buffer.extend(received)
                continue
            try:
                cmd_id, payload, sequence = self._parse_response_details(frame)
            except ValueError as error:
                logger.warning("Discarding invalid SIYI response frame: %s", error)
                continue
            if cmd_id == CmdId.FUNCTION_FEEDBACK:
                logger.debug("Received unsolicited SIYI function feedback: %s", payload.hex())
                continue
            if cmd_id != expected_cmd_id or sequence != expected_sequence:
                logger.debug(
                    "Discarding unmatched SIYI response cmd=%02x seq=%s while awaiting cmd=%02x seq=%s",
                    cmd_id, sequence, expected_cmd_id, expected_sequence,
                )
                continue
            return payload

    def _clear_connection(self) -> None:
        """Close a failed socket and clear transport state without awaiting."""
        if self.socket:
            try:
                self.socket.close()
            except OSError:
                pass
        self.socket = None
        self.connected = False
        self._receive_buffer.clear()
    
    async def connect(self) -> bool:
        """Connect to the camera."""
        try:
            self._clear_connection()
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.setblocking(False)
            loop = asyncio.get_running_loop()
            await asyncio.wait_for(loop.sock_connect(self.socket, (self.ip, self.port)), timeout=5.0)
            self.connected = True
            logger.info(f"Connected to SIYI camera at {self.ip}:{self.port}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to camera: {e}")
            self._clear_connection()
            return False
    
    async def stop_motion(self, timeout: float = 0.5) -> bool:
        """Attempt the protocol-required zero-velocity command within a bound."""
        if not self.connected:
            return False
        try:
            return await asyncio.wait_for(self.rotate_gimbal(0, 0), timeout=timeout)
        except (asyncio.TimeoutError, OSError, ConnectionError) as error:
            logger.warning("Best-effort gimbal stop failed: %s", error)
            return False

    async def disconnect(self, stop_motion: bool = True):
        """Best-effort stop gimbal motion, then close the nonblocking TCP socket."""
        if stop_motion:
            await self.stop_motion()
        self._clear_connection()
        logger.info("Disconnected from camera")
    
    async def _send_command(self, cmd_id: int, data: bytes = b'', 
                           expect_response: bool = True, timeout: float = 2.0) -> Optional[bytes]:
        """Send a command and optionally wait for response."""
        if not self.connected or not self.socket:
            logger.error("Not connected to camera")
            return None
        
        async with self._lock:
            try:
                if not self.socket:
                    return None
                sequence = self.sequence
                frame = self._build_frame(cmd_id, data)
                
                # Send command
                loop = asyncio.get_running_loop()
                await loop.sock_sendall(self.socket, frame)
                
                if not expect_response:
                    return b''
                
                return await asyncio.wait_for(
                    self._receive_response(cmd_id, sequence), timeout=timeout
                )
            except asyncio.TimeoutError:
                logger.warning(f"Timeout waiting for response to command {cmd_id:02x}")
            except (OSError, ConnectionError) as e:
                logger.error(f"Error sending command {cmd_id:02x}: {e}")
                self._clear_connection()
            except Exception as e:
                logger.error(f"Error sending command {cmd_id:02x}: {e}")
                
        return None
    
    # ========================================================================
    # High-Level Camera Control Methods
    # ========================================================================
    
    async def send_heartbeat(self) -> bool:
        """Send heartbeat packet to keep connection alive."""
        heartbeat = bytes([0x55, 0x66, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x59, 0x8B])
        if self.socket and self.connected:
            try:
                loop = asyncio.get_running_loop()
                async with self._lock:
                    if not self.socket:
                        return False
                    await loop.sock_sendall(self.socket, heartbeat)
                return True
            except (OSError, ConnectionError) as e:
                logger.error(f"Heartbeat failed: {e}")
                self._clear_connection()
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
        if response and len(response) >= 4:
            # 0x0A ACK: byte 0 reserved, byte 1 hdr_sta, byte 2 reserved,
            # byte 3 record_sta.  Keep the SDK's no-card value distinct from
            # a stopped recording state.
            hdr_sta = response[1]
            record_sta = response[3]
            
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
        try:
            requested = Decimal(str(level))
        except (InvalidOperation, ValueError):
            logger.warning("Rejected invalid absolute zoom level")
            return False
        if not requested.is_finite():
            logger.warning("Rejected non-finite absolute zoom level")
            return False
        requested = max(Decimal("1.0"), min(Decimal("6.0"), requested))
        tenths = int((requested * 10).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        integer_part, decimal_part = divmod(tenths, 10)
        
        data = bytes([integer_part, decimal_part])
        response = await self._send_command(CmdId.ABSOLUTE_ZOOM, data)
        return response is not None
    
    async def capture_photo(self) -> bool:
        """Capture a photo."""
        data = bytes([FuncType.CAPTURE_PHOTO])
        sent = await self._send_command(CmdId.PHOTO_VIDEO, data, expect_response=False)
        if sent is None:
            logger.warning("Photo capture command was not sent")
            return False
        # 0x0C has no direct completion ACK.  This only confirms accepted
        # transmission, not that the camera stored a photo.
        logger.info("Photo capture command accepted for transmission")
        return True
    
    async def start_recording(self) -> bool:
        """Start video recording."""
        data = bytes([FuncType.START_RECORDING])
        sent = await self._send_command(CmdId.PHOTO_VIDEO, data, expect_response=False)
        if sent is None:
            logger.warning("Recording toggle command was not sent")
            return False
        # The command is a camera-side toggle.  Actual state must be learned
        # from function feedback/status rather than invented as an ACK here.
        logger.info("Recording toggle command accepted for transmission")
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

    @staticmethod
    def _invalid_command(action: str, message: str) -> dict:
        return {"success": False, "action": action, "error": "invalid_params", "message": message}

    @staticmethod
    def _finite_number(value: Any) -> Optional[float]:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        number = float(value)
        return number if number == number and abs(number) != float("inf") else None

    def _normalize_command(self, incoming: Any) -> Tuple[Optional[str], Optional[dict], Optional[dict]]:
        """Adapt the UI's ``{droneId, command: {type, ...}}`` envelope.

        The bridge also retains the documented ``{action, params}`` format for
        existing callers.  Translation occurs before camera control so malformed
        external data cannot reach struct packing or gimbal methods.
        """
        if not isinstance(incoming, dict):
            return None, None, self._invalid_command("", "command must be an object")
        if "command" in incoming:
            ui_command = incoming.get("command")
            if not isinstance(ui_command, dict):
                return None, None, self._invalid_command("", "command.command must be an object")
            command_type = ui_command.get("type")
            adapters = {
                "rotate": ("rotate", {"yaw": ui_command.get("yawSpeed"), "pitch": ui_command.get("pitchSpeed")}),
                "setAngles": ("set_angles", {"yaw": ui_command.get("yaw"), "pitch": ui_command.get("pitch")}),
                "center": ("center", {}),
                "nadir": ("nadir", {}),
                "zoom": ("set_zoom", {"level": ui_command.get("level")}),
                "photo": ("photo", {}),
                # The UI owns only a toggle.  Do not claim an ACK/state; issue
                # the protocol toggle and let status/feedback establish state.
                "recordToggle": ("record", {}),
            }
            translated = adapters.get(command_type)
            if translated is None:
                return None, None, self._invalid_command(str(command_type or ""), "unsupported UI camera command")
            return translated[0], translated[1], None

        action = incoming.get("action")
        params = incoming.get("params", {})
        if not isinstance(action, str) or not isinstance(params, dict):
            return None, None, self._invalid_command("", "action must be a string and params must be an object")
        return action, params, None

    def _validate_params(self, action: str, params: dict) -> Tuple[Optional[dict], Optional[dict]]:
        def numeric(name: str, lower: float, upper: float) -> Optional[float]:
            value = self._finite_number(params.get(name))
            if value is None or not lower <= value <= upper:
                return None
            return value

        if action == "rotate":
            yaw, pitch = numeric("yaw", -100, 100), numeric("pitch", -100, 100)
            if yaw is None or pitch is None:
                return None, self._invalid_command(action, "yaw and pitch must be finite numbers from -100 to 100")
            return {"yaw": int(yaw), "pitch": int(pitch)}, None
        if action == "set_angles":
            yaw, pitch = numeric("yaw", -135, 135), numeric("pitch", -90, 25)
            if yaw is None or pitch is None:
                return None, self._invalid_command(action, "yaw must be -135..135 and pitch -90..25")
            return {"yaw": yaw, "pitch": pitch}, None
        if action == "zoom":
            direction = numeric("direction", -1, 1)
            if direction is None or direction != int(direction):
                return None, self._invalid_command(action, "direction must be -1, 0, or 1")
            return {"direction": int(direction)}, None
        if action == "set_zoom":
            level = numeric("level", 1, 6)
            if level is None:
                return None, self._invalid_command(action, "level must be a finite number from 1 to 6")
            return {"level": level}, None
        if action == "focus":
            x, y = numeric("x", 0, 1000), numeric("y", 0, 1000)
            if x is None or y is None or x != int(x) or y != int(y):
                return None, self._invalid_command(action, "x and y must be integer coordinates from 0 to 1000")
            return {"x": int(x), "y": int(y)}, None
        if action in {"center", "nadir", "photo", "record", "stop_record", "get_status"}:
            return {}, None
        return None, {"success": False, "action": action, "error": "unknown_action"}
    
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
        action, params, error = self._normalize_command(command)
        if error:
            return error
        assert action is not None and params is not None
        params, error = self._validate_params(action, params)
        if error:
            return error
        assert params is not None
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
        except Exception as e:
            result["error"] = "camera_command_failed"
            logger.error("Error handling camera command %s: %s", action, e)
            
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
                "  python3 -m pip install --break-system-packages 'python-socketio[asyncio_client]' aiohttp"
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
                    await self.camera.stop_motion()
                
                @self.sio.event
                async def connect_error(data):
                    logger.error(f"Socket.IO connection error: {data}")
                    self._connected_to_hub = False
                
                @self.sio.on('camera_command')
                async def on_camera_command(data):
                    """Handle camera command from frontend via Hub."""
                    logger.info("Received camera command")
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
                    auth={'apiKey': self.api_key, 'droneId': self.drone_id},
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
                await self.camera.stop_motion()
                if self.sio and self.sio.connected:
                    try:
                        await self.sio.disconnect()
                    except:
                        pass
                await asyncio.sleep(5)

        await self._shutdown()
    
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
    
    async def _shutdown(self):
        """Unblock Socket.IO and leave the gimbal at zero velocity if possible."""
        self.running = False
        if self.sio and self.sio.connected:
            try:
                await self.sio.disconnect()
            except Exception:
                logger.debug("Socket.IO disconnect during shutdown failed", exc_info=True)
        await self.camera.disconnect(stop_motion=True)

    def stop(self):
        """Request bridge shutdown and schedule bounded cleanup on its event loop."""
        self.running = False
        if self.sio and self.sio.connected:
            try:
                asyncio.get_running_loop().create_task(self.sio.disconnect())
            except RuntimeError:
                # Signal handlers may run outside an active asyncio context; the
                # run loop observes ``running`` and executes _shutdown.
                pass


# ============================================================================
# Main Entry Point
# ============================================================================

async def main():
    parser = argparse.ArgumentParser(description='SIYI A8 Mini Camera Controller')
    parser.add_argument('--hub-url', type=str,
                       default=CONFIG.get('HUB_URL', ''),
                       help='Quiver Hub URL (default: HUB_URL/WEB_SERVER_URL)')
    parser.add_argument('--drone-id', type=str, 
                       default=CONFIG.get('DRONE_ID', 'quiver_001'),
                       help='Drone identifier (default: DRONE_ID)')
    parser.add_argument('--api-key', type=str,
                       default=CONFIG.get('API_KEY', ''),
                       help='API key for Quiver Hub authentication (default: API_KEY)')
    parser.add_argument('--test', action='store_true',
                       help='Run in test mode (direct camera control)')
    parser.add_argument('--debug', action='store_true',
                       help='Enable debug logging')
    
    args = parser.parse_args()
    try:
        if not 1 <= int(SIYI_SDK_PORT) <= 65535 or not 1 <= int(SIYI_RTSP_PORT) <= 65535:
            raise ValueError()
    except (ValueError, TypeError):
        parser.error('SIYI_SDK_PORT and SIYI_RTSP_PORT must be integers from 1 to 65535')

    if not args.test:
        for option, value, environment_key in (
            ('--hub-url', args.hub_url, 'HUB_URL or WEB_SERVER_URL'),
            ('--drone-id', args.drone_id, 'DRONE_ID'),
            ('--api-key', args.api_key, 'API_KEY'),
        ):
            if not value:
                parser.error(f'{option} is required; provide it or set {environment_key}')
    
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
