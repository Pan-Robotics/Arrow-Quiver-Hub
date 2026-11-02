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
    ENABLE_UAVCAN - Enable active UAVCAN node participation (default: false)
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
import socket
import struct
import subprocess
import sys
import threading
import time
import warnings
from datetime import datetime
from queue import Empty, Full, Queue

from companion_config import load_environment

# Import failures are deferred until preflight so --help and CLI validation work
# even with missing/incompatible packages. No dependency is connected here.
aiohttp = System = dronecan = SocketCAN = None
try:
    import aiohttp
except Exception:
    pass
try:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', FutureWarning)
        from mavsdk import System
except Exception:
    pass
try:
    import dronecan
    from dronecan.driver.socketcan import SocketCAN
except Exception:
    pass

# Numeric defaults remain strings until CLI overrides have been applied.
CONFIG_ERROR = False
try:
    CONFIG = load_environment()
except (OSError, ValueError):
    CONFIG = {}
    CONFIG_ERROR = True
WEB_SERVER_URL = CONFIG.get('WEB_SERVER_URL', '')
API_KEY = CONFIG.get('API_KEY', '')
DRONE_ID = CONFIG.get('DRONE_ID', 'quiver_001')
MAVLINK_URL = CONFIG.get('MAVLINK_URL', 'udpin://0.0.0.0:14540')
CAN_INTERFACE = CONFIG.get('CAN_INTERFACE', 'can0')
UPDATE_RATE_HZ = CONFIG.get('UPDATE_RATE_HZ', '10')
ENABLE_UAVCAN = CONFIG.get('ENABLE_UAVCAN', 'false').strip().lower() in ('1', 'true', 'yes', 'on')
UAVCAN_NODE_ID = CONFIG.get('UAVCAN_NODE_ID', '111')

INGEST_PATH = '/api/rest/telemetry/ingest'
MAX_UPDATE_RATE_HZ = 100.0
INITIAL_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0


def validate_test_seconds(value):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        raise ValueError('test seconds must be a finite number from 1 to 300') from None
    if not math.isfinite(seconds) or not 1 <= seconds <= 300:
        raise ValueError('test seconds must be a finite number from 1 to 300')
    return seconds


def runtime_preflight(can_interface, enable_uavcan):
    """Offline checks under the invoking service account; never transmit/connect.

    Installers must invoke this with the service's interpreter AND user, not root
    on behalf of a less-privileged account. No interface is created or brought up.
    """
    try:
        from installer_support import sdk_preflight
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', FutureWarning)
            sdk_preflight()
    except Exception as error:
        raise ValueError(
            'legacy MAVSDK 3.17.4 dependency/API preflight failed '
            f'({type(error).__name__}); use the installed service Python environment'
        ) from None
    if aiohttp is None or System is None:
        raise ValueError('aiohttp and legacy MAVSDK 3.17.4 are required in this interpreter')
    if not enable_uavcan:
        print('CHECK CAN=disabled (no CAN socket opened)')
        return
    if dronecan is None or SocketCAN is None:
        raise ValueError('enabled UAVCAN requires PyDroneCAN in this interpreter')
    if not can_interface or len(can_interface.encode()) > 15 or '\x00' in can_interface:
        raise ValueError('CAN interface must be an existing Linux interface name')
    try:
        import fcntl
        socket.if_nametoindex(can_interface)
        with socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW) as probe:
            flags = fcntl.ioctl(probe.fileno(), 0x8913, struct.pack('256s', can_interface.encode()))
            if not struct.unpack_from('H', flags, 16)[0] & 1:  # SIOCGIFFLAGS / IFF_UP
                raise ValueError('enabled CAN interface is down; configure it explicitly before startup')
            probe.bind((can_interface,))
    except (OSError, AttributeError, ImportError) as error:
        raise ValueError(
            'enabled CAN interface missing/unavailable or this account cannot bind '
            f'({type(error).__name__}); no interface changes were made'
        ) from None
    print('CHECK CAN=ready (interface up; invoking account bound without transmit)')


class _LivePayload(dict):
    """Local provenance only; never include these attributes in the Hub JSON."""
    pass


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
                '[HTTP] Normalized legacy exact telemetry ingest URL to Hub base URL',
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
        self._requested_stop = False
        self.health_lock = threading.Lock()
        self.health = {
            'mavlink_connected': False, 'fc_samples': 0, 'fc_current': 0,
            'generation': 0, 'http_ready': False, 'http_ack': False,
            'can_ready': False, 'battery_samples': 0,
            'workers': {}, 'errors': {}, 'fatal_worker_exit': False, 'cleanup_failed': False,
        }
        self._last_enqueued_sequence = 0

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
        # The SDK subprocess can log raw endpoint/error text. Runtime diagnostics
        # come from our compact, sanitized health state instead, even in debug.
        logging.getLogger('mavsdk_server').disabled = True

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

    def _health_update(self, **values):
        with self.health_lock:
            self.health.update(values)

    def health_snapshot(self):
        with self.health_lock:
            return {**self.health, 'workers': self.health['workers'].copy(),
                    'errors': self.health['errors'].copy()}

    def _worker_error(self, name, error):
        # Exception text may contain URLs, tokens or raw remote bodies.
        with self.health_lock:
            self.health['errors'][name] = type(error).__name__

    def _run_worker(self, name, target):
        with self.health_lock:
            self.health['workers'][name] = 'running'
        try:
            target()
        except (Exception, SystemExit) as error:
            self._worker_error(name, error)
            if self.stop_event.is_set():
                self._health_update(cleanup_failed=True)
            self.logger.error('[%s] Worker failed (%s)', name.upper(), type(error).__name__)
        finally:
            with self.health_lock:
                self.health['workers'][name] = 'stopped'
                if not self.stop_event.is_set():
                    self.health['fatal_worker_exit'] = True

    def _record_fc_sample(self):
        """Called with telemetry_lock held, only after a subscription yielded data."""
        with self.health_lock:
            self.health['fc_samples'] += 1
            self.health['fc_current'] += 1

    def _reset_connection(self, connected=False):
        """Invalidate cached data and queued provenance at every connection boundary."""
        with self.telemetry_lock:
            for key in ('attitude', 'position', 'gps', 'battery_fc'):
                self.telemetry_data[key] = None
            self.telemetry_data['in_air'] = False
            with self.health_lock:
                self.health['mavlink_connected'] = connected
                self.health['generation'] += 1
                self.health['fc_current'] = 0
                self.health['http_ack'] = False
            self._last_enqueued_sequence = 0
            while True:
                try:
                    self.http_queue.get_nowait()
                    self._record_drop('connection changed')
                except Empty:
                    break

    def _test_healthy(self):
        state = self.health_snapshot()
        return (state['mavlink_connected'] and state['fc_current'] > 0
                and state['http_ack'] and state['http_ready']
                and not state['fatal_worker_exit']
                and (not self.enable_uavcan or state['can_ready']))

    def _status_text(self):
        state = self.health_snapshot()
        can = ('ready' if state['can_ready'] else 'waiting') if self.enable_uavcan else 'disabled'
        return ('MAVLink=' + ('connected' if state['mavlink_connected'] else 'waiting')
                + f" FC_samples={state['fc_current']} Hub_ack="
                + ('yes' if state['http_ack'] else 'waiting')
                + f" CAN={can} BatteryInfo={state['battery_samples']} (optional)")

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

    async def _monitor_connection(self, drone):
        async for state in drone.core.connection_state():
            if not state.is_connected:
                self._reset_connection()
                raise ConnectionError('MAVLink disconnected')
        raise ConnectionError('MAVLink connection-state stream ended')

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
                    return not self.stop_event.is_set()
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
        """Close fake/new API resources, or reap the exact child owned by 3.17.4.

        Legacy System.__del__ kills but does not wait. Do not use process-name
        searches, port-owner kills or process groups: other services may own SDKs.
        """
        close = getattr(resource, 'close', None)
        try:
            if callable(close):
                result = close()
                if inspect.isawaitable(result):
                    await result
                return
            process = getattr(resource, '_server_process', None)
            if isinstance(process, subprocess.Popen):
                try:
                    if process.poll() is None:
                        process.terminate()
                    try:
                        await asyncio.to_thread(process.wait, timeout=1)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        await asyncio.to_thread(process.wait, timeout=1)
                finally:
                    if process.poll() is not None:
                        resource._server_process = None
        except Exception as exc:
            self._worker_error('mavlink', exc)
            self._health_update(cleanup_failed=True)
            self.logger.warning('[MAVLINK] Resource cleanup failed (%s)', type(exc).__name__)

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
                    self._reset_connection(connected=True)
                    self.logger.info('[MAVLINK] Connected to flight controller')

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
                        asyncio.create_task(self._monitor_connection(drone)),
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
                                    'MAVLink collector failed'
                                ) from exc
                            raise ConnectionError('MAVLink collector ended unexpectedly')

                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if not self.stop_event.is_set():
                        self._worker_error('mavlink', exc)
                        self.logger.warning(
                            '[MAVLINK] Collection attempt failed: %s; retrying in %.1fs',
                            type(exc).__name__,
                            backoff,
                        )
                finally:
                    self._reset_connection()
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
                    self._record_fc_sample()
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
            self.logger.warning('[MAVLINK] Attitude subscription failed (%s)', type(exc).__name__)
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
                    self._record_fc_sample()
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
            self.logger.warning('[MAVLINK] Position subscription failed (%s)', type(exc).__name__)
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
                    self._record_fc_sample()
                if self.debug:
                    self.logger.debug(
                        '[MAVLINK] GPS: %s sats, fix=%s',
                        gps_info.num_satellites,
                        gps_info.fix_type,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] GPS subscription failed (%s)', type(exc).__name__)
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
                    self._record_fc_sample()
                if self.debug:
                    self.logger.debug(
                        '[MAVLINK] Battery (FC): %.2fV, %.1f%%',
                        battery.voltage_v,
                        battery.remaining_percent,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] Battery subscription failed (%s)', type(exc).__name__)
            raise

    async def collect_in_air(self, drone):
        """Collect in-air status from flight controller."""
        try:
            async for in_air in drone.telemetry.in_air():
                with self.telemetry_lock:
                    self.telemetry_data['in_air'] = in_air
                    self._record_fc_sample()
                if self.debug:
                    self.logger.debug('[MAVLINK] In air: %s', in_air)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.logger.warning('[MAVLINK] In-air subscription failed (%s)', type(exc).__name__)
            raise

    async def send_telemetry_periodic(self):
        """Periodically enqueue live telemetry, dropping on bounded-queue pressure."""
        while not self.stop_event.is_set():
            with self.telemetry_lock:
                with self.health_lock:
                    connected = self.health['mavlink_connected']
                    sequence = self.health['fc_current']
                    generation = self.health['generation']
                if connected and sequence > self._last_enqueued_sequence:
                    payload = _LivePayload({
                        'api_key': self.api_key,
                        'drone_id': self.drone_id,
                        'timestamp': datetime.now().isoformat(),
                        'telemetry': self.telemetry_data.copy(),
                    })
                    payload.generation = generation
                    self._last_enqueued_sequence = sequence
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
                try:
                    loop.call_soon_threadsafe(task.cancel)
                except RuntimeError:
                    pass  # The worker closed its loop between the snapshot and call.

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
            self._health_update(cleanup_failed=True)
            self.logger.debug('[UAVCAN] Resource cleanup failed (%s)', type(exc).__name__)

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
                        with self.health_lock:
                            self.health['battery_samples'] += 1
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
                        self._health_update(can_ready=True)
                except Exception as exc:
                    if not self.stop_event.is_set():
                        self._worker_error('can', exc)
                        self.logger.warning(
                            '[UAVCAN] Collection attempt failed: %s; retrying in %.1fs',
                            type(exc).__name__,
                            backoff,
                        )
                finally:
                    self._health_update(can_ready=False)
                    with self.telemetry_lock:
                        self.telemetry_data['battery_uavcan'] = None
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
                self._health_update(http_ready=True)
                while not self.stop_event.is_set():
                    try:
                        payload = self.http_queue.get(timeout=0.1)
                    except Empty:
                        await asyncio.sleep(0.01)
                        continue

                    generation = getattr(payload, 'generation', None)
                    if generation is not None:
                        with self.health_lock:
                            current = (self.health['mavlink_connected']
                                       and generation == self.health['generation'])
                        if not current:
                            self._record_drop('connection changed')
                            continue
                    delay = backoff
                    try:
                        async with session.post(self.ingest_url, json=payload) as response:
                            if response.status == 200:
                                acknowledgement = await response.json()
                                if (isinstance(acknowledgement, dict)
                                        and acknowledgement.get('success') is True):
                                    send_count = self._record_send()
                                    with self.health_lock:
                                        if (generation is not None
                                                and generation == self.health['generation']
                                                and self.health['mavlink_connected']):
                                            self.health['http_ack'] = True
                                    backoff = INITIAL_BACKOFF_SECONDS
                                    if send_count % 10 == 0:
                                        self.logger.info('[HTTP] Sent %d telemetry packets', send_count)
                                    continue
                                reason = 'HTTP 200 without Hub success acknowledgement'
                            else:
                                reason = f'HTTP {response.status}'
                                if response.status == 429:
                                    try:
                                        retry = float(response.headers.get('Retry-After', ''))
                                        if math.isfinite(retry):
                                            delay = max(backoff, min(MAX_BACKOFF_SECONDS, retry))
                                    except (ValueError, TypeError):
                                        pass
                    except asyncio.TimeoutError:
                        reason = 'request timeout'
                    except Exception as exc:
                        self._worker_error('http', exc)
                        reason = f'request error ({type(exc).__name__})'

                    # The dequeued sample is intentionally not requeued: this is
                    # bounded live telemetry, not a durable spool/replay service.
                    self._record_failure()
                    dropped_count = self._record_drop(reason)
                    self.logger.warning(
                        '[HTTP] Transient delivery failure; sample dropped (total dropped: %d); '
                        'waiting %.1fs before sending newer samples',
                        dropped_count,
                        delay,
                    )
                    await self.wait_for_stop(delay)
                    backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

        task = loop.create_task(send_loop())
        self._set_async_worker('http', loop, task)
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            pass
        finally:
            self._health_update(http_ready=False)
            self._clear_async_worker('http')
            self._close_loop(loop)
            self.logger.info('[HTTP] HTTP worker stopped')

    def start(self, duration_seconds=None):
        """Supervise required workers; bounded tests pass only with live evidence.

        The test lasts its full window (default CLI 30s), not just until the
        first acknowledgement. A dead worker or interruption never passes.
        """
        if duration_seconds is not None:
            duration_seconds = validate_test_seconds(duration_seconds)
        self.logger.info('=' * 60)
        self.logger.info('Starting Quiver Hub Telemetry Forwarder')
        self.logger.info('=' * 60)
        self.logger.info('Hub and MAVLink endpoints configured (values omitted)')
        self.logger.info('CAN enabled: %s', self.enable_uavcan)
        if self.enable_uavcan:
            self.logger.warning(
                '[UAVCAN] Configured active node ID: %d (must be unique on this bus)',
                self.uavcan_node_id,
            )
        self.logger.info('Update Rate: %s Hz', self.update_rate_hz)
        self.logger.info('=' * 60)

        self.mavlink_thread = threading.Thread(
            target=self._run_worker, args=('mavlink', self.mavlink_worker), daemon=True)
        if self.enable_uavcan:
            self.uavcan_thread = threading.Thread(
                target=self._run_worker, args=('can', self.uavcan_worker), daemon=True)
        self.http_thread = threading.Thread(
            target=self._run_worker, args=('http', self.http_worker), daemon=True)
        workers = [('mavlink', self.mavlink_thread), ('http', self.http_thread)]
        if self.uavcan_thread:
            workers.append(('can', self.uavcan_thread))
        deadline = time.monotonic() + duration_seconds if duration_seconds is not None else None
        result = False
        worker_failed = False
        next_status = 0
        final_status = None

        try:
            for _, worker in workers:
                worker.start()
            if not self.uavcan_thread:
                self.logger.info('[UAVCAN] Disabled by ENABLE_UAVCAN or --disable-uavcan')
            self.logger.info('Workers launched; waiting for live readiness (not a health assertion)')
            while not self.stop_event.is_set():
                dead = [name for name, worker in workers if not worker.is_alive()]
                if dead:
                    self.logger.error('Required worker exited: %s', ', '.join(dead))
                    worker_failed = True
                    break
                now = time.monotonic()
                if now >= next_status:
                    self.logger.info('STATUS %s', self._status_text())
                    next_status = now + 5
                if deadline is not None and now >= deadline:
                    result = self._test_healthy()
                    final_status = self._status_text()
                    break
                self.stop_event.wait(min(0.1, max(0, deadline - now)) if deadline else 0.1)
            if deadline is None and not worker_failed:
                result = True  # Normal service shutdown is not a live-test PASS.
            elif deadline is not None and self.stop_event.is_set():
                self.logger.warning('TEST interrupted; not PASS. %s', self._status_text())
        except KeyboardInterrupt:
            self.request_stop('Keyboard interrupt received; shutting down')
            self.logger.warning('TEST interrupted; not PASS' if deadline else 'Service interrupted')
            result = deadline is None
        except Exception as error:
            self.logger.error('Runtime startup/supervision failed (%s)', type(error).__name__)
            result = False
        finally:
            if not self.stop():
                result = False
        final_health = self.health_snapshot()
        if final_health['fatal_worker_exit'] or final_health['cleanup_failed']:
            result = False
        if deadline is not None:
            if self._requested_stop:
                result = False
            self.logger.info('TEST %s %s', 'PASS' if result else 'FAIL',
                             final_status or self._status_text())
        return result

    def request_stop(self, reason='shutdown requested'):
        """Signal a graceful stop without doing thread joins from a signal handler."""
        if not self.stop_event.is_set():
            self.logger.info('%s', reason)
        self._requested_stop = True
        self.stop_event.set()

    def stop(self):
        """Stop workers gracefully, including cancellation/gather of async worker tasks."""
        self.stop_event.set()
        self._cancel_async_workers()

        current_thread = threading.current_thread()
        clean = True
        for worker_thread in (self.mavlink_thread, self.uavcan_thread, self.http_thread):
            if worker_thread and worker_thread.ident is not None and worker_thread is not current_thread:
                worker_thread.join(timeout=3)
                if worker_thread.is_alive():
                    clean = False
                    self.logger.error('Required worker did not stop within cleanup timeout')
        while True:
            try:
                self.http_queue.get_nowait()
                self._record_drop('shutdown')
            except Empty:
                break
        if self.health_snapshot()['cleanup_failed']:
            clean = False

        if not self._shutdown_reported:
            self._shutdown_reported = True
            send_count, failed_send_count, dropped_count = self._stats_snapshot()
            self.logger.info(
                'Final stats: %d sent, %d failed deliveries, %d dropped live samples',
                send_count,
                failed_send_count,
                dropped_count,
            )
            self.logger.info('Shutdown complete' if clean else 'Shutdown incomplete; not PASS')
        return clean


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
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true',
                       help='Offline config/dependency/CAN bind checks; no Hub/FC connection or workers')
    modes.add_argument('--test-run', action='store_true',
                       help='Bounded live FC/Hub/enabled-CAN readiness test; interruption is not PASS')
    parser.add_argument('--test-seconds', default='30',
                        help='Live test duration in seconds, finite 1..300 (default: 30)')
    args = parser.parse_args()

    if CONFIG_ERROR:
        parser.error('companion configuration could not be loaded; check the literal EnvironmentFile')
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
    try:
        test_seconds = validate_test_seconds(args.test_seconds)
    except ValueError as exc:
        parser.error(str(exc))
    from urllib.parse import urlsplit
    try:
        hub = urlsplit(normalize_hub_url(args.web_server_url))
        valid_hub = (hub.scheme in ('http', 'https') and hub.hostname
                     and not hub.username and not hub.password and not hub.query and not hub.fragment)
        hub.port  # Validate numeric/out-of-range ports without printing the URL.
        mavlink = urlsplit(args.mavlink_url)
        valid_mavlink = (mavlink.scheme in ('udpin', 'udpout', 'tcpin', 'tcpout')
                         and mavlink.hostname and mavlink.port is not None
                         and 1 <= mavlink.port <= 65535)
        if mavlink.scheme == 'serial':
            valid_mavlink = bool(mavlink.path and mavlink.path != '/')
        valid_mavlink = (valid_mavlink and not mavlink.username and not mavlink.password
                         and not mavlink.query and not mavlink.fragment)
    except ValueError:
        parser.error('invalid Hub or MAVLink URL/port (values omitted)')
    if not valid_hub:
        parser.error('Hub URL must be an HTTP(S) base URL without credentials, query or fragment')
    if not valid_mavlink:
        parser.error('MAVLink URL must be udpin/udpout/tcpin/tcpout host:port or serial:///device')
    if (not args.disable_uavcan
            and CONFIG.get('ENABLE_UAVCAN', 'false').strip().lower()
            not in ('1', 'true', 'yes', 'on', '0', 'false', 'no', 'off')):
        parser.error('ENABLE_UAVCAN must be true or false; use --disable-uavcan for an explicit override')
    enable_uavcan = ENABLE_UAVCAN and not args.disable_uavcan
    try:
        runtime_preflight(args.can_interface, enable_uavcan)
    except Exception as error:
        # runtime_preflight constructs only fixed, sanitized diagnostics.
        print(f'CHECK FAIL: {error}', file=sys.stderr)
        return 2
    if args.check:
        print('CHECK PASS: config/dependencies ready; offline only, not a live telemetry PASS')
        return 0

    forwarder = TelemetryForwarder(
        debug=args.debug,
        web_server_url=args.web_server_url,
        api_key=args.api_key,
        drone_id=args.drone_id,
        mavlink_url=args.mavlink_url,
        can_interface=args.can_interface,
        update_rate_hz=update_rate_hz,
        enable_uavcan=enable_uavcan,
        uavcan_node_id=uavcan_node_id,
    )

    def handle_signal(signum, _frame):
        signal_name = signal.Signals(signum).name
        forwarder.request_stop(f'{signal_name} received; shutting down gracefully')

    old_term = signal.signal(signal.SIGTERM, handle_signal)
    old_int = signal.signal(signal.SIGINT, handle_signal)
    try:
        return 0 if forwarder.start(duration_seconds=test_seconds if args.test_run else None) else 2
    finally:
        # Avoid leaving handlers referencing stopped instances in embedded tests.
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)


if __name__ == '__main__':
    raise SystemExit(main())
