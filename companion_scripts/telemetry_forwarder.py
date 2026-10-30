#!/usr/bin/env python3
"""
Quiver Hub Telemetry Forwarder

Collects flight controller telemetry (MAVLink via the legacy MAVSDK Python API)
and battery data (UAVCAN), then forwards live telemetry samples to Quiver Hub via
HTTP POST.

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
    UPDATE_RATE_HZ - Finite telemetry update rate from 0 to 100 Hz (default: 10)
    ENABLE_UAVCAN - Enable active UAVCAN node participation (default: true)
    UAVCAN_NODE_ID - Unique operator-assigned UAVCAN node ID from 1 to 127 (default: 111)

The HTTP queue is intentionally bounded and live-only: failed samples are dropped
and reported rather than durably stored for replay.
"""

import argparse
import asyncio
import inspect
import logging
import math
import signal
import threading
from datetime import datetime
from queue import Empty, Full, Queue

import aiohttp
from mavsdk import System
import dronecan
from dronecan.driver.socketcan import SocketCAN

from companion_config import load_environment

# Configuration is loaded before constants and parser defaults. CLI overrides
# are applied in main() and passed to TelemetryForwarder explicitly.
CONFIG = load_environment()
WEB_SERVER_URL = CONFIG.get('WEB_SERVER_URL', '')
API_KEY = CONFIG.get('API_KEY', '')
DRONE_ID = CONFIG.get('DRONE_ID', 'quiver_001')
MAVLINK_URL = CONFIG.get('MAVLINK_URL', 'udpin://0.0.0.0:14540')
CAN_INTERFACE = CONFIG.get('CAN_INTERFACE', 'can0')
UPDATE_RATE_HZ = CONFIG.get('UPDATE_RATE_HZ', '10')
ENABLE_UAVCAN = CONFIG.get('ENABLE_UAVCAN', 'true').strip().lower() in ('1', 'true', 'yes', 'on')
UAVCAN_NODE_ID = CONFIG.get('UAVCAN_NODE_ID', '111')

INGEST_PATH = '/api/rest/telemetry/ingest'
MAX_UPDATE_RATE_HZ = 100.0
INITIAL_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0


def validate_update_rate(value):
    """Return a finite, bounded telemetry rate or raise a concise ValueError."""
    try:
        rate = float(value)
    except (TypeError, ValueError):
        raise ValueError('update rate must be a number') from None

    if not math.isfinite(rate) or rate <= 0 or rate > MAX_UPDATE_RATE_HZ:
        raise ValueError(
            f'update rate must be finite and greater than 0 and at most {MAX_UPDATE_RATE_HZ:g} Hz'
        )
    return rate


def validate_uavcan_node_id(value):
    """Return an operator-configured DroneCAN node ID in the valid unicast range."""
    if isinstance(value, bool):
        raise ValueError('UAVCAN node ID must be an integer from 1 to 127')
    value_text = str(value).strip()
    if not value_text.isascii() or not value_text.isdecimal():
        raise ValueError('UAVCAN node ID must be an integer from 1 to 127')

    node_id = int(value_text)
    if not 1 <= node_id <= 127:
        raise ValueError('UAVCAN node ID must be an integer from 1 to 127')
    return node_id


def normalize_hub_url(value):
    """Normalize only the historical exact ingest URL to the canonical Hub base URL."""
    url = str(value).strip().rstrip('/')
    if url.endswith(INGEST_PATH):
        return url[:-len(INGEST_PATH)].rstrip('/')
    return url


class TelemetryForwarder:
    """Multi-threaded telemetry forwarder with supervised MAVLink/CAN collectors."""

    def __init__(self, debug=False, web_server_url=WEB_SERVER_URL, api_key=API_KEY,
                 drone_id=DRONE_ID, mavlink_url=MAVLINK_URL,
                 can_interface=CAN_INTERFACE, update_rate_hz=UPDATE_RATE_HZ,
                 enable_uavcan=ENABLE_UAVCAN, uavcan_node_id=UAVCAN_NODE_ID):
        """Initialize the forwarder and validate direct-construction configuration."""
        self.debug = debug
        self.setup_logging()

        original_url = str(web_server_url).strip().rstrip('/')
        self.web_server_url = normalize_hub_url(web_server_url)
        if original_url != self.web_server_url:
            self.logger.warning(
                '[HTTP] Normalized legacy exact telemetry ingest URL to Hub base URL: %s',
                self.web_server_url,
            )
        self.ingest_url = f'{self.web_server_url}{INGEST_PATH}'
        self.api_key = api_key
        self.drone_id = drone_id
        self.mavlink_url = mavlink_url
        self.can_interface = can_interface
        self.update_rate_hz = validate_update_rate(update_rate_hz)
        self.enable_uavcan = enable_uavcan
        self.uavcan_node_id = validate_uavcan_node_id(uavcan_node_id)
        self.update_interval = 1.0 / self.update_rate_hz

        # Telemetry state (thread-safe with locks)
        self.telemetry_lock = threading.Lock()
        self.telemetry_data = {
            'attitude': None,
            'position': None,
            'gps': None,
            'battery_fc': None,  # From flight controller
            'battery_uavcan': None,  # From UAVCAN
            'in_air': False,
        }

        # Threading components
        self.http_queue = Queue(maxsize=10)
        self.stop_event = threading.Event()
        self.mavlink_thread = None
        self.uavcan_thread = None
        self.http_thread = None
        self._async_worker_lock = threading.Lock()
        self._async_workers = {}
        self._shutdown_reported = False

        # Statistics. Failed requests and bounded-queue overflows are drops;
        # this forwarder deliberately does not provide durable replay.
        self.stats_lock = threading.Lock()
        self.send_count = 0
        self.failed_send_count = 0
        self.dropped_count = 0

    def setup_logging(self):
        """Configure logging based on debug flag."""
        level = logging.DEBUG if self.debug else logging.INFO
        logging.basicConfig(
            level=level,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S',
        )
        self.logger = logging.getLogger(__name__)

    def _record_drop(self, reason):
        """Count a live sample discarded by the bounded, non-durable pipeline."""
        with self.stats_lock:
            self.dropped_count += 1
            dropped_count = self.dropped_count
        if dropped_count == 1 or dropped_count % 10 == 0:
            self.logger.warning(
                '[HTTP] Dropped telemetry sample (%s; total dropped: %d)', reason, dropped_count
            )
        return dropped_count

    def _record_failure(self):
        with self.stats_lock:
            self.failed_send_count += 1

    def _record_send(self):
        with self.stats_lock:
            self.send_count += 1
            return self.send_count

    def _stats_snapshot(self):
        with self.stats_lock:
            return self.send_count, self.failed_send_count, self.dropped_count

    async def wait_for_stop(self, seconds):
        """Wait up to *seconds*, polling the thread stop signal without a long blind sleep."""
        deadline = asyncio.get_running_loop().time() + max(0.0, seconds)
        while not self.stop_event.is_set():
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(0.1, remaining))
        return True

    def wait_for_stop_sync(self, seconds):
        """Synchronous companion for the UAVCAN worker's bounded retry delay."""
        return self.stop_event.wait(max(0.0, seconds))

    async def _await_connected_state(self, drone):
        async for state in drone.core.connection_state():
            if state.is_connected:
                return
            if self.stop_event.is_set():
                return
        raise ConnectionError('MAVLink connection-state stream ended before connection')

    async def wait_for_connection(self, drone):
        """Wait for the MAVSDK connection stream while allowing prompt shutdown."""
        connection_task = asyncio.create_task(self._await_connected_state(drone))
        try:
            while not self.stop_event.is_set():
                done, _ = await asyncio.wait(
                    {connection_task}, timeout=0.1, return_when=asyncio.FIRST_COMPLETED
                )
                if done:
                    await connection_task
                    return True
            return False
        finally:
            if not connection_task.done():
                connection_task.cancel()
                await asyncio.gather(connection_task, return_exceptions=True)

    async def _cancel_and_gather(self, tasks):
        """Cancel collector tasks and observe all exceptions before reconnecting or closing."""
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _close_async_resource(self, resource, label):
        """Close a MAVSDK resource when its installed legacy API exposes close()."""
        close = getattr(resource, 'close', None)
        if not callable(close):
            return
        try:
            result = close()
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            self.logger.debug('[MAVLINK] Could not close %s: %s', label, exc)

    async def mavlink_worker_async(self):
        """Supervise legacy-MAVSDK connection and collector failures with bounded backoff."""
        self.logger.info('[MAVLINK] MAVLink worker started')
        backoff = INITIAL_BACKOFF_SECONDS
        try:
            while not self.stop_event.is_set():
                drone = None
                collector_tasks = []
                try:
                    # This forwarder intentionally uses the legacy mavsdk.System API.
                    drone = System()
                    await drone.connect(system_address=self.mavlink_url)

                    if not await self.wait_for_connection(drone):
                        break
                    self.logger.info(
                        '[MAVLINK] Connected to flight controller: %s', self.mavlink_url
                    )

                    await drone.telemetry.set_rate_battery(1.0)
                    await drone.telemetry.set_rate_gps_info(1.0)
                    await drone.telemetry.set_rate_position(self.update_rate_hz)
                    await drone.telemetry.set_rate_attitude_euler(self.update_rate_hz)

                    collector_tasks = [
                        asyncio.create_task(self.collect_attitude(drone)),
                        asyncio.create_task(self.collect_position(drone)),
                        asyncio.create_task(self.collect_gps(drone)),
                        asyncio.create_task(self.collect_battery_fc(drone)),
                        asyncio.create_task(self.collect_in_air(drone)),
                        asyncio.create_task(self.send_telemetry_periodic()),
                    ]

                    # A collector ending or failing makes the connection unhealthy.
                    # Polling also makes a SIGTERM stop event observable even if all
                    # subscriptions are waiting for their next vehicle message.
                    while not self.stop_event.is_set():
                        done, _ = await asyncio.wait(
                            collector_tasks, timeout=0.1, return_when=asyncio.FIRST_COMPLETED
                        )
                        if not done:
                            continue
                        for task in done:
                            try:
                                task.result()
                            except asyncio.CancelledError:
                                raise
                            except Exception as exc:
                                raise ConnectionError(
                                    f'MAVLink collector failed: {exc}'
                                ) from exc
                            raise ConnectionError('MAVLink collector ended unexpectedly')

                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if not self.stop_event.is_set():
                        self.logger.warning(
                            '[MAVLINK] Collection attempt failed: %s; retrying in %.1fs',
                            exc,
                            backoff,
                        )
                finally:
                    await self._cancel_and_gather(collector_tasks)
                    if drone is not None:
                        await self._close_async_resource(drone, 'MAVSDK system')

                if self.stop_event.is_set():
                    break
                await self.wait_for_stop(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
        finally:
            self.logger.info('[MAVLINK] MAVLink worker stopped')

    async def collect_attitude(self, drone):
        """Collect attitude (Euler angles) from flight controller."""
        try:
            async for attitude in drone.telemetry.attitude_euler():
                with self.telemetry_lock:
                    self.telemetry_data['attitude'] = {
                        'roll_deg': attitude.roll_deg,
                        'pitch_deg': attitude.pitch_deg,
                        'yaw_deg': attitude.yaw_deg,
                        'timestamp': datetime.now().isoformat(),
                    }
                if self.debug:
                    self.logger.debug(
                        '[MAVLINK] Attitude: roll=%.2f, pitch=%.2f, yaw=%.2f',
                        attitude.roll_deg,
                        attitude.pitch_deg,
                        attitude.yaw_deg,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] Attitude subscription failed: %s', exc)
            raise

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
                        'timestamp': datetime.now().isoformat(),
                    }
                if self.debug:
                    self.logger.debug(
                        '[MAVLINK] Position: lat=%.6f, lon=%.6f, alt=%.2fm',
                        position.latitude_deg,
                        position.longitude_deg,
                        position.relative_altitude_m,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] Position subscription failed: %s', exc)
            raise

    async def collect_gps(self, drone):
        """Collect GPS info from flight controller."""
        try:
            async for gps_info in drone.telemetry.gps_info():
                with self.telemetry_lock:
                    self.telemetry_data['gps'] = {
                        'num_satellites': gps_info.num_satellites,
                        'fix_type': str(gps_info.fix_type),
                        'timestamp': datetime.now().isoformat(),
                    }
                if self.debug:
                    self.logger.debug(
                        '[MAVLINK] GPS: %s sats, fix=%s',
                        gps_info.num_satellites,
                        gps_info.fix_type,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] GPS subscription failed: %s', exc)
            raise

    async def collect_battery_fc(self, drone):
        """Collect battery info from flight controller."""
        try:
            async for battery in drone.telemetry.battery():
                with self.telemetry_lock:
                    self.telemetry_data['battery_fc'] = {
                        'voltage_v': battery.voltage_v,
                        'remaining_percent': battery.remaining_percent,
                        'timestamp': datetime.now().isoformat(),
                    }
                if self.debug:
                    self.logger.debug(
                        '[MAVLINK] Battery (FC): %.2fV, %.1f%%',
                        battery.voltage_v,
                        battery.remaining_percent,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] Battery subscription failed: %s', exc)
            raise

    async def collect_in_air(self, drone):
        """Collect in-air status from flight controller."""
        try:
            async for in_air in drone.telemetry.in_air():
                with self.telemetry_lock:
                    self.telemetry_data['in_air'] = in_air
                if self.debug:
                    self.logger.debug('[MAVLINK] In air: %s', in_air)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] In-air subscription failed: %s', exc)
            raise

    async def send_telemetry_periodic(self):
        """Periodically enqueue live telemetry, dropping on bounded-queue pressure."""
        while not self.stop_event.is_set():
            with self.telemetry_lock:
                payload = {
                    'api_key': self.api_key,
                    'drone_id': self.drone_id,
                    'timestamp': datetime.now().isoformat(),
                    'telemetry': self.telemetry_data.copy(),
                }
            try:
                self.http_queue.put_nowait(payload)
            except Full:
                self._record_drop('bounded HTTP queue full')
            await asyncio.sleep(self.update_interval)

    def _set_async_worker(self, name, loop, task):
        with self._async_worker_lock:
            self._async_workers[name] = (loop, task)

    def _clear_async_worker(self, name):
        with self._async_worker_lock:
            self._async_workers.pop(name, None)

    def _cancel_async_workers(self):
        """Request prompt cancellation of network awaits from the shutdown thread."""
        with self._async_worker_lock:
            workers = list(self._async_workers.values())
        for loop, task in workers:
            if loop.is_running() and not task.done():
                loop.call_soon_threadsafe(task.cancel)

    @staticmethod
    def _close_loop(loop):
        pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()

    def mavlink_worker(self):
        """Thread wrapper for the supervised async MAVLink worker."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        task = loop.create_task(self.mavlink_worker_async())
        self._set_async_worker('mavlink', loop, task)
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            pass
        finally:
            self._clear_async_worker('mavlink')
            self._close_loop(loop)

    def _close_uavcan_resource(self, resource, label):
        """Best-effort close for PyDroneCAN node/driver versions that expose close()."""
        close = getattr(resource, 'close', None)
        if not callable(close):
            return
        try:
            close()
        except Exception as exc:
            self.logger.debug('[UAVCAN] Could not close %s: %s', label, exc)

    def uavcan_worker(self):
        """Supervise the active UAVCAN battery collector with bounded reconnect backoff."""
        self.logger.info('[UAVCAN] UAVCAN worker started')
        backoff = INITIAL_BACKOFF_SECONDS
        try:
            while not self.stop_event.is_set():
                driver = None
                node = None
                try:
                    driver = SocketCAN(self.can_interface)
                    node = dronecan.node.Node(driver, node_id=self.uavcan_node_id)

                    node_info = dronecan.uavcan.protocol.GetNodeInfo.Response()
                    node_info.name = 'quiver_telemetry_bridge'
                    node_info.software_version.major = 1
                    node_info.software_version.minor = 0
                    node.node_info = node_info

                    self.logger.warning(
                        '[UAVCAN] Active bus participant on %s as node ID %d; '
                        'it may emit NodeStatus/respond to GetNodeInfo. Confirm this ID is unused. '
                        'The forwarder does not reconfigure the CAN interface.',
                        self.can_interface,
                        self.uavcan_node_id,
                    )

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
                                'timestamp': datetime.now().isoformat(),
                            }
                        if self.debug:
                            self.logger.debug(
                                '[UAVCAN] Battery: %.2fV, %.2fA, %.1f%%',
                                msg.voltage,
                                msg.current,
                                msg.state_of_charge_pct,
                            )

                    node.add_handler(dronecan.uavcan.equipment.power.BatteryInfo, battery_callback)
                    while not self.stop_event.is_set():
                        node.spin(timeout=0.1)
                except Exception as exc:
                    if not self.stop_event.is_set():
                        self.logger.warning(
                            '[UAVCAN] Collection attempt failed: %s; retrying in %.1fs',
                            exc,
                            backoff,
                        )
                finally:
                    if node is not None:
                        self._close_uavcan_resource(node, 'UAVCAN node')
                    if driver is not None:
                        self._close_uavcan_resource(driver, 'SocketCAN driver')

                if self.stop_event.is_set():
                    break
                self.wait_for_stop_sync(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
        finally:
            self.logger.info('[UAVCAN] UAVCAN worker stopped')

    def http_worker(self):
        """Send live telemetry samples over HTTP with bounded transient-failure backoff."""
        self.logger.info('[HTTP] HTTP worker started')
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def send_loop():
            timeout = aiohttp.ClientTimeout(total=5)
            backoff = INITIAL_BACKOFF_SECONDS
            async with aiohttp.ClientSession(timeout=timeout) as session:
                while not self.stop_event.is_set():
                    try:
                        payload = self.http_queue.get(timeout=0.1)
                    except Empty:
                        await asyncio.sleep(0.01)
                        continue

                    try:
                        async with session.post(self.ingest_url, json=payload) as response:
                            if response.status == 200:
                                send_count = self._record_send()
                                backoff = INITIAL_BACKOFF_SECONDS
                                if send_count % 10 == 0:
                                    self.logger.info('[HTTP] Sent %d telemetry packets', send_count)
                                continue
                            error_text = await response.text()
                            reason = f'HTTP {response.status}: {error_text[:200]}'
                    except asyncio.TimeoutError:
                        reason = 'request timeout'
                    except Exception as exc:
                        reason = f'request error: {exc}'

                    # The dequeued sample is intentionally not requeued: this is
                    # bounded live telemetry, not a durable spool/replay service.
                    self._record_failure()
                    dropped_count = self._record_drop(reason)
                    self.logger.warning(
                        '[HTTP] Transient delivery failure; sample dropped (total dropped: %d); '
                        'waiting %.1fs before sending newer samples',
                        dropped_count,
                        backoff,
                    )
                    await self.wait_for_stop(backoff)
                    backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

        task = loop.create_task(send_loop())
        self._set_async_worker('http', loop, task)
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            pass
        finally:
            self._clear_async_worker('http')
            self._close_loop(loop)
            self.logger.info('[HTTP] HTTP worker stopped')

    def start(self):
        """Start workers and block until a signal, keyboard interrupt, or stop request."""
        self.logger.info('=' * 60)
        self.logger.info('Starting Quiver Hub Telemetry Forwarder')
        self.logger.info('=' * 60)
        self.logger.info('Server URL: %s', self.web_server_url)
        self.logger.info('Drone ID: %s', self.drone_id)
        self.logger.info('MAVLink URL: %s', self.mavlink_url)
        self.logger.info('CAN Interface: %s (enabled: %s)', self.can_interface, self.enable_uavcan)
        if self.enable_uavcan:
            self.logger.warning(
                '[UAVCAN] Configured active node ID: %d (must be unique on this bus)',
                self.uavcan_node_id,
            )
        self.logger.info('Update Rate: %s Hz', self.update_rate_hz)
        self.logger.info('=' * 60)

        self.mavlink_thread = threading.Thread(target=self.mavlink_worker, daemon=True)
        if self.enable_uavcan:
            self.uavcan_thread = threading.Thread(target=self.uavcan_worker, daemon=True)
        self.http_thread = threading.Thread(target=self.http_worker, daemon=True)

        self.mavlink_thread.start()
        if self.uavcan_thread:
            self.uavcan_thread.start()
        else:
            self.logger.info('[UAVCAN] Disabled by ENABLE_UAVCAN')
        self.http_thread.start()
        self.logger.info('All workers started')

        try:
            while not self.stop_event.wait(timeout=1.0):
                pass
        except KeyboardInterrupt:
            self.logger.info('Keyboard interrupt received; shutting down')
            self.stop_event.set()
        finally:
            self.stop()

    def request_stop(self, reason='shutdown requested'):
        """Signal a graceful stop without doing thread joins from a signal handler."""
        if not self.stop_event.is_set():
            self.logger.info('%s', reason)
        self.stop_event.set()

    def stop(self):
        """Stop workers gracefully, including cancellation/gather of async worker tasks."""
        self.stop_event.set()
        self._cancel_async_workers()

        current_thread = threading.current_thread()
        for worker_thread in (self.mavlink_thread, self.uavcan_thread, self.http_thread):
            if worker_thread and worker_thread is not current_thread:
                worker_thread.join(timeout=2)

        if not self._shutdown_reported:
            self._shutdown_reported = True
            send_count, failed_send_count, dropped_count = self._stats_snapshot()
            self.logger.info(
                'Final stats: %d sent, %d failed deliveries, %d dropped live samples',
                send_count,
                failed_send_count,
                dropped_count,
            )
            self.logger.info('Shutdown complete')


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Quiver Hub Telemetry Forwarder')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    parser.add_argument('--hub-url', '--server', dest='web_server_url', default=WEB_SERVER_URL,
                        help='Hub base URL (default: HUB_URL/WEB_SERVER_URL)')
    parser.add_argument('--api-key', default=API_KEY, help='Hub API key (default: API_KEY)')
    parser.add_argument('--drone-id', default=DRONE_ID, help='Drone ID (default: DRONE_ID)')
    parser.add_argument('--mavlink-url', default=MAVLINK_URL,
                        help='MAVLink URL (default: MAVLINK_URL)')
    parser.add_argument('--can-interface', default=CAN_INTERFACE,
                        help='CAN interface (default: CAN_INTERFACE)')
    parser.add_argument('--update-rate-hz', default=UPDATE_RATE_HZ,
                        help='Finite telemetry update rate from 0 to 100 Hz (default: UPDATE_RATE_HZ)')
    parser.add_argument('--uavcan-node-id', default=UAVCAN_NODE_ID,
                        help='Unique active UAVCAN node ID from 1 to 127 (default: UAVCAN_NODE_ID)')
    parser.add_argument('--disable-uavcan', action='store_true',
                        help='Disable the UAVCAN worker for this invocation')
    args = parser.parse_args()

    if not args.web_server_url:
        parser.error('--hub-url is required; provide it or set HUB_URL/WEB_SERVER_URL')
    if not args.api_key:
        parser.error('--api-key is required; provide it or set API_KEY')
    if not args.drone_id:
        parser.error('--drone-id is required; provide it or set DRONE_ID')
    try:
        update_rate_hz = validate_update_rate(args.update_rate_hz)
    except ValueError as exc:
        parser.error(f'invalid UPDATE_RATE_HZ/--update-rate-hz: {exc}')
    try:
        uavcan_node_id = validate_uavcan_node_id(args.uavcan_node_id)
    except ValueError as exc:
        parser.error(f'invalid UAVCAN_NODE_ID/--uavcan-node-id: {exc}')

    forwarder = TelemetryForwarder(
        debug=args.debug,
        web_server_url=args.web_server_url,
        api_key=args.api_key,
        drone_id=args.drone_id,
        mavlink_url=args.mavlink_url,
        can_interface=args.can_interface,
        update_rate_hz=update_rate_hz,
        enable_uavcan=ENABLE_UAVCAN and not args.disable_uavcan,
        uavcan_node_id=uavcan_node_id,
    )

    def handle_signal(signum, _frame):
        signal_name = signal.Signals(signum).name
        forwarder.request_stop(f'{signal_name} received; shutting down gracefully')

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    forwarder.start()


if __name__ == '__main__':
    main()
