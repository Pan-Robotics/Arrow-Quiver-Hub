#!/usr/bin/env python3
"""
Quiver Hub – Logs & OTA Service (Companion Computer)

Runs on the Raspberry Pi companion computer and provides:
  1. FC log scanning   – list .BIN/.log files on the FC SD card via MAVFTP
  2. FC log download   – download a specific log via MAVFTP → upload to Hub S3
  3. OTA firmware flash – download .abin from Hub → push to FC via MAVFTP
  4. System diagnostics – CPU, memory, disk, temp, services → report to Hub
  5. Remote log stream  – journalctl -f → Socket.IO to browser

Architecture:
  Pi ←→ FC (serial/Ethernet via MAVSDK/MAVFTP)
  Pi ←→ Hub (REST API + Socket.IO for real-time progress)

Job types handled (polled from Hub droneJobs queue):
  - scan_fc_logs     → list /APM/LOGS on FC SD card
  - download_fc_log  → download a specific .BIN file from FC
  - flash_firmware   → upload .abin to FC and monitor flash stages

Usage:
    python3 logs_ota_service.py \\
        --hub-url https://your-hub.manus.space \\
        --drone-id quiver_001 \\
        --api-key YOUR_API_KEY \\
        --fc-connection serial:///dev/ttyAMA1:921600

Dependencies:
    pip install --break-system-packages mavsdk aiohttp python-socketio[asyncio_client] psutil requests
"""

import argparse
import asyncio
import base64
import json
import logging
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

# Optional imports with graceful fallback
try:
    import requests
except ImportError:
    requests = None

try:
    import psutil
except ImportError:
    psutil = None

try:
    import socketio
except ImportError:
    socketio = None

try:
    from mavsdk import System
    from mavsdk.ftp import FtpResult
except ImportError:
    System = None
    FtpResult = None

# ─── Logging ────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("logs_ota")


# ─── Hub REST Client ────────────────────────────────────────────────────────

class HubClient:
    """
    REST client for communicating with Quiver Hub.
    Uses the same tRPC + REST API pattern as raspberry_pi_client.py.
    """

    def __init__(self, hub_url: str, drone_id: str, api_key: str):
        self.hub_url = hub_url.rstrip("/")
        self.drone_id = drone_id
        self.api_key = api_key
        self.session = requests.Session() if requests else None

    # ── tRPC helpers ─────────────────────────────────────────────────────

    def _trpc_query(self, procedure: str, input_data: dict) -> Optional[dict]:
        """Call a tRPC query endpoint (GET)."""
        if not self.session:
            logger.error("requests library not installed")
            return None
        try:
            url = f"{self.hub_url}/api/trpc/{procedure}"
            params = {"input": json.dumps({"json": input_data})}
            resp = self.session.get(url, params=params, timeout=15)
            resp.raise_for_status()
            return resp.json().get("result", {}).get("data", {}).get("json")
        except Exception as e:
            logger.error(f"tRPC query {procedure} failed: {e}")
            return None

    def _trpc_mutation(self, procedure: str, input_data: dict) -> Optional[dict]:
        """Call a tRPC mutation endpoint (POST)."""
        if not self.session:
            logger.error("requests library not installed")
            return None
        try:
            url = f"{self.hub_url}/api/trpc/{procedure}"
            resp = self.session.post(url, json={"json": input_data}, timeout=15)
            resp.raise_for_status()
            return resp.json().get("result", {}).get("data", {}).get("json")
        except Exception as e:
            logger.error(f"tRPC mutation {procedure} failed: {e}")
            return None

    def _rest_post(self, path: str, data: dict, timeout: int = 30) -> Optional[dict]:
        """Call a REST POST endpoint."""
        if not self.session:
            logger.error("requests library not installed")
            return None
        try:
            url = f"{self.hub_url}/api/rest/{path}"
            resp = self.session.post(url, json=data, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"REST POST {path} failed: {e}")
            return None

    # ── Job polling ──────────────────────────────────────────────────────

    def get_pending_jobs(self) -> List[dict]:
        """Fetch pending jobs from the Hub."""
        result = self._trpc_query("droneJobs.getPendingJobs", {
            "droneId": self.drone_id,
            "apiKey": self.api_key,
        })
        if result:
            return result.get("jobs", [])
        return []

    def acknowledge_job(self, job_id: int) -> bool:
        result = self._trpc_mutation("droneJobs.acknowledgeJob", {
            "jobId": job_id,
            "apiKey": self.api_key,
            "droneId": self.drone_id,
        })
        return result is not None

    def complete_job(self, job_id: int, success: bool, error_message: Optional[str] = None) -> bool:
        data: dict = {
            "jobId": job_id,
            "apiKey": self.api_key,
            "droneId": self.drone_id,
            "success": success,
        }
        if error_message is not None:
            data["errorMessage"] = error_message
        result = self._trpc_mutation("droneJobs.completeJob", data)
        return result is not None

    # ── FC log endpoints ─────────────────────────────────────────────────

    def report_fc_log_list(self, logs: List[dict]) -> bool:
        """Report discovered FC log files to the Hub."""
        result = self._rest_post("logs/fc-list", {
            "api_key": self.api_key,
            "drone_id": self.drone_id,
            "logs": logs,
        })
        return result is not None and result.get("success", False)

    def report_fc_log_progress(self, log_id: int, status: str, progress: int,
                                error_message: Optional[str] = None) -> bool:
        """Report FC log download progress."""
        result = self._rest_post("logs/fc-progress", {
            "api_key": self.api_key,
            "drone_id": self.drone_id,
            "log_id": log_id,
            "status": status,
            "progress": progress,
            "error_message": error_message,
        })
        return result is not None and result.get("success", False)

    def upload_fc_log(self, log_id: int, filename: str,
                       content: bytes, file_size: int) -> Optional[str]:
        """Upload a downloaded FC log file to the Hub (base64 encoded)."""
        encoded = base64.b64encode(content).decode("ascii")
        result = self._rest_post("logs/fc-upload", {
            "api_key": self.api_key,
            "drone_id": self.drone_id,
            "log_id": log_id,
            "filename": filename,
            "content": encoded,
            "file_size": file_size,
        }, timeout=120)  # Large files need more time
        if result and result.get("success"):
            return result.get("url")
        return None

    # ── Firmware endpoints ───────────────────────────────────────────────

    def report_firmware_progress(self, update_id: int, status: str,
                                  progress: int, flash_stage: Optional[str] = None,
                                  error_message: Optional[str] = None) -> bool:
        """Report firmware flash progress."""
        data: dict = {
            "api_key": self.api_key,
            "drone_id": self.drone_id,
            "update_id": update_id,
            "status": status,
            "progress": progress,
        }
        if flash_stage:
            data["flash_stage"] = flash_stage
        if error_message:
            data["error_message"] = error_message
        result = self._rest_post("firmware/progress", data)
        return result is not None and result.get("success", False)

    # ── Diagnostics ──────────────────────────────────────────────────────

    def report_diagnostics(self, diag: dict) -> bool:
        """Report system diagnostics snapshot."""
        result = self._rest_post("diagnostics/report", {
            "api_key": self.api_key,
            "drone_id": self.drone_id,
            **diag,
        })
        return result is not None and result.get("success", False)


# ─── MAVFTP Operations ──────────────────────────────────────────────────────

class MavFtpClient:
    """
    Wraps MAVSDK FTP plugin for file operations on the flight controller.
    
    MAVSDK's FTP plugin provides:
      - list_directory()  → list files in a directory
      - download()        → download a file from FC to local path
      - upload()          → upload a file from local path to FC
      - rename()          → rename a file on FC
      - remove_file()     → delete a file on FC
    
    ArduPilot MAVFTP paths:
      - /APM/LOGS/         → flight logs (.BIN files)
      - /APM/              → root of the SD card
      - @ROMFS/            → read-only filesystem (parameters, scripts)
    
    Firmware flash convention:
      1. Upload firmware as  ardupilot.abin  to /APM/
      2. FC renames to       ardupilot-verify.abin  (CRC check)
      3. FC renames to       ardupilot-flash.abin   (flashing)
      4. FC renames to       ardupilot-flashed.abin (success)
      If any stage fails, the file may remain or be deleted.
    """

    def __init__(self, connection_string: str):
        self.connection_string = connection_string
        self.system: Optional[Any] = None
        self._connected = False

    async def connect(self) -> bool:
        """Connect to the flight controller via MAVSDK."""
        if System is None:
            logger.error("MAVSDK not installed. Run: pip install mavsdk")
            return False

        try:
            self.system = System()
            logger.info(f"Connecting to FC: {self.connection_string}")
            await self.system.connect(system_address=self.connection_string)

            # Wait for connection with timeout
            logger.info("Waiting for FC heartbeat...")
            async for state in self.system.core.connection_state():
                if state.is_connected:
                    logger.info("Connected to flight controller")
                    self._connected = True
                    break
            return True
        except Exception as e:
            logger.error(f"Failed to connect to FC: {e}")
            return False

    @property
    def connected(self) -> bool:
        return self._connected and self.system is not None

    async def list_directory(self, remote_path: str) -> List[dict]:
        """
        List files in a directory on the FC SD card.
        
        Returns list of dicts: [{"name": "00000042.BIN", "size": 1234567, "type": "file"}, ...]
        """
        if not self.connected:
            raise RuntimeError("Not connected to FC")

        try:
            result = await self.system.ftp.list_directory(remote_path)
            entries = []
            for entry in result:
                # MAVSDK returns entries like "Ffilename\tsize" for files
                # and "Ddirname" for directories
                entry_str = str(entry)
                if entry_str.startswith("F"):
                    # File entry: "Ffilename\tsize"
                    parts = entry_str[1:].split("\t")
                    name = parts[0]
                    size = int(parts[1]) if len(parts) > 1 else 0
                    entries.append({
                        "name": name,
                        "size": size,
                        "type": "file",
                    })
                elif entry_str.startswith("D"):
                    entries.append({
                        "name": entry_str[1:].split("\t")[0],
                        "size": 0,
                        "type": "directory",
                    })
                elif entry_str.startswith("S"):
                    # Skip entry (. and ..)
                    pass
            return entries
        except Exception as e:
            logger.error(f"Failed to list directory {remote_path}: {e}")
            raise

    async def download_file(self, remote_path: str, local_path: str,
                             progress_callback=None) -> bool:
        """
        Download a file from the FC via MAVFTP.
        
        Args:
            remote_path: Path on FC (e.g., /APM/LOGS/00000042.BIN)
            local_path: Local path to save the file
            progress_callback: async callable(bytes_downloaded, total_bytes)
        """
        if not self.connected:
            raise RuntimeError("Not connected to FC")

        try:
            logger.info(f"Downloading {remote_path} → {local_path}")
            
            # MAVSDK download with progress reporting
            progress = await self.system.ftp.download(
                remote_path, local_path
            )
            
            # The download is complete when we get here
            if os.path.exists(local_path):
                file_size = os.path.getsize(local_path)
                logger.info(f"Download complete: {file_size} bytes")
                if progress_callback:
                    await progress_callback(file_size, file_size)
                return True
            else:
                logger.error("Download completed but file not found")
                return False

        except Exception as e:
            logger.error(f"MAVFTP download failed for {remote_path}: {e}")
            raise

    async def upload_file(self, local_path: str, remote_path: str,
                           progress_callback=None) -> bool:
        """
        Upload a file to the FC via MAVFTP.
        
        Args:
            local_path: Local file path
            remote_path: Destination path on FC (e.g., /APM/ardupilot.abin)
            progress_callback: async callable(bytes_uploaded, total_bytes)
        """
        if not self.connected:
            raise RuntimeError("Not connected to FC")

        try:
            file_size = os.path.getsize(local_path)
            logger.info(f"Uploading {local_path} → {remote_path} ({file_size} bytes)")

            await self.system.ftp.upload(local_path, remote_path)

            logger.info("Upload complete")
            if progress_callback:
                await progress_callback(file_size, file_size)
            return True

        except Exception as e:
            logger.error(f"MAVFTP upload failed: {e}")
            raise

    async def file_exists(self, remote_path: str) -> bool:
        """Check if a file exists on the FC by listing its parent directory."""
        try:
            parent = "/".join(remote_path.rstrip("/").split("/")[:-1]) or "/"
            filename = remote_path.rstrip("/").split("/")[-1]
            entries = await self.list_directory(parent)
            return any(e["name"] == filename for e in entries)
        except Exception:
            return False

    async def remove_file(self, remote_path: str) -> bool:
        """Remove a file on the FC."""
        if not self.connected:
            raise RuntimeError("Not connected to FC")
        try:
            await self.system.ftp.remove_file(remote_path)
            return True
        except Exception as e:
            logger.error(f"Failed to remove {remote_path}: {e}")
            return False


# ─── Job Handlers ────────────────────────────────────────────────────────────

class LogsOtaJobHandler:
    """
    Handles scan_fc_logs, download_fc_log, and flash_firmware jobs.
    """

    def __init__(self, hub: HubClient, ftp: MavFtpClient, log_path: str = "/APM/LOGS"):
        self.hub = hub
        self.ftp = ftp
        self.log_path = log_path

    async def handle_scan_fc_logs(self, job: dict) -> Tuple[bool, Optional[str]]:
        """
        Scan the FC SD card for .BIN/.log files and report them to the Hub.
        """
        payload = job.get("payload", {})
        scan_path = payload.get("logPath", self.log_path)

        try:
            logger.info(f"Scanning FC logs at {scan_path}")
            entries = await self.ftp.list_directory(scan_path)

            log_files = []
            for entry in entries:
                name = entry["name"]
                if entry["type"] == "file" and (
                    name.upper().endswith(".BIN") or name.lower().endswith(".log")
                ):
                    log_files.append({
                        "remote_path": f"{scan_path}/{name}",
                        "filename": name,
                        "file_size": entry.get("size", 0),
                    })

            logger.info(f"Found {len(log_files)} log file(s)")

            if log_files:
                self.hub.report_fc_log_list(log_files)

            return True, None

        except Exception as e:
            error_msg = f"FC log scan failed: {e}"
            logger.error(error_msg)
            return False, error_msg

    async def handle_download_fc_log(self, job: dict) -> Tuple[bool, Optional[str]]:
        """
        Download a specific FC log file and upload it to the Hub.
        """
        payload = job.get("payload", {})
        log_id = payload.get("logId")
        remote_path = payload.get("remotePath")

        if not log_id or not remote_path:
            return False, "Missing logId or remotePath in job payload"

        filename = remote_path.split("/")[-1]

        try:
            # Report downloading status
            self.hub.report_fc_log_progress(log_id, "downloading", 0)

            # Download to temp file
            with tempfile.NamedTemporaryFile(suffix=f"_{filename}", delete=False) as tmp:
                tmp_path = tmp.name

            try:
                async def progress_cb(downloaded: int, total: int):
                    if total > 0:
                        pct = min(int(downloaded / total * 80), 80)  # 0-80% for download
                        self.hub.report_fc_log_progress(log_id, "downloading", pct)

                await self.ftp.download_file(remote_path, tmp_path, progress_cb)

                # Read the downloaded file
                file_size = os.path.getsize(tmp_path)
                logger.info(f"Downloaded {filename}: {file_size} bytes")

                # Report uploading status
                self.hub.report_fc_log_progress(log_id, "uploading", 85)

                # Read file content and upload to Hub
                with open(tmp_path, "rb") as f:
                    content = f.read()

                url = self.hub.upload_fc_log(log_id, filename, content, file_size)

                if url:
                    logger.info(f"Uploaded {filename} to Hub: {url}")
                    return True, None
                else:
                    error_msg = "Failed to upload log to Hub"
                    self.hub.report_fc_log_progress(log_id, "failed", 0, error_msg)
                    return False, error_msg

            finally:
                # Clean up temp file
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        except Exception as e:
            error_msg = f"FC log download failed: {e}"
            logger.error(error_msg)
            self.hub.report_fc_log_progress(log_id, "failed", 0, error_msg)
            return False, error_msg

    async def handle_flash_firmware(self, job: dict) -> Tuple[bool, Optional[str]]:
        """
        Download firmware from Hub, upload to FC via MAVFTP, and monitor flash stages.
        
        ArduPilot OTA flash process:
          1. Upload ardupilot.abin to /APM/ on the FC SD card
          2. FC renames to ardupilot-verify.abin (CRC verification)
          3. FC renames to ardupilot-flash.abin (flashing to internal flash)
          4. FC renames to ardupilot-flashed.abin (success, FC reboots)
          
        If any stage fails, the file may remain or be deleted.
        We poll for stage file existence to track progress.
        """
        payload = job.get("payload", {})
        update_id = payload.get("updateId")
        firmware_url = payload.get("firmwareUrl")
        firmware_filename = payload.get("filename", "arducopter.abin")

        if not update_id or not firmware_url:
            return False, "Missing updateId or firmwareUrl in job payload"

        try:
            # ── Step 1: Download firmware from Hub ──
            self.hub.report_firmware_progress(update_id, "transferring", 5,
                                               flash_stage="downloading")
            logger.info(f"Downloading firmware from: {firmware_url}")

            with tempfile.NamedTemporaryFile(suffix=".abin", delete=False) as tmp:
                tmp_path = tmp.name

            try:
                resp = requests.get(firmware_url, timeout=120)
                resp.raise_for_status()
                with open(tmp_path, "wb") as f:
                    f.write(resp.content)

                file_size = os.path.getsize(tmp_path)
                logger.info(f"Downloaded firmware: {file_size} bytes")

                # ── Step 2: Remove any existing ardupilot*.abin files ──
                self.hub.report_firmware_progress(update_id, "transferring", 10,
                                                   flash_stage="preparing")
                for old_name in [
                    "ardupilot.abin",
                    "ardupilot-verify.abin",
                    "ardupilot-flash.abin",
                    "ardupilot-flashed.abin",
                ]:
                    if await self.ftp.file_exists(f"/APM/{old_name}"):
                        logger.info(f"Removing old {old_name}")
                        await self.ftp.remove_file(f"/APM/{old_name}")

                # ── Step 3: Upload firmware to FC as ardupilot.abin ──
                self.hub.report_firmware_progress(update_id, "transferring", 20,
                                                   flash_stage="uploading")

                async def upload_progress(uploaded: int, total: int):
                    if total > 0:
                        pct = 20 + int(uploaded / total * 40)  # 20-60%
                        self.hub.report_firmware_progress(
                            update_id, "transferring", pct,
                            flash_stage="uploading"
                        )

                await self.ftp.upload_file(tmp_path, "/APM/ardupilot.abin",
                                            upload_progress)

                logger.info("Firmware uploaded to FC as ardupilot.abin")

                # ── Step 4: Monitor flash stages ──
                self.hub.report_firmware_progress(update_id, "flashing", 65,
                                                   flash_stage="ardupilot.abin")

                # Poll for stage transitions
                max_wait = 300  # 5 minutes max for flash
                poll_interval = 2
                elapsed = 0

                stages = [
                    ("ardupilot-verify.abin", "verifying", 70),
                    ("ardupilot-flash.abin", "flashing", 80),
                    ("ardupilot-flashed.abin", "completed", 100),
                ]

                current_stage_idx = 0

                while elapsed < max_wait and current_stage_idx < len(stages):
                    await asyncio.sleep(poll_interval)
                    elapsed += poll_interval

                    stage_file, stage_status, stage_pct = stages[current_stage_idx]

                    try:
                        if await self.ftp.file_exists(f"/APM/{stage_file}"):
                            logger.info(f"Flash stage: {stage_file}")
                            self.hub.report_firmware_progress(
                                update_id, stage_status, stage_pct,
                                flash_stage=stage_file
                            )

                            if stage_status == "completed":
                                logger.info("Firmware flash completed successfully!")
                                return True, None

                            current_stage_idx += 1
                    except Exception as poll_err:
                        # FC may reboot during flash, causing connection loss
                        logger.warning(f"Stage poll error (FC may be rebooting): {poll_err}")
                        # If we were at the flash stage and lost connection,
                        # the FC is likely rebooting with new firmware
                        if current_stage_idx >= 2:
                            logger.info("FC likely rebooting with new firmware")
                            self.hub.report_firmware_progress(
                                update_id, "completed", 100,
                                flash_stage="rebooting"
                            )
                            return True, None
                        await asyncio.sleep(5)
                        elapsed += 5

                    # Check if the original file was consumed (FC started processing)
                    if elapsed > 30 and current_stage_idx == 0:
                        try:
                            if not await self.ftp.file_exists("/APM/ardupilot.abin"):
                                # File was consumed but no stage file appeared
                                # This could mean the FC rejected the firmware
                                error_msg = "Firmware file consumed but no stage transition detected"
                                logger.error(error_msg)
                                self.hub.report_firmware_progress(
                                    update_id, "failed", 0, error_message=error_msg
                                )
                                return False, error_msg
                        except Exception:
                            pass

                if elapsed >= max_wait:
                    error_msg = "Firmware flash timed out after 5 minutes"
                    logger.error(error_msg)
                    self.hub.report_firmware_progress(
                        update_id, "failed", 0, error_message=error_msg
                    )
                    return False, error_msg

                return True, None

            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        except Exception as e:
            error_msg = f"Firmware flash failed: {e}"
            logger.error(error_msg)
            self.hub.report_firmware_progress(
                update_id, "failed", 0, error_message=error_msg
            )
            return False, error_msg


# ─── System Diagnostics Collector ────────────────────────────────────────────

class DiagnosticsCollector:
    """
    Collects system health metrics from the Raspberry Pi.
    Reports CPU, memory, disk, temperature, and service status.
    """

    # Services to monitor (systemd unit names)
    MONITORED_SERVICES = [
        "camera-stream.service",
        "siyi-camera.service",
        "logs-ota.service",
        "quiver-hub-client.service",
    ]

    def collect(self) -> dict:
        """Collect a system diagnostics snapshot."""
        diag: dict = {}

        # CPU usage
        if psutil:
            try:
                diag["cpu_percent"] = int(psutil.cpu_percent(interval=1))
            except Exception:
                pass

            # Memory usage
            try:
                mem = psutil.virtual_memory()
                diag["memory_percent"] = int(mem.percent)
            except Exception:
                pass

            # Disk usage
            try:
                disk = psutil.disk_usage("/")
                diag["disk_percent"] = int(disk.percent)
            except Exception:
                pass

            # CPU temperature
            try:
                temps = psutil.sensors_temperatures()
                if "cpu_thermal" in temps:
                    diag["cpu_temp_c"] = int(temps["cpu_thermal"][0].current)
                elif "coretemp" in temps:
                    diag["cpu_temp_c"] = int(temps["coretemp"][0].current)
            except Exception:
                pass

            # Uptime
            try:
                diag["uptime_seconds"] = int(time.time() - psutil.boot_time())
            except Exception:
                pass

            # Network interfaces
            try:
                net = psutil.net_io_counters(pernic=True)
                addrs = psutil.net_if_addrs()
                network = {}
                for iface, counters in net.items():
                    if iface == "lo":
                        continue
                    ip = ""
                    if iface in addrs:
                        for addr in addrs[iface]:
                            if addr.family.name == "AF_INET":
                                ip = addr.address
                                break
                    network[iface] = {
                        "ip": ip,
                        "rx_bytes": counters.bytes_recv,
                        "tx_bytes": counters.bytes_sent,
                    }
                diag["network"] = network
            except Exception:
                pass
        else:
            # Fallback without psutil
            try:
                load = os.getloadavg()
                # Approximate CPU % from 1-min load average
                cpu_count = os.cpu_count() or 1
                diag["cpu_percent"] = min(int(load[0] / cpu_count * 100), 100)
            except Exception:
                pass

            # Temperature from sysfs (Raspberry Pi)
            try:
                with open("/sys/class/thermal/thermal_zone0/temp") as f:
                    diag["cpu_temp_c"] = int(f.read().strip()) // 1000
            except Exception:
                pass

        # Service statuses via systemctl
        services = {}
        for svc in self.MONITORED_SERVICES:
            try:
                result = subprocess.run(
                    ["systemctl", "is-active", svc],
                    capture_output=True, text=True, timeout=5
                )
                status = result.stdout.strip()
                services[svc.replace(".service", "")] = status
            except Exception:
                services[svc.replace(".service", "")] = "unknown"
        diag["services"] = services

        return diag


# ─── Remote Log Streamer ────────────────────────────────────────────────────

class RemoteLogStreamer:
    """
    Streams journalctl output to the Hub via Socket.IO.
    
    When the browser requests a log stream for a specific service,
    this class spawns `journalctl -f -u <service>` and pipes lines
    to the Hub which broadcasts them to the browser.
    """

    def __init__(self, sio_client, drone_id: str):
        self.sio = sio_client
        self.drone_id = drone_id
        self._active_streams: Dict[str, asyncio.subprocess.Process] = {}

    async def start_stream(self, service: str, lines: int = 50):
        """Start streaming logs for a service."""
        if service in self._active_streams:
            logger.info(f"Stream already active for {service}")
            return

        logger.info(f"Starting log stream for {service} (last {lines} lines)")

        try:
            proc = await asyncio.create_subprocess_exec(
                "journalctl", "-f", "-u", service, "-n", str(lines),
                "--no-pager", "-o", "short-iso",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._active_streams[service] = proc

            # Read lines in background
            asyncio.create_task(self._read_stream(service, proc))

        except Exception as e:
            logger.error(f"Failed to start log stream for {service}: {e}")

    async def stop_stream(self, service: str):
        """Stop streaming logs for a service."""
        proc = self._active_streams.pop(service, None)
        if proc:
            logger.info(f"Stopping log stream for {service}")
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
            except Exception:
                pass

    async def stop_all(self):
        """Stop all active streams."""
        for service in list(self._active_streams.keys()):
            await self.stop_stream(service)

    async def _read_stream(self, service: str, proc: asyncio.subprocess.Process):
        """Read lines from journalctl and emit via Socket.IO."""
        try:
            buffer: List[str] = []
            flush_interval = 0.5  # Batch lines every 500ms

            async def flush():
                nonlocal buffer
                if buffer and self.sio and self.sio.connected:
                    await self.sio.emit("log_stream_line", {
                        "drone_id": self.drone_id,
                        "service": service,
                        "lines": buffer,
                    })
                    buffer = []

            last_flush = time.time()

            while service in self._active_streams:
                try:
                    line = await asyncio.wait_for(
                        proc.stdout.readline(), timeout=flush_interval
                    )
                    if not line:
                        break
                    buffer.append(line.decode("utf-8", errors="replace").rstrip())

                    # Flush if buffer is large or enough time has passed
                    now = time.time()
                    if len(buffer) >= 20 or (now - last_flush) >= flush_interval:
                        await flush()
                        last_flush = now

                except asyncio.TimeoutError:
                    await flush()
                    last_flush = time.time()

            # Final flush
            await flush()

        except Exception as e:
            logger.error(f"Log stream error for {service}: {e}")
        finally:
            self._active_streams.pop(service, None)


# ─── Main Service ────────────────────────────────────────────────────────────

class LogsOtaService:
    """
    Main service orchestrator. Manages:
      - MAVSDK connection to FC
      - Job polling from Hub
      - System diagnostics reporting
      - Socket.IO connection for real-time events
      - Remote log streaming
    """

    def __init__(self, hub_url: str, drone_id: str, api_key: str,
                 fc_connection: str, poll_interval: int = 5,
                 diagnostics_interval: int = 10):
        self.hub = HubClient(hub_url, drone_id, api_key)
        self.ftp = MavFtpClient(fc_connection)
        self.job_handler = LogsOtaJobHandler(self.hub, self.ftp)
        self.diagnostics = DiagnosticsCollector()
        self.drone_id = drone_id
        self.hub_url = hub_url
        self.api_key = api_key
        self.poll_interval = poll_interval
        self.diagnostics_interval = diagnostics_interval
        self.running = False
        self.sio = None
        self.log_streamer = None
        self._fc_connected = False

    async def connect_fc(self) -> bool:
        """Connect to the flight controller."""
        try:
            success = await self.ftp.connect()
            self._fc_connected = success
            return success
        except Exception as e:
            logger.error(f"FC connection failed: {e}")
            self._fc_connected = False
            return False

    async def _setup_socketio(self):
        """Set up Socket.IO connection for real-time events."""
        if socketio is None:
            logger.warning("python-socketio not installed, skipping real-time features")
            return

        self.sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_attempts=0,  # Infinite
            reconnection_delay=5,
            logger=False,
            engineio_logger=False,
        )

        self.log_streamer = RemoteLogStreamer(self.sio, self.drone_id)

        @self.sio.event
        async def connect():
            logger.info("Connected to Hub via Socket.IO")
            await self.sio.emit("register_companion", {
                "droneId": self.drone_id,
                "type": "logs_ota",
            })

        @self.sio.event
        async def disconnect():
            logger.warning("Disconnected from Hub Socket.IO")

        @self.sio.on("log_stream_request")
        async def on_log_stream_request(data):
            """Handle log stream start/stop requests from browser."""
            service = data.get("service", "")
            action = data.get("action", "")
            lines = data.get("lines", 50)

            logger.info(f"Log stream request: {action} {service}")

            if action == "start":
                await self.log_streamer.start_stream(service, lines)
            elif action == "stop":
                await self.log_streamer.stop_stream(service)

        # Connect to Hub
        hub_http = self.hub_url.rstrip("/")
        try:
            await self.sio.connect(hub_http, transports=["websocket"])
        except Exception as e:
            logger.error(f"Socket.IO connection failed: {e}")

    async def _job_poll_loop(self):
        """Poll for and execute pending jobs."""
        while self.running:
            try:
                jobs = self.hub.get_pending_jobs()

                for job in jobs:
                    job_id = job.get("id")
                    job_type = job.get("type", "")

                    # Only handle logs/OTA job types
                    if job_type not in ("scan_fc_logs", "download_fc_log", "flash_firmware"):
                        continue

                    logger.info(f"Processing job {job_id}: {job_type}")

                    # Acknowledge
                    if not self.hub.acknowledge_job(job_id):
                        logger.error(f"Failed to acknowledge job {job_id}")
                        continue

                    # Check FC connection for MAVFTP jobs
                    if not self._fc_connected:
                        logger.warning("FC not connected, attempting reconnection...")
                        if not await self.connect_fc():
                            self.hub.complete_job(job_id, False, "FC not connected")
                            continue

                    # Execute
                    success = False
                    error_msg = None

                    try:
                        if job_type == "scan_fc_logs":
                            success, error_msg = await self.job_handler.handle_scan_fc_logs(job)
                        elif job_type == "download_fc_log":
                            success, error_msg = await self.job_handler.handle_download_fc_log(job)
                        elif job_type == "flash_firmware":
                            success, error_msg = await self.job_handler.handle_flash_firmware(job)
                    except Exception as e:
                        error_msg = f"Job execution error: {e}"
                        logger.error(error_msg)

                    # Report completion
                    self.hub.complete_job(job_id, success, error_msg)

            except Exception as e:
                logger.error(f"Job poll error: {e}")

            await asyncio.sleep(self.poll_interval)

    async def _diagnostics_loop(self):
        """Periodically collect and report system diagnostics."""
        while self.running:
            try:
                diag = self.diagnostics.collect()
                self.hub.report_diagnostics(diag)
                logger.debug(f"Diagnostics reported: CPU={diag.get('cpu_percent')}% "
                             f"MEM={diag.get('memory_percent')}% "
                             f"TEMP={diag.get('cpu_temp_c')}°C")
            except Exception as e:
                logger.error(f"Diagnostics error: {e}")

            await asyncio.sleep(self.diagnostics_interval)

    async def run(self):
        """Main entry point — run all service loops."""
        self.running = True
        logger.info("=" * 60)
        logger.info("Quiver Hub – Logs & OTA Service starting")
        logger.info(f"  Drone ID:    {self.drone_id}")
        logger.info(f"  Hub URL:     {self.hub_url}")
        logger.info(f"  FC:          {self.ftp.connection_string}")
        logger.info(f"  Poll:        {self.poll_interval}s")
        logger.info(f"  Diagnostics: {self.diagnostics_interval}s")
        logger.info("=" * 60)

        # Connect to FC (non-blocking — jobs will retry if not connected)
        asyncio.create_task(self._initial_fc_connect())

        # Set up Socket.IO for real-time features
        await self._setup_socketio()

        # Start background loops
        tasks = [
            asyncio.create_task(self._job_poll_loop()),
            asyncio.create_task(self._diagnostics_loop()),
        ]

        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            pass
        finally:
            # Cleanup
            if self.log_streamer:
                await self.log_streamer.stop_all()
            if self.sio and self.sio.connected:
                await self.sio.disconnect()

    async def _initial_fc_connect(self):
        """Try to connect to FC on startup, with retries."""
        retry_delay = 5
        max_retries = 12  # 1 minute of retries
        for attempt in range(max_retries):
            if not self.running:
                return
            logger.info(f"FC connection attempt {attempt + 1}/{max_retries}...")
            if await self.connect_fc():
                return
            await asyncio.sleep(retry_delay)
        logger.warning("Could not connect to FC after retries. "
                        "Jobs requiring MAVFTP will fail until FC is available.")

    def stop(self):
        """Signal the service to stop."""
        logger.info("Shutdown requested")
        self.running = False


# ─── CLI Entry Point ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Quiver Hub – Logs & OTA Service (Companion Computer)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Serial connection (TELEM port at 921600 baud)
  python3 logs_ota_service.py \\
      --hub-url https://your-hub.manus.space \\
      --drone-id quiver_001 \\
      --api-key YOUR_KEY \\
      --fc-connection serial:///dev/ttyAMA1:921600

  # Ethernet connection (preferred — faster MAVFTP)
  python3 logs_ota_service.py \\
      --hub-url https://your-hub.manus.space \\
      --drone-id quiver_001 \\
      --api-key YOUR_KEY \\
      --fc-connection udp://:14540

  # Diagnostics only (no FC connection)
  python3 logs_ota_service.py \\
      --hub-url https://your-hub.manus.space \\
      --drone-id quiver_001 \\
      --api-key YOUR_KEY \\
      --no-fc
        """,
    )

    parser.add_argument("--hub-url", required=True,
                        help="Quiver Hub URL (e.g., https://your-hub.manus.space)")
    parser.add_argument("--drone-id", required=True,
                        help="Drone identifier (e.g., quiver_001)")
    parser.add_argument("--api-key", required=True,
                        help="API key for Hub authentication")
    parser.add_argument("--fc-connection", default="serial:///dev/ttyAMA1:921600",
                        help="MAVSDK connection string (default: serial:///dev/ttyAMA1:921600)")
    parser.add_argument("--poll-interval", type=int, default=5,
                        help="Job polling interval in seconds (default: 5)")
    parser.add_argument("--diagnostics-interval", type=int, default=10,
                        help="Diagnostics reporting interval in seconds (default: 10)")
    parser.add_argument("--no-fc", action="store_true",
                        help="Run without FC connection (diagnostics + log streaming only)")
    parser.add_argument("--debug", action="store_true",
                        help="Enable debug logging")

    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logging.getLogger("mavsdk").setLevel(logging.DEBUG)

    # Validate dependencies
    if not requests:
        logger.error("requests library not installed. Run: pip install requests")
        sys.exit(1)

    service = LogsOtaService(
        hub_url=args.hub_url,
        drone_id=args.drone_id,
        api_key=args.api_key,
        fc_connection=args.fc_connection if not args.no_fc else "",
        poll_interval=args.poll_interval,
        diagnostics_interval=args.diagnostics_interval,
    )

    # Handle signals
    def signal_handler(sig, frame):
        service.stop()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # If --no-fc, skip FC connection
    if args.no_fc:
        service._fc_connected = False
        logger.info("Running without FC connection (--no-fc)")

    try:
        asyncio.run(service.run())
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        service.stop()


if __name__ == "__main__":
    main()
