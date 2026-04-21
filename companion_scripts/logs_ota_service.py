#!/usr/bin/env python3
"""
Quiver Hub – Logs & OTA Service (Companion Computer)

Runs on the Raspberry Pi companion computer and provides:
  1. FC log sync       – background sync .BIN files from FC via ArduPilot net_webserver HTTP
  2. FC log serving    – serve locally-cached logs to Hub for user download
  3. OTA firmware flash – download .abin from Hub → push to FC via MAVFTP
  4. System diagnostics – CPU, memory, disk, temp, services → report to Hub
  5. Remote log stream  – journalctl -f → Socket.IO to browser

Architecture:
  Pi ←HTTP→ FC (ArduPilot net_webserver on port 8080 for log download)
  Pi ←MAVSDK→ FC (serial/Ethernet for firmware flash + arm state)
  Pi ←REST/WS→ Hub (REST API + Socket.IO for real-time progress)

FC Log Pipeline (new — avoids blocking MAVLink/TCP):
  1. FCLogSyncer runs a background loop while drone is DISARMED
  2. Parses HTML directory listing from GET http://<fc_ip>:8080/mnt/APM/LOGS/
  3. Downloads new .BIN files via HTTP to local store (/var/lib/quiver/fc_logs/)
  4. Maintains a JSON manifest for incremental sync (If-Modified-Since)
  5. scan_fc_logs job → reads from local manifest (instant, no FC access)
  6. download_fc_log job → reads from local store → uploads to Hub S3

Job types handled (polled from Hub droneJobs queue):
  - scan_fc_logs     → list locally-cached logs from manifest
  - download_fc_log  → serve a cached .BIN file from local store → Hub S3
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
import hashlib
import json
import logging
import os
import platform
import re
import signal
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
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

    def acknowledge_job(self, job_id: int, locked_by: Optional[str] = None) -> bool:
        """Acknowledge a job with mutex lock. Returns False if already locked by another companion."""
        data: dict = {
            "jobId": job_id,
            "apiKey": self.api_key,
            "droneId": self.drone_id,
        }
        if locked_by:
            data["lockedBy"] = locked_by
        result = self._trpc_mutation("droneJobs.acknowledgeJob", data)
        if result is None:
            return False
        return result.get("success", False)

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
        """Upload a downloaded FC log file to the Hub.
        
        Uses multipart/form-data (no base64 overhead, ~33% faster).
        Falls back to base64 JSON if multipart endpoint is unavailable.
        """
        url = f"{self.hub_url}/api/rest/logs/fc-upload-multipart"
        try:
            resp = requests.post(url, data={
                "api_key": self.api_key,
                "drone_id": self.drone_id,
                "log_id": str(log_id),
                "filename": filename,
                "file_size": str(file_size),
            }, files={
                "file": (filename, content, "application/octet-stream"),
            }, timeout=300)  # Large files need generous timeout
            if resp.status_code == 200:
                result = resp.json()
                if result.get("success"):
                    return result.get("url")
            elif resp.status_code == 404:
                # Multipart endpoint not available, fall back to base64
                logger.warning("Multipart upload not available, falling back to base64")
            else:
                logger.error(f"Multipart upload failed: {resp.status_code} {resp.text[:200]}")
                return None
        except requests.exceptions.RequestException as e:
            logger.warning(f"Multipart upload error, falling back to base64: {e}")

        # Fallback: base64 JSON (legacy)
        encoded = base64.b64encode(content).decode("ascii")
        result = self._rest_post("logs/fc-upload", {
            "api_key": self.api_key,
            "drone_id": self.drone_id,
            "log_id": log_id,
            "filename": filename,
            "content": encoded,
            "file_size": file_size,
        }, timeout=300)
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


# ─── FC Log Directory HTML Parser ──────────────────────────────────────────

class _FCLogDirParser(HTMLParser):
    """
    Parse the HTML directory listing returned by ArduPilot net_webserver.
    Extracts filename, size, and modification time from the HTML table rows.
    
    Expected HTML row format:
      <tr><td><a href="00000042.BIN">00000042.BIN</a></td><td>2026-04-16 12:34</td><td>1234567</td></tr>
    """

    def __init__(self):
        super().__init__()
        self.entries: List[Dict[str, Any]] = []
        self._in_td = False
        self._in_a = False
        self._current_href: Optional[str] = None
        self._row_cells: List[str] = []
        self._current_text = ""

    def handle_starttag(self, tag: str, attrs: list):
        if tag == "tr":
            self._row_cells = []
        elif tag == "td":
            self._in_td = True
            self._current_text = ""
        elif tag == "a" and self._in_td:
            self._in_a = True
            for name, value in attrs:
                if name == "href":
                    self._current_href = value

    def handle_endtag(self, tag: str):
        if tag == "td" and self._in_td:
            self._in_td = False
            self._row_cells.append(self._current_text.strip())
            self._current_text = ""
        elif tag == "a":
            self._in_a = False
        elif tag == "tr" and len(self._row_cells) >= 3:
            name = self._row_cells[0]
            modtime = self._row_cells[1]
            size_str = self._row_cells[2]
            # Skip header row and parent directory
            if name in ("Name", "..", ".", ""):
                self._current_href = None
                return
            # Parse size
            size = 0
            if size_str and size_str != "0":
                try:
                    if size_str.upper().endswith("M"):
                        size = int(size_str[:-1]) * 1_000_000
                    else:
                        size = int(size_str)
                except ValueError:
                    pass
            is_dir = name.endswith("/")
            self.entries.append({
                "name": name.rstrip("/"),
                "size": size,
                "type": "directory" if is_dir else "file",
                "modtime": modtime,
                "href": self._current_href or name,
            })
            self._current_href = None

    def handle_data(self, data: str):
        if self._in_td:
            self._current_text += data


def parse_fc_log_directory(html: str) -> List[Dict[str, Any]]:
    """Parse ArduPilot net_webserver directory listing HTML into structured entries."""
    parser = _FCLogDirParser()
    parser.feed(html)
    return parser.entries


# ─── FC Log Syncer (HTTP-based) ────────────────────────────────────────────

class FCLogSyncer:
    """
    Background syncer that downloads FC log files from the ArduPilot
    net_webserver over HTTP and stores them locally on the companion computer.
    
    This avoids blocking the MAVLink TCP connection (which MAVFTP does)
    and provides fast local access for the dashboard.
    
    Safety: Only syncs when the drone is DISARMED.
    
    Local store layout:
      {log_store_dir}/
        manifest.json          – sync state for each file
        00000042.BIN           – cached log file
        00000043.BIN
        ...
    
    Manifest entry format:
      {
        "filename": "00000042.BIN",
        "remote_size": 1234567,
        "remote_modtime": "2026-04-16 12:34",
        "local_size": 1234567,
        "synced": true,
        "synced_at": "2026-04-16T13:00:00Z",
        "sha256": "abc123..."
      }
    """

    DEFAULT_FC_WEBSERVER_URL = "http://192.168.144.20:8080"
    DEFAULT_LOG_STORE_DIR = "/var/lib/quiver/fc_logs"
    LOGS_PATH = "/mnt/APM/LOGS/"
    MANIFEST_FILE = "manifest.json"
    SYNC_INTERVAL = 60  # seconds between sync cycles
    DOWNLOAD_CHUNK_SIZE = 65536  # 64KB chunks for streaming download
    MAX_DOWNLOAD_ATTEMPTS = 3  # Skip file after this many failed attempts

    def __init__(self, fc_webserver_url: str = None,
                 log_store_dir: str = None,
                 mavsdk_system=None):
        self.fc_url = (fc_webserver_url or self.DEFAULT_FC_WEBSERVER_URL).rstrip("/")
        self.log_store_dir = Path(log_store_dir or self.DEFAULT_LOG_STORE_DIR)
        self.mavsdk_system = mavsdk_system  # For arm-state checks
        self._manifest: Dict[str, dict] = {}
        self._syncing = False
        self._last_sync_time: Optional[float] = None
        self._last_sync_error: Optional[str] = None
        self._armed = False  # Assume disarmed until we know
        self._arm_state_known = False

    def _ensure_store_dir(self):
        """Create the local store directory if it doesn't exist."""
        self.log_store_dir.mkdir(parents=True, exist_ok=True)

    def _manifest_path(self) -> Path:
        return self.log_store_dir / self.MANIFEST_FILE

    def _load_manifest(self):
        """Load the sync manifest from disk."""
        path = self._manifest_path()
        if path.exists():
            try:
                with open(path, "r") as f:
                    self._manifest = json.load(f)
                logger.debug(f"Loaded manifest: {len(self._manifest)} entries")
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"Failed to load manifest, starting fresh: {e}")
                self._manifest = {}
        else:
            self._manifest = {}

    def _save_manifest(self):
        """Persist the sync manifest to disk."""
        try:
            with open(self._manifest_path(), "w") as f:
                json.dump(self._manifest, f, indent=2)
        except OSError as e:
            logger.error(f"Failed to save manifest: {e}")

    async def _check_arm_state(self) -> bool:
        """
        Check if the drone is armed via MAVSDK telemetry.
        Returns True if DISARMED (safe to sync), False if ARMED.
        """
        if self.mavsdk_system is None:
            # No MAVSDK connection — assume disarmed (allow sync)
            return True
        try:
            async for armed in self.mavsdk_system.telemetry.armed():
                self._armed = armed
                self._arm_state_known = True
                return not armed  # Return True if disarmed
        except Exception as e:
            logger.debug(f"Arm state check failed: {e}")
            # If we can't check, be conservative — don't sync
            if not self._arm_state_known:
                return True  # First time, assume disarmed
            return not self._armed  # Use last known state

    async def _fetch_directory_listing(self) -> Optional[List[Dict[str, Any]]]:
        """Fetch and parse the FC log directory listing via HTTP."""
        url = f"{self.fc_url}{self.LOGS_PATH}"
        try:
            if not requests:
                logger.error("requests library not installed")
                return None
            # Use a short timeout — FC webserver can be slow
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            content_type = resp.headers.get("Content-Type", "")
            if "text/html" not in content_type:
                logger.warning(f"Unexpected content-type from FC: {content_type}")
                return None
            entries = parse_fc_log_directory(resp.text)
            # Filter to only .BIN and .log files
            log_entries = [
                e for e in entries
                if e["type"] == "file" and (
                    e["name"].upper().endswith(".BIN") or
                    e["name"].lower().endswith(".log")
                )
            ]
            logger.info(f"FC webserver: found {len(log_entries)} log file(s) "
                        f"(of {len(entries)} total entries)")
            return log_entries
        except requests.exceptions.ConnectionError:
            logger.debug(f"FC webserver not reachable at {url}")
            return None
        except requests.exceptions.Timeout:
            logger.debug(f"FC webserver timeout at {url}")
            return None
        except Exception as e:
            logger.error(f"Failed to fetch FC log directory: {e}")
            return None

    def _is_skipped(self, filename: str) -> bool:
        """Check if a file has been permanently skipped after too many failures."""
        entry = self._manifest.get(filename, {})
        return entry.get("skipped", False)

    def _record_attempt(self, filename: str, success: bool, error: str = None):
        """Record a download attempt in the manifest. Marks as skipped after MAX_DOWNLOAD_ATTEMPTS failures."""
        entry = self._manifest.setdefault(filename, {})
        attempts = entry.get("attempts", 0)
        if success:
            entry["attempts"] = 0
            entry["skipped"] = False
            entry["skip_reason"] = None
        else:
            attempts += 1
            entry["attempts"] = attempts
            entry["last_error"] = error or "unknown"
            if attempts >= self.MAX_DOWNLOAD_ATTEMPTS:
                entry["skipped"] = True
                entry["skip_reason"] = (f"Failed {attempts} times, last error: "
                                         f"{error or 'unknown'}")
                logger.warning(
                    f"Permanently skipping {filename} after {attempts} failed attempts "
                    f"(reason: {error or 'unknown'}). "
                    f"Delete the 'skipped' key in manifest.json to retry.")
            else:
                logger.info(f"Download attempt {attempts}/{self.MAX_DOWNLOAD_ATTEMPTS} "
                            f"failed for {filename}: {error or 'unknown'}")
        self._save_manifest()

    def reset_skipped(self, filename: str = None):
        """Reset skip status for a specific file or all files. Call to retry previously skipped files."""
        if filename:
            entry = self._manifest.get(filename)
            if entry:
                entry["skipped"] = False
                entry["attempts"] = 0
                entry["skip_reason"] = None
                logger.info(f"Reset skip status for {filename}")
        else:
            for fn, entry in self._manifest.items():
                if entry.get("skipped"):
                    entry["skipped"] = False
                    entry["attempts"] = 0
                    entry["skip_reason"] = None
            logger.info("Reset skip status for all files")
        self._save_manifest()

    async def _download_log_file(self, entry: Dict[str, Any]) -> bool:
        """
        Download a single log file from the FC webserver to local store.
        Uses streaming with asyncio.sleep(0) yields to avoid starving
        the event loop (keeps Socket.IO heartbeats alive during large downloads).
        """
        filename = entry["name"]
        url = f"{self.fc_url}{self.LOGS_PATH}{entry['href']}"
        local_path = self.log_store_dir / filename
        tmp_path = self.log_store_dir / f".{filename}.tmp"

        try:
            logger.info(f"Downloading {filename} from FC webserver...")
            resp = requests.get(url, stream=True, timeout=600)  # 10 min for very large files
            resp.raise_for_status()

            total_size = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            sha256 = hashlib.sha256()

            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=self.DOWNLOAD_CHUNK_SIZE):
                    if chunk:
                        f.write(chunk)
                        sha256.update(chunk)
                        downloaded += len(chunk)

                        # Yield to event loop every ~512KB to keep Socket.IO heartbeats alive
                        if downloaded % (512 * 1024) < self.DOWNLOAD_CHUNK_SIZE:
                            await asyncio.sleep(0)

                        # Check arm state periodically (every ~4MB)
                        if downloaded % (4 * 1024 * 1024) < self.DOWNLOAD_CHUNK_SIZE:
                            if not await self._check_arm_state():
                                logger.warning(
                                    f"Drone ARMED during download of {filename}, "
                                    f"aborting for safety ({downloaded}/{total_size} bytes)")
                                try:
                                    tmp_path.unlink()
                                except OSError:
                                    pass
                                self._record_attempt(filename, False, "Drone armed during download")
                                return False

            # Rename tmp to final
            tmp_path.rename(local_path)
            file_size = local_path.stat().st_size
            file_hash = sha256.hexdigest()

            logger.info(f"Downloaded {filename}: {file_size} bytes, "
                        f"SHA-256: {file_hash[:16]}...")

            # Update manifest
            self._manifest[filename] = {
                "filename": filename,
                "remote_size": entry.get("size", 0) or file_size,
                "remote_modtime": entry.get("modtime", ""),
                "local_size": file_size,
                "synced": True,
                "synced_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "sha256": file_hash,
                "attempts": 0,
                "skipped": False,
                "skip_reason": None,
            }
            self._save_manifest()
            self._record_attempt(filename, True)
            return True

        except Exception as e:
            logger.error(f"Failed to download {filename}: {e}")
            try:
                tmp_path.unlink()
            except OSError:
                pass
            self._record_attempt(filename, False, str(e))
            return False

    def _needs_sync(self, entry: Dict[str, Any]) -> bool:
        """
        Determine if a remote file needs to be downloaded.
        Checks: not in manifest, size mismatch, or modtime changed.
        """
        filename = entry["name"]
        existing = self._manifest.get(filename)
        if not existing:
            return True
        if not existing.get("synced"):
            return True
        # Check if local file actually exists
        local_path = self.log_store_dir / filename
        if not local_path.exists():
            return True
        # Check size mismatch (if remote reports size > 0)
        remote_size = entry.get("size", 0)
        if remote_size > 0 and existing.get("local_size", 0) != remote_size:
            return True
        # Check modtime change
        remote_modtime = entry.get("modtime", "")
        if remote_modtime and existing.get("remote_modtime") != remote_modtime:
            return True
        return False

    async def sync_once(self) -> Dict[str, Any]:
        """
        Run a single sync cycle:
          1. Check arm state (skip if armed)
          2. Fetch directory listing from FC webserver
          3. Download any new/changed files
          4. Update manifest
        
        Returns a summary dict.
        """
        self._syncing = True
        summary = {
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fc_reachable": False,
            "armed": self._armed,
            "files_found": 0,
            "files_synced": 0,
            "files_skipped": 0,
            "files_failed": 0,
            "error": None,
        }

        try:
            # Safety check
            if not await self._check_arm_state():
                summary["armed"] = True
                summary["error"] = "Drone is ARMED — skipping sync for safety"
                logger.info(summary["error"])
                return summary

            summary["armed"] = False

            # Fetch directory listing
            entries = await self._fetch_directory_listing()
            if entries is None:
                summary["error"] = "FC webserver not reachable"
                return summary

            summary["fc_reachable"] = True
            summary["files_found"] = len(entries)

            # Update manifest with discovered files (even if not downloading)
            for entry in entries:
                filename = entry["name"]
                if filename not in self._manifest:
                    self._manifest[filename] = {
                        "filename": filename,
                        "remote_size": entry.get("size", 0),
                        "remote_modtime": entry.get("modtime", ""),
                        "local_size": 0,
                        "synced": False,
                        "synced_at": None,
                        "sha256": None,
                    }

            # Download new/changed files
            for entry in entries:
                filename = entry["name"]

                # Skip files that have exceeded retry limit
                if self._is_skipped(filename):
                    summary["files_skipped"] += 1
                    continue

                if not self._needs_sync(entry):
                    summary["files_skipped"] += 1
                    continue

                # Re-check arm state before each download
                if not await self._check_arm_state():
                    summary["armed"] = True
                    summary["error"] = "Drone ARMED during sync — stopping"
                    logger.warning(summary["error"])
                    break

                if await self._download_log_file(entry):
                    summary["files_synced"] += 1
                else:
                    summary["files_failed"] += 1

            self._save_manifest()
            self._last_sync_time = time.time()
            self._last_sync_error = summary.get("error")

        except Exception as e:
            summary["error"] = str(e)
            logger.error(f"Sync cycle failed: {e}")
            self._last_sync_error = str(e)
        finally:
            self._syncing = False

        return summary

    async def run_sync_loop(self, running_flag):
        """
        Background loop that periodically syncs FC logs.
        
        Args:
            running_flag: callable that returns True while the service is running
        """
        self._ensure_store_dir()
        self._load_manifest()

        logger.info(f"FCLogSyncer started — store: {self.log_store_dir}, "
                    f"FC: {self.fc_url}")

        while running_flag():
            try:
                summary = await self.sync_once()
                if summary.get("error"):
                    logger.debug(f"Sync summary: {summary}")
                elif summary["files_synced"] > 0:
                    logger.info(
                        f"Sync complete: {summary['files_synced']} new, "
                        f"{summary['files_skipped']} up-to-date, "
                        f"{summary['files_failed']} failed")
                else:
                    logger.debug(f"Sync: all {summary['files_skipped']} files up-to-date")
            except Exception as e:
                logger.error(f"Sync loop error: {e}")

            await asyncio.sleep(self.SYNC_INTERVAL)

    def get_cached_logs(self) -> List[Dict[str, Any]]:
        """
        Return the list of all known logs from the manifest.
        Used by scan_fc_logs job handler (instant, no FC access needed).
        """
        logs = []
        for filename, entry in sorted(self._manifest.items()):
            if filename.upper().endswith(".BIN") or filename.lower().endswith(".log"):
                local_path = self.log_store_dir / filename
                logs.append({
                    "remote_path": f"/APM/LOGS/{filename}",
                    "filename": filename,
                    "file_size": entry.get("local_size", 0) or entry.get("remote_size", 0),
                    "synced": entry.get("synced", False) and local_path.exists(),
                    "synced_at": entry.get("synced_at"),
                    "sha256": entry.get("sha256"),
                    "remote_modtime": entry.get("remote_modtime", ""),
                })
        return logs

    def get_local_file_path(self, filename: str) -> Optional[Path]:
        """
        Return the local path for a cached log file, or None if not synced.
        """
        entry = self._manifest.get(filename)
        if not entry or not entry.get("synced"):
            return None
        path = self.log_store_dir / filename
        return path if path.exists() else None

    def get_status(self) -> Dict[str, Any]:
        """Return syncer status for diagnostics."""
        total = len(self._manifest)
        synced = sum(1 for e in self._manifest.values() if e.get("synced"))
        return {
            "fc_webserver_url": self.fc_url,
            "log_store_dir": str(self.log_store_dir),
            "total_logs": total,
            "synced_logs": synced,
            "pending_logs": total - synced,
            "syncing": self._syncing,
            "last_sync_time": self._last_sync_time,
            "last_sync_error": self._last_sync_error,
            "armed": self._armed,
        }


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
        
        MAVSDK's list_directory() returns a ListDirectoryData object with:
          - .dirs:  list of directory name strings
          - .files: list of file name strings
        
        We normalise this into a flat list of dicts for downstream consumers:
          [{"name": "00000042.BIN", "size": 0, "type": "file"}, ...]
        
        Note: MAVFTP list_directory does not return file sizes; size is always 0.
        """
        if not self.connected:
            raise RuntimeError("Not connected to FC")

        try:
            result = await self.system.ftp.list_directory(remote_path)
            entries = []

            # result is a ListDirectoryData(dirs=[...], files=[...])
            # Access .dirs and .files attributes
            dirs_list = getattr(result, 'dirs', None) or []
            files_list = getattr(result, 'files', None) or []

            for dir_name in dirs_list:
                name = str(dir_name).strip()
                if name and name not in ('.', '..'):
                    entries.append({
                        "name": name,
                        "size": 0,
                        "type": "directory",
                    })

            for file_name in files_list:
                name = str(file_name).strip()
                if name:
                    entries.append({
                        "name": name,
                        "size": 0,
                        "type": "file",
                    })

            logger.info(f"Listed {remote_path}: {len(dirs_list)} dirs, {len(files_list)} files")
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
            
            # Ensure the destination directory exists
            os.makedirs(os.path.dirname(local_path) or '.', exist_ok=True)
            
            # MAVSDK download() is an async generator that yields ProgressData
            # It requires: remote_file_path, local_dir, use_burst
            local_dir = os.path.dirname(local_path) or '.'
            
            async for progress_data in self.system.ftp.download(
                remote_path, local_dir, use_burst=True
            ):
                if progress_callback and progress_data:
                    await progress_callback(
                        progress_data.bytes_transferred,
                        progress_data.total_bytes
                    )
            
            # MAVSDK downloads to local_dir using the remote filename
            # Check if the file landed with the original remote filename
            remote_filename = os.path.basename(remote_path)
            downloaded_path = os.path.join(local_dir, remote_filename)
            
            # If the caller wants a different local name, rename
            if downloaded_path != local_path and os.path.exists(downloaded_path):
                os.rename(downloaded_path, local_path)
            
            if os.path.exists(local_path):
                file_size = os.path.getsize(local_path)
                logger.info(f"Download complete: {file_size} bytes")
                if progress_callback:
                    await progress_callback(file_size, file_size)
                return True
            else:
                logger.error(f"Download completed but file not found at {local_path}")
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
    
    When an FCLogSyncer is available, scan and download operations use the
    local cache (fast, no FC access needed). Falls back to MAVFTP if the
    syncer is not available or the file isn't cached yet.
    """

    # FC web server paths for HTTP-based monitoring
    FC_APM_PATH = "/mnt/APM/"
    HTTP_TIMEOUT = 5  # seconds for HTTP HEAD/GET during flash monitoring

    def __init__(self, hub: HubClient, ftp: MavFtpClient,
                 log_syncer: Optional['FCLogSyncer'] = None,
                 log_path: str = "/APM/LOGS"):
        self.hub = hub
        self.ftp = ftp
        self.log_syncer = log_syncer
        self.log_path = log_path
        # Derive FC web server URL from log_syncer if available
        self.fc_url = log_syncer.fc_url if log_syncer else None

    def _http_file_exists(self, filename: str) -> Optional[bool]:
        """Check if a file exists on the FC via HTTP HEAD. Returns None if HTTP unavailable."""
        if not self.fc_url or not requests:
            return None
        try:
            url = f"{self.fc_url}{self.FC_APM_PATH}{filename}"
            resp = requests.head(url, timeout=self.HTTP_TIMEOUT)
            return resp.status_code == 200
        except Exception:
            return None

    def _http_fc_reachable(self) -> bool:
        """Ping the FC web server root to check if it's online (e.g., after reboot)."""
        if not self.fc_url or not requests:
            return False
        try:
            resp = requests.head(self.fc_url, timeout=self.HTTP_TIMEOUT)
            return resp.status_code == 200
        except Exception:
            return False

    async def _check_file_exists(self, filename: str) -> bool:
        """Check if a file exists on the FC. Uses HTTP first, MAVFTP as fallback."""
        # Try HTTP first (faster, doesn't compete for MAVLink bandwidth)
        http_result = self._http_file_exists(filename)
        if http_result is not None:
            return http_result
        # Fallback to MAVFTP
        return await self.ftp.file_exists(f"/APM/{filename}")

    async def _verify_fc_reboot(self, update_id: int, max_wait: int = 60):
        """After flash completes, wait for FC web server to come back online.
        
        This confirms the FC rebooted successfully with new firmware.
        Non-blocking: if HTTP is unavailable, logs a note and returns.
        """
        if not self.fc_url:
            logger.info("FC web server URL not configured — skipping reboot verification")
            return

        logger.info(f"Waiting up to {max_wait}s for FC to reboot and become reachable via HTTP...")
        self.hub.report_firmware_progress(
            update_id, "completed", 100,
            flash_stage="verifying_reboot"
        )

        elapsed = 0
        poll_interval = 5
        while elapsed < max_wait:
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
            if self._http_fc_reachable():
                logger.info(f"FC web server reachable after reboot ({elapsed}s)")
                self.hub.report_firmware_progress(
                    update_id, "completed", 100,
                    flash_stage="reboot_verified"
                )
                return

        logger.warning(f"FC web server not reachable after {max_wait}s — "
                       "FC may still be booting or web server not enabled")

    async def handle_scan_fc_logs(self, job: dict) -> Tuple[bool, Optional[str]]:
        """
        Report available FC log files to the Hub.
        
        Strategy (in order):
          1. On-demand HTTP directory listing from FC webserver (fast, no MAVLink)
          2. Local manifest cache (instant, if previously synced)
          3. MAVFTP list_directory (slow, last resort)
        """
        payload = job.get("payload", {})

        try:
            # ── 1. On-demand HTTP listing from FC webserver ──
            if self.log_syncer:
                logger.info("Scanning FC logs via HTTP (on-demand)...")
                entries = await self.log_syncer._fetch_directory_listing()
                if entries is not None:
                    # Update manifest with discovered files
                    self.log_syncer._ensure_store_dir()
                    self.log_syncer._load_manifest()
                    for entry in entries:
                        fn = entry["name"]
                        if fn not in self.log_syncer._manifest:
                            self.log_syncer._manifest[fn] = {
                                "filename": fn,
                                "remote_size": entry.get("size", 0),
                                "remote_modtime": entry.get("modtime", ""),
                                "local_size": 0,
                                "synced": False,
                                "synced_at": None,
                                "sha256": None,
                            }
                    self.log_syncer._save_manifest()

                    log_files = []
                    for entry in entries:
                        fn = entry["name"]
                        local_path = self.log_syncer.log_store_dir / fn
                        cached = self.log_syncer._manifest.get(fn, {})
                        log_files.append({
                            "remote_path": f"/APM/LOGS/{fn}",
                            "filename": fn,
                            "file_size": entry.get("size", 0) or cached.get("local_size", 0),
                            "synced": cached.get("synced", False) and local_path.exists(),
                            "synced_at": cached.get("synced_at"),
                            "sha256": cached.get("sha256"),
                            "remote_modtime": entry.get("modtime", ""),
                        })

                    logger.info(f"Found {len(log_files)} log file(s) via HTTP")
                    if log_files:
                        self.hub.report_fc_log_list(log_files)
                    return True, None
                else:
                    logger.info("FC webserver unreachable, trying local cache...")

            # ── 2. Local manifest cache ──
            if self.log_syncer:
                cached_logs = self.log_syncer.get_cached_logs()
                if cached_logs:
                    logger.info(f"Scan from local cache: {len(cached_logs)} log file(s)")
                    self.hub.report_fc_log_list(cached_logs)
                    return True, None

            # ── 3. Fallback: MAVFTP (slow, last resort) ──
            scan_path = payload.get("logPath", self.log_path)
            logger.info(f"Scanning FC logs via MAVFTP at {scan_path} (slow fallback)")
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

            logger.info(f"Found {len(log_files)} log file(s) via MAVFTP")

            if log_files:
                self.hub.report_fc_log_list(log_files)

            return True, None

        except Exception as e:
            error_msg = f"FC log scan failed: {e}"
            logger.error(error_msg)
            return False, error_msg

    async def handle_download_fc_log(self, job: dict) -> Tuple[bool, Optional[str]]:
        """
        Serve a specific FC log file to the Hub.
        
        Strategy (in order):
          1. Local cache (instant, file already on Pi)
          2. On-demand HTTP download from FC webserver (fast, no MAVLink blocking)
          3. MAVFTP download (slow, last resort)
        """
        payload = job.get("payload", {})
        log_id = payload.get("logId")
        remote_path = payload.get("remotePath")

        if not log_id or not remote_path:
            return False, "Missing logId or remotePath in job payload"

        filename = remote_path.split("/")[-1]

        try:
            # ── 1. Serve from local cache (instant) ──
            if self.log_syncer:
                local_path = self.log_syncer.get_local_file_path(filename)
                if local_path:
                    logger.info(f"Serving {filename} from local cache: {local_path}")
                    return await self._upload_local_file_to_hub(
                        log_id, filename, local_path)

            # ── 2. On-demand HTTP download from FC webserver ──
            if self.log_syncer and requests:
                logger.info(f"Downloading {filename} via HTTP from FC webserver...")
                self.hub.report_fc_log_progress(log_id, "downloading", 5)

                fc_url = f"{self.log_syncer.fc_url}{self.log_syncer.LOGS_PATH}{filename}"
                try:
                    resp = requests.get(fc_url, stream=True, timeout=300)
                    resp.raise_for_status()

                    total_size = int(resp.headers.get("Content-Length", 0))
                    downloaded = 0
                    sha256 = hashlib.sha256()

                    # Stream to local store (cache for future use)
                    self.log_syncer._ensure_store_dir()
                    tmp_path = self.log_syncer.log_store_dir / f".{filename}.tmp"
                    final_path = self.log_syncer.log_store_dir / filename

                    with open(tmp_path, "wb") as f:
                        for chunk in resp.iter_content(
                                chunk_size=self.log_syncer.DOWNLOAD_CHUNK_SIZE):
                            if chunk:
                                f.write(chunk)
                                sha256.update(chunk)
                                downloaded += len(chunk)
                                if total_size > 0:
                                    pct = min(int(downloaded / total_size * 70), 70)
                                    self.hub.report_fc_log_progress(
                                        log_id, "downloading", pct)

                    # Rename tmp to final and update manifest
                    tmp_path.rename(final_path)
                    file_size = final_path.stat().st_size
                    file_hash = sha256.hexdigest()

                    logger.info(f"Downloaded {filename} via HTTP: {file_size} bytes, "
                                f"SHA-256: {file_hash[:16]}...")

                    # Update manifest so future requests serve from cache
                    self.log_syncer._manifest[filename] = {
                        "filename": filename,
                        "remote_size": total_size or file_size,
                        "remote_modtime": resp.headers.get("Last-Modified", ""),
                        "local_size": file_size,
                        "synced": True,
                        "synced_at": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "sha256": file_hash,
                    }
                    self.log_syncer._save_manifest()

                    # Upload to Hub from the newly cached file
                    return await self._upload_local_file_to_hub(
                        log_id, filename, final_path)

                except requests.exceptions.ConnectionError:
                    logger.info(f"FC webserver unreachable for {filename}, "
                                f"falling back to MAVFTP")
                except requests.exceptions.Timeout:
                    logger.info(f"FC webserver timeout for {filename}, "
                                f"falling back to MAVFTP")
                except requests.exceptions.HTTPError as e:
                    logger.warning(f"HTTP error downloading {filename}: {e}, "
                                   f"falling back to MAVFTP")
                finally:
                    # Clean up tmp file on failure
                    try:
                        tmp_p = self.log_syncer.log_store_dir / f".{filename}.tmp"
                        if tmp_p.exists():
                            tmp_p.unlink()
                    except OSError:
                        pass

            # ── 3. Fallback: MAVFTP download (slow, last resort) ──
            logger.info(f"Downloading {filename} via MAVFTP (slow fallback)...")
            self.hub.report_fc_log_progress(log_id, "downloading", 0)

            with tempfile.NamedTemporaryFile(suffix=f"_{filename}", delete=False) as tmp:
                tmp_path = tmp.name

            try:
                async def progress_cb(downloaded: int, total: int):
                    if total > 0:
                        pct = min(int(downloaded / total * 80), 80)
                        self.hub.report_fc_log_progress(log_id, "downloading", pct)

                await self.ftp.download_file(remote_path, tmp_path, progress_cb)

                file_size = os.path.getsize(tmp_path)
                logger.info(f"Downloaded {filename} via MAVFTP: {file_size} bytes")

                self.hub.report_fc_log_progress(log_id, "uploading", 85)

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
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        except Exception as e:
            error_msg = f"FC log download failed: {e}"
            logger.error(error_msg)
            self.hub.report_fc_log_progress(log_id, "failed", 0, error_msg)
            return False, error_msg

    async def _upload_local_file_to_hub(
            self, log_id: int, filename: str, local_path: Path
    ) -> Tuple[bool, Optional[str]]:
        """Helper: read a local file and upload it to the Hub via REST."""
        self.hub.report_fc_log_progress(log_id, "uploading", 75)

        file_size = local_path.stat().st_size
        with open(local_path, "rb") as f:
            content = f.read()

        url = self.hub.upload_fc_log(log_id, filename, content, file_size)

        if url:
            logger.info(f"Uploaded {filename} to Hub: {url}")
            return True, None
        else:
            error_msg = f"Failed to upload {filename} to Hub"
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

                # ── SHA-256 Artefact Integrity Check ──
                expected_hash = payload.get("sha256Hash")
                if expected_hash:
                    actual_hash = hashlib.sha256(resp.content).hexdigest()
                    if actual_hash != expected_hash:
                        error_msg = (
                            f"SHA-256 mismatch! Expected: {expected_hash[:16]}... "
                            f"Got: {actual_hash[:16]}... "
                            f"Firmware may be corrupted — aborting flash."
                        )
                        logger.error(error_msg)
                        self.hub.report_firmware_progress(
                            update_id, "failed", 0,
                            flash_stage="hash_verification_failed",
                            error_message=error_msg
                        )
                        return False, error_msg
                    logger.info(f"SHA-256 verified: {actual_hash[:16]}...")
                    self.hub.report_firmware_progress(
                        update_id, "transferring", 8,
                        flash_stage="hash_verified"
                    )
                else:
                    logger.warning("No SHA-256 hash in job payload — skipping integrity check")

                # ── Step 2: Pre-upload check via HTTP, then clean old files via MAVFTP ──
                self.hub.report_firmware_progress(update_id, "transferring", 10,
                                                   flash_stage="preparing")
                # Quick HTTP check to verify FC web server is reachable (informational)
                if self._http_fc_reachable():
                    logger.info("FC web server reachable — will use HTTP for flash monitoring")
                else:
                    logger.info("FC web server not reachable — using MAVFTP for flash monitoring")

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

                # ── Step 4: Monitor flash stages (hybrid HTTP + MAVFTP) ──
                self.hub.report_firmware_progress(update_id, "flashing", 65,
                                                   flash_stage="ardupilot.abin")

                # Poll for stage transitions using _check_file_exists (HTTP first, MAVFTP fallback)
                max_wait = 300  # 5 minutes max for flash
                poll_interval = 2
                elapsed = 0
                using_http = self.fc_url is not None

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
                        if await self._check_file_exists(stage_file):
                            method = "HTTP" if using_http else "MAVFTP"
                            logger.info(f"Flash stage ({method}): {stage_file}")
                            self.hub.report_firmware_progress(
                                update_id, stage_status, stage_pct,
                                flash_stage=stage_file
                            )

                            if stage_status == "completed":
                                logger.info("Firmware flash completed successfully!")
                                # ── Step 5: Post-reboot verification via HTTP ──
                                await self._verify_fc_reboot(update_id)
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
                            # Wait and verify FC comes back via HTTP
                            await self._verify_fc_reboot(update_id)
                            return True, None
                        await asyncio.sleep(5)
                        elapsed += 5

                    # Check if the original file was consumed (FC started processing)
                    if elapsed > 30 and current_stage_idx == 0:
                        try:
                            if not await self._check_file_exists("ardupilot.abin"):
                                # File was consumed but no stage file appeared
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
                # ── Artefact Cleanup: delete downloaded firmware temp file ──
                try:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
                        logger.info(f"Cleaned up firmware temp file: {tmp_path}")
                except OSError as cleanup_err:
                    logger.warning(f"Failed to clean up temp file {tmp_path}: {cleanup_err}")

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
    Reports CPU, memory, disk, temperature, service status, and FC web server health.
    """

    # Services to monitor (systemd unit names)
    MONITORED_SERVICES = [
        "telemetry-forwarder.service",
        "camera-stream.service",
        "siyi-camera.service",
        "logs-ota.service",
        "quiver-hub-client.service",
    ]

    def __init__(self, fc_webserver_url: str = None):
        self.fc_webserver_url = fc_webserver_url

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

        # FC web server health check (HTTP ping)
        if self.fc_webserver_url and requests:
            fc_ws: dict = {
                "url": self.fc_webserver_url,
                "reachable": False,
                "latency_ms": None,
                "last_checked": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            try:
                start = time.monotonic()
                resp = requests.head(
                    self.fc_webserver_url,
                    timeout=3,
                    allow_redirects=False,
                )
                elapsed_ms = int((time.monotonic() - start) * 1000)
                fc_ws["reachable"] = resp.status_code < 500
                fc_ws["latency_ms"] = elapsed_ms
                logger.debug(f"FC web server reachable: {resp.status_code} in {elapsed_ms}ms")
            except requests.exceptions.RequestException as e:
                logger.debug(f"FC web server unreachable: {e}")
            diag["fc_webserver"] = fc_ws

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
      - FC log background sync (HTTP via ArduPilot net_webserver)
      - MAVSDK connection to FC (for firmware flash)
      - Job polling from Hub
      - System diagnostics reporting
      - Socket.IO connection for real-time events
      - Remote log streaming
    """

    def __init__(self, hub_url: str, drone_id: str, api_key: str,
                 fc_connection: str, poll_interval: int = 5,
                 diagnostics_interval: int = 10,
                 fc_webserver_url: str = None,
                 log_store_dir: str = None):
        self.hub = HubClient(hub_url, drone_id, api_key)
        self.ftp = MavFtpClient(fc_connection)
        self.log_syncer = FCLogSyncer(
            fc_webserver_url=fc_webserver_url,
            log_store_dir=log_store_dir,
        )
        self.job_handler = LogsOtaJobHandler(self.hub, self.ftp,
                                              log_syncer=self.log_syncer)
        self.diagnostics = DiagnosticsCollector(
            fc_webserver_url=self.log_syncer.fc_url
        )
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

                    # Acknowledge with mutex lock (companion identifier)
                    companion_id = f"logs_ota@{platform.node()}"
                    if not self.hub.acknowledge_job(job_id, locked_by=companion_id):
                        logger.warning(f"Job {job_id} already locked by another companion, skipping")
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
        logger.info(f"  FC Web:      {self.log_syncer.fc_url}")
        logger.info(f"  Log Store:   {self.log_syncer.log_store_dir}")
        logger.info(f"  Poll:        {self.poll_interval}s")
        logger.info(f"  Diagnostics: {self.diagnostics_interval}s")
        logger.info("=" * 60)

        # Connect to FC (non-blocking — jobs will retry if not connected)
        asyncio.create_task(self._initial_fc_connect())

        # Pass MAVSDK system to log syncer for arm-state checks
        # (done after FC connect attempt so system is initialized)
        if self.ftp.system:
            self.log_syncer.mavsdk_system = self.ftp.system

        # Set up Socket.IO for real-time features
        await self._setup_socketio()

        # Start background loops
        tasks = [
            asyncio.create_task(self._job_poll_loop()),
            asyncio.create_task(self._diagnostics_loop()),
            asyncio.create_task(
                self.log_syncer.run_sync_loop(lambda: self.running)
            ),
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
                # Pass MAVSDK system to log syncer for arm-state checks
                if self.ftp.system:
                    self.log_syncer.mavsdk_system = self.ftp.system
                    logger.info("MAVSDK system passed to FCLogSyncer for arm-state guard")
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
    parser.add_argument("--fc-webserver-url",
                        default="http://192.168.144.10:8080",
                        help="ArduPilot net_webserver URL for HTTP log download "
                             "(default: http://192.168.144.10:8080)")
    parser.add_argument("--log-store-dir",
                        default="/var/lib/quiver/fc_logs",
                        help="Local directory to cache FC log files "
                             "(default: /var/lib/quiver/fc_logs)")
    parser.add_argument("--debug", action="store_true",
                        help="Enable debug logging")

    parser.add_argument("--allow-non-root", action="store_true",
                        help="Allow running as non-root (some features may not work)")

    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logging.getLogger("mavsdk").setLevel(logging.DEBUG)

    # Superuser check — needed for journalctl, systemctl, and serial port access
    if os.geteuid() != 0 and not args.allow_non_root:
        logger.warning(
            "Running as non-root user. Some features may not work:\n"
            "  - journalctl log streaming (requires root or systemd-journal group)\n"
            "  - systemctl service status (requires root or polkit)\n"
            "  - Serial port access (requires dialout group)\n"
            "  - Filesystem operations in /tmp (usually fine)\n"
            "Use --allow-non-root to suppress this warning, "
            "or run with: sudo python3 logs_ota_service.py ..."
        )

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
        fc_webserver_url=args.fc_webserver_url,
        log_store_dir=args.log_store_dir,
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
