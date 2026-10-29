#!/usr/bin/env python3
"""
Quiver Hub Telemetry Forwarder

Collects flight controller telemetry (MAVLink via MAVSDK) and battery data (UAVCAN),
then forwards to Quiver Hub via HTTP POST to tRPC endpoint.

Data Sources:
- Flight Controller: MAVLink over UDP (attitude, position, GPS)
- Battery: UAVCAN BatteryInfo messages

Usage:
    python3 telemetry_forwarder.py [--debug]

Environment Variables:
    WEB_SERVER_URL - Quiver Hub base URL (e.g., https://your-domain.com)
    API_KEY - API key for authentication
    DRONE_ID - Drone identifier
    MAVLINK_URL - MAVLink connection URL (default: udpin://0.0.0.0:14540)
    CAN_INTERFACE - CAN interface for UAVCAN (default: can0)
    UPDATE_RATE_HZ - Telemetry update rate (default: 10)

Author: Manus AI
"""

import os
import sys
import json
import asyncio
import aiohttp
import logging
import argparse
import threading
from datetime import datetime
from queue import Queue, Empty
from mavsdk import System
import dronecan
from dronecan.driver.socketcan import SocketCAN
from companion_config import load_environment

# Configuration is loaded before constants and parser defaults.  CLI overrides
# are applied in main() and passed to TelemetryForwarder explicitly.
CONFIG = load_environment()
WEB_SERVER_URL = CONFIG.get('WEB_SERVER_URL', '')
API_KEY = CONFIG.get('API_KEY', '')
DRONE_ID = CONFIG.get('DRONE_ID', 'quiver_001')
MAVLINK_URL = CONFIG.get('MAVLINK_URL', 'udpin://0.0.0.0:14540')
CAN_INTERFACE = CONFIG.get('CAN_INTERFACE', 'can0')
UPDATE_RATE_HZ = float(CONFIG.get('UPDATE_RATE_HZ', '10'))
ENABLE_UAVCAN = CONFIG.get('ENABLE_UAVCAN', 'true').strip().lower() in ('1', 'true', 'yes', 'on')
UAVCAN_NODE_ID = 111  # Unique node ID for this telemetry bridge

class TelemetryForwarder:
    """Multi-threaded telemetry forwarder."""
    
    def __init__(self, debug=False, web_server_url=WEB_SERVER_URL, api_key=API_KEY,
                 drone_id=DRONE_ID, mavlink_url=MAVLINK_URL,
                 can_interface=CAN_INTERFACE, update_rate_hz=UPDATE_RATE_HZ,
                 enable_uavcan=ENABLE_UAVCAN):
        """
        Initialize the forwarder.
        
        Args:
            debug (bool): Enable debug logging
        """
        self.debug = debug
        self.setup_logging()
        
        # Configuration
        self.web_server_url = web_server_url.rstrip('/')
        self.api_key = api_key
        self.drone_id = drone_id
        self.mavlink_url = mavlink_url
        self.can_interface = can_interface
        self.update_rate_hz = update_rate_hz
        self.enable_uavcan = enable_uavcan
        self.update_interval = 1.0 / self.update_rate_hz
        
        # Telemetry state (thread-safe with locks)
        self.telemetry_lock = threading.Lock()
        self.telemetry_data = {
            'attitude': None,
            'position': None,
            'gps': None,
            'battery_fc': None,  # From flight controller
            'battery_uavcan': None,  # From UAVCAN
            'in_air': False
        }
        
        # Threading components
        self.http_queue = Queue(maxsize=10)
        self.stop_event = threading.Event()
        self.mavlink_thread = None
        self.uavcan_thread = None
        self.http_thread = None
        
        # Statistics
        self.send_count = 0
        
    def setup_logging(self):
        """Configure logging based on debug flag."""
        level = logging.DEBUG if self.debug else logging.INFO
        logging.basicConfig(
            level=level,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        self.logger = logging.getLogger(__name__)
    
    async def mavlink_worker_async(self):
        """
        Async worker that collects MAVLink telemetry.
        Runs in separate thread with its own event loop.
        """
        self.logger.info("[MAVLINK] MAVLink worker started")
        
        try:
            # Connect to flight controller
            drone = System()
            await drone.connect(system_address=self.mavlink_url)
            
            # Wait for connection
            async for state in drone.core.connection_state():
                if state.is_connected:
                    self.logger.info(f"[MAVLINK] ✅ Connected to flight controller: {self.mavlink_url}")
                    break
            
            # Set telemetry rates
            await drone.telemetry.set_rate_battery(1.0)
            await drone.telemetry.set_rate_gps_info(1.0)
            await drone.telemetry.set_rate_position(self.update_rate_hz)
            await drone.telemetry.set_rate_attitude_euler(self.update_rate_hz)
            
            # Start telemetry collectors
            asyncio.create_task(self.collect_attitude(drone))
            asyncio.create_task(self.collect_position(drone))
            asyncio.create_task(self.collect_gps(drone))
            asyncio.create_task(self.collect_battery_fc(drone))
            asyncio.create_task(self.collect_in_air(drone))
            asyncio.create_task(self.send_telemetry_periodic())
            
            # Keep loop alive
            while not self.stop_event.is_set():
                await asyncio.sleep(0.1)
                
        except Exception as e:
            self.logger.error(f"[MAVLINK] Error: {e}")
        finally:
            self.logger.info("[MAVLINK] MAVLink worker stopped")
    
    async def collect_attitude(self, drone):
        """Collect attitude (Euler angles) from flight controller."""
        try:
            async for attitude in drone.telemetry.attitude_euler():
                with self.telemetry_lock:
                    self.telemetry_data['attitude'] = {
                        'roll_deg': attitude.roll_deg,
                        'pitch_deg': attitude.pitch_deg,
                        'yaw_deg': attitude.yaw_deg,
                        'timestamp': datetime.now().isoformat()
                    }
                
                if self.debug:
                    self.logger.debug(f"[MAVLINK] Attitude: roll={attitude.roll_deg:.2f}, "
                                    f"pitch={attitude.pitch_deg:.2f}, yaw={attitude.yaw_deg:.2f}")
        except Exception as e:
            if self.debug:
                self.logger.debug(f"[MAVLINK] Attitude error: {e}")
    
    async def collect_position(self, drone):
        """Collect position (lat/lon/alt) from flight controller."""
        try:
            async for position in drone.telemetry.position():
                with self.telemetry_lock:
                    self.telemetry_data['position'] = {
                        'latitude_deg': position.latitude_deg,
                        'longitude_deg': position.longitude_deg,
                        'absolute_altitude_m': position.absolute_altitude_m,
                        'relative_altitude_m': position.relative_altitude_m,
                        'timestamp': datetime.now().isoformat()
                    }
                
                if self.debug:
                    self.logger.debug(f"[MAVLINK] Position: lat={position.latitude_deg:.6f}, "
                                    f"lon={position.longitude_deg:.6f}, alt={position.relative_altitude_m:.2f}m")
        except Exception as e:
            if self.debug:
                self.logger.debug(f"[MAVLINK] Position error: {e}")
    
    async def collect_gps(self, drone):
        """Collect GPS info from flight controller."""
        try:
            async for gps_info in drone.telemetry.gps_info():
                with self.telemetry_lock:
                    self.telemetry_data['gps'] = {
                        'num_satellites': gps_info.num_satellites,
                        'fix_type': str(gps_info.fix_type),
                        'timestamp': datetime.now().isoformat()
                    }
                
                if self.debug:
                    self.logger.debug(f"[MAVLINK] GPS: {gps_info.num_satellites} sats, fix={gps_info.fix_type}")
        except Exception as e:
            if self.debug:
                self.logger.debug(f"[MAVLINK] GPS error: {e}")
    
    async def collect_battery_fc(self, drone):
        """Collect battery info from flight controller."""
        try:
            async for battery in drone.telemetry.battery():
                with self.telemetry_lock:
                    self.telemetry_data['battery_fc'] = {
                        'voltage_v': battery.voltage_v,
                        'remaining_percent': battery.remaining_percent,
                        'timestamp': datetime.now().isoformat()
                    }
                
                if self.debug:
                    self.logger.debug(f"[MAVLINK] Battery (FC): {battery.voltage_v:.2f}V, "
                                    f"{battery.remaining_percent:.1f}%")
        except Exception as e:
            if self.debug:
                self.logger.debug(f"[MAVLINK] Battery (FC) error: {e}")
    
    async def collect_in_air(self, drone):
        """Collect in-air status from flight controller."""
        try:
            async for in_air in drone.telemetry.in_air():
                with self.telemetry_lock:
                    self.telemetry_data['in_air'] = in_air
                
                if self.debug:
                    self.logger.debug(f"[MAVLINK] In air: {in_air}")
        except Exception as e:
            if self.debug:
                self.logger.debug(f"[MAVLINK] In air error: {e}")
    
    async def send_telemetry_periodic(self):
        """Periodically send telemetry to HTTP queue."""
        while not self.stop_event.is_set():
            try:
                # Create payload
                with self.telemetry_lock:
                    payload = {
                        'api_key': self.api_key,
                        'drone_id': self.drone_id,
                        'timestamp': datetime.now().isoformat(),
                        'telemetry': self.telemetry_data.copy()
                    }
                
                # Put in HTTP queue
                try:
                    self.http_queue.put_nowait(payload)
                except:
                    if self.debug:
                        self.logger.debug("[MAVLINK] HTTP queue full, dropping telemetry")
                
                await asyncio.sleep(self.update_interval)
                
            except Exception as e:
                if self.debug:
                    self.logger.debug(f"[MAVLINK] Send periodic error: {e}")
    
    def mavlink_worker(self):
        """Thread wrapper for async MAVLink worker."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self.mavlink_worker_async())
        finally:
            loop.close()
    
    def uavcan_worker(self):
        """
        Worker thread that collects UAVCAN battery data.
        Runs independently from MAVLink collection.
        """
        self.logger.info("[UAVCAN] UAVCAN worker started")
        
        try:
            # Connect to UAVCAN
            driver = SocketCAN(self.can_interface)
            node = dronecan.node.Node(driver, node_id=UAVCAN_NODE_ID)
            
            # Set node info
            node_info = dronecan.uavcan.protocol.GetNodeInfo.Response()
            node_info.name = "quiver_telemetry_bridge"
            node_info.software_version.major = 1
            node_info.software_version.minor = 0
            node.node_info = node_info
            
            self.logger.info(f"[UAVCAN] ✅ Connected to CAN interface: {self.can_interface}")
            
            # Subscribe to BatteryInfo messages
            def battery_callback(event):
                """Handle incoming UAVCAN battery messages."""
                msg = event.message
                
                with self.telemetry_lock:
                    self.telemetry_data['battery_uavcan'] = {
                        'voltage_v': msg.voltage,
                        'current_a': msg.current,
                        'temperature_k': msg.temperature,
                        'state_of_charge_pct': msg.state_of_charge_pct,
                        'state_of_health_pct': msg.state_of_health_pct,
                        'timestamp': datetime.now().isoformat()
                    }
                
                if self.debug:
                    self.logger.debug(f"[UAVCAN] Battery: {msg.voltage:.2f}V, "
                                    f"{msg.current:.2f}A, {msg.state_of_charge_pct:.1f}%")
            
            node.add_handler(dronecan.uavcan.equipment.power.BatteryInfo, battery_callback)
            
            # Spin node (blocking)
            while not self.stop_event.is_set():
                try:
                    node.spin(timeout=0.1)
                except Exception as e:
                    if self.debug:
                        self.logger.debug(f"[UAVCAN] Spin error: {e}")
                    
        except Exception as e:
            self.logger.error(f"[UAVCAN] Error: {e}")
        finally:
            self.logger.info("[UAVCAN] UAVCAN worker stopped")
    
    def http_worker(self):
        """
        Worker thread that sends HTTP requests to Quiver Hub.
        Consumes telemetry from queue and sends via POST.
        """
        self.logger.info("[HTTP] HTTP worker started")
        
        # Create async event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        async def send_loop():
            """Async loop for sending HTTP requests."""
            # Create persistent session
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                while not self.stop_event.is_set():
                    try:
                        # Get telemetry from queue (non-blocking with timeout)
                        try:
                            payload = self.http_queue.get(timeout=0.1)
                        except Empty:
                            await asyncio.sleep(0.01)
                            continue
                        
                        # Send to REST endpoint
                        rest_url = f"{self.web_server_url}/api/rest/telemetry/ingest"
                        
                        async with session.post(rest_url, json=payload) as response:
                            if response.status == 200:
                                self.send_count += 1
                                if self.send_count % 10 == 0:
                                    self.logger.info(f"[HTTP] ✅ Sent {self.send_count} telemetry packets")
                            else:
                                error_text = await response.text()
                                self.logger.warning(f"[HTTP] ⚠️  Server returned {response.status}: {error_text[:200]}")
                                
                    except asyncio.TimeoutError:
                        self.logger.warning("[HTTP] ⚠️  Request timeout")
                    except Exception as e:
                        self.logger.error(f"[HTTP] ❌ Error: {e}")
                        await asyncio.sleep(1)  # Back off on error
        
        try:
            loop.run_until_complete(send_loop())
        finally:
            loop.close()
            self.logger.info("[HTTP] HTTP worker stopped")
    
    def start(self):
        """Start all worker threads."""
        self.logger.info("=" * 60)
        self.logger.info("🚀 Starting Quiver Hub Telemetry Forwarder")
        self.logger.info("=" * 60)
        self.logger.info(f"Server URL: {self.web_server_url}")
        self.logger.info(f"Drone ID: {self.drone_id}")
        self.logger.info(f"MAVLink URL: {self.mavlink_url}")
        self.logger.info(f"CAN Interface: {self.can_interface} (enabled: {self.enable_uavcan})")
        self.logger.info(f"Update Rate: {self.update_rate_hz} Hz")
        self.logger.info("=" * 60)
        
        # Start threads
        self.mavlink_thread = threading.Thread(target=self.mavlink_worker, daemon=True)
        if self.enable_uavcan:
            self.uavcan_thread = threading.Thread(target=self.uavcan_worker, daemon=True)
        self.http_thread = threading.Thread(target=self.http_worker, daemon=True)
        
        self.mavlink_thread.start()
        if self.uavcan_thread:
            self.uavcan_thread.start()
        else:
            self.logger.info("[UAVCAN] Disabled by ENABLE_UAVCAN")
        self.http_thread.start()
        
        self.logger.info("✅ All workers started")
        
        # Keep main thread alive
        try:
            while True:
                asyncio.run(asyncio.sleep(1))
        except KeyboardInterrupt:
            self.logger.info("\n🛑 Shutting down...")
            self.stop()
    
    def stop(self):
        """Stop all worker threads gracefully."""
        self.stop_event.set()
        
        # Wait for threads to finish
        if self.mavlink_thread:
            self.mavlink_thread.join(timeout=2)
        if self.uavcan_thread:
            self.uavcan_thread.join(timeout=2)
        if self.http_thread:
            self.http_thread.join(timeout=2)
        
        self.logger.info(f"📊 Final stats: {self.send_count} telemetry packets sent")
        self.logger.info("✅ Shutdown complete")

def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Quiver Hub Telemetry Forwarder')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    parser.add_argument('--hub-url', '--server', dest='web_server_url', default=WEB_SERVER_URL,
                        help='Hub URL (default: HUB_URL/WEB_SERVER_URL)')
    parser.add_argument('--api-key', default=API_KEY, help='Hub API key (default: API_KEY)')
    parser.add_argument('--drone-id', default=DRONE_ID, help='Drone ID (default: DRONE_ID)')
    parser.add_argument('--mavlink-url', default=MAVLINK_URL,
                        help='MAVLink URL (default: MAVLINK_URL)')
    parser.add_argument('--can-interface', default=CAN_INTERFACE,
                        help='CAN interface (default: CAN_INTERFACE)')
    parser.add_argument('--update-rate-hz', type=float, default=UPDATE_RATE_HZ,
                        help='Telemetry update rate (default: UPDATE_RATE_HZ)')
    parser.add_argument('--disable-uavcan', action='store_true',
                        help='Disable the UAVCAN worker for this invocation')
    args = parser.parse_args()

    if not args.web_server_url:
        parser.error('--hub-url is required; provide it or set HUB_URL/WEB_SERVER_URL')
    if not args.api_key:
        parser.error('--api-key is required; provide it or set API_KEY')
    if not args.drone_id:
        parser.error('--drone-id is required; provide it or set DRONE_ID')
    if args.update_rate_hz <= 0:
        parser.error('--update-rate-hz must be greater than zero')
    
    # Create and start forwarder
    forwarder = TelemetryForwarder(
        debug=args.debug,
        web_server_url=args.web_server_url,
        api_key=args.api_key,
        drone_id=args.drone_id,
        mavlink_url=args.mavlink_url,
        can_interface=args.can_interface,
        update_rate_hz=args.update_rate_hz,
        enable_uavcan=ENABLE_UAVCAN and not args.disable_uavcan,
    )
    forwarder.start()

if __name__ == '__main__':
    main()
