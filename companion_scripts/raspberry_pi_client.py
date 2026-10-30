#!/usr/bin/env python3
"""Quiver Hub Raspberry Pi companion client.

The client polls the Hub for jobs and reports their outcome.  Remote file and
configuration writes are deliberately disabled unless the local operator sets
``ALLOW_REMOTE_FILE_WRITES=true``.  When enabled, writes are restricted to
configured data directories and are never used to update companion code,
services, shell files, or the EnvironmentFile.
"""

import argparse
import gzip
import hashlib
import ipaddress
import json
import logging
import math
import os
import platform
import re
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urljoin, urlparse

import requests

from companion_config import load_environment


CONFIG = load_environment()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_POLL_INTERVAL_SECONDS = 3600.0
STREAM_CHUNK_SIZE = 64 * 1024
SAFE_DATA_SUFFIXES = frozenset({".bin", ".csv", ".dat", ".geojson", ".json", ".log", ".txt"})


def _bool_setting(value: Any) -> bool:
    """Return the literal EnvironmentFile boolean representation used here."""
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _parse_poll_interval(value: Any) -> float:
    """Return a bounded positive interval or raise a concise validation error."""
    try:
        interval = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("must be a finite positive number") from error
    if not math.isfinite(interval) or interval <= 0 or interval > MAX_POLL_INTERVAL_SECONDS:
        raise ValueError(
            "must be a finite positive number no greater than {}".format(
                int(MAX_POLL_INTERVAL_SECONDS)
            )
        )
    return interval


def positive_poll_interval(value: str) -> float:
    """argparse adapter for :func:`_parse_poll_interval`."""
    try:
        return _parse_poll_interval(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _is_local_development_host(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def validate_remote_url(url: Any, allow_insecure_localhost: bool, *, allow_query: bool) -> str:
    """Validate an HTTPS endpoint, allowing HTTP only for explicit localhost development.

    File download URLs can contain a presigned query string.  Hub base URLs may
    not, which prevents accidentally configuring credentials in the base URL.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("URL is required")
    candidate = url.strip()
    parsed = urlparse(candidate)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ValueError("URL must be an absolute HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not include credentials")
    if not allow_query and (parsed.query or parsed.fragment):
        raise ValueError("Hub URL must not include a query or fragment")
    if parsed.scheme != "https":
        if not (allow_insecure_localhost and _is_local_development_host(parsed.hostname)):
            raise ValueError(
                "URL must use HTTPS (set ALLOW_INSECURE_HUB=true only for localhost development)"
            )
    return candidate


def _contains_symlink(path: Path) -> bool:
    """Return whether any existing component of an absolute path is a symlink."""
    absolute = Path(os.path.abspath(str(path)))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        if os.path.lexists(str(current)) and current.is_symlink():
            return True
    return False


def _fsync_directory(directory: Path) -> None:
    """Best-effort directory durability after an atomic rename."""
    try:
        descriptor = os.open(str(directory), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class QuiverHubClient:
    """Client for the narrowly scoped, authenticated companion job protocol."""

    def __init__(
        self,
        server_url: str,
        drone_id: str,
        api_key: str,
        poll_interval: float = 5,
        companion_id: Optional[str] = None,
        *,
        allow_remote_file_writes: Optional[bool] = None,
        allow_insecure_hub: Optional[bool] = None,
    ):
        self.allow_insecure_hub = (
            _bool_setting(CONFIG.get("ALLOW_INSECURE_HUB", "false"))
            if allow_insecure_hub is None
            else allow_insecure_hub
        )
        self.server_url = validate_remote_url(
            server_url, self.allow_insecure_hub, allow_query=False
        ).rstrip("/")
        self.drone_id = drone_id
        self.api_key = api_key
        self.poll_interval = _parse_poll_interval(poll_interval)
        self.companion_id = companion_id or "hub_client@{}".format(platform.node())
        self.session = requests.Session()
        self.allow_remote_file_writes = (
            _bool_setting(CONFIG.get("ALLOW_REMOTE_FILE_WRITES", "false"))
            if allow_remote_file_writes is None
            else allow_remote_file_writes
        )

        install_dir = Path(str(CONFIG.get("INSTALL_DIR", Path(__file__).resolve().parent))).expanduser()
        self.config_dir = Path(str(CONFIG.get("CONFIG_DIR", install_dir / "config"))).expanduser()
        self.parsers_dir = Path(str(CONFIG.get("PARSERS_DIR", install_dir / "parsers"))).expanduser()
        self.upload_dir = Path(str(CONFIG.get("UPLOAD_DIR", install_dir / "uploads"))).expanduser()

        logger.info("Initialized Quiver Hub client for drone: %s", drone_id)
        logger.info("Companion ID: %s", self.companion_id)
        logger.info("Poll interval: %ss", self.poll_interval)
        if not self.allow_remote_file_writes:
            logger.info("Remote file and configuration writes are disabled")

    def _response_object(self, response: Any, operation: str) -> Optional[Mapping[str, Any]]:
        """Decode one expected JSON object without letting malformed responses escape."""
        try:
            payload = response.json()
        except (TypeError, ValueError):
            logger.error("%s returned invalid JSON", operation)
            return None
        if not isinstance(payload, Mapping):
            logger.error("%s returned an unexpected JSON shape", operation)
            return None
        return payload

    @staticmethod
    def _trpc_json(payload: Mapping[str, Any], operation: str) -> Optional[Mapping[str, Any]]:
        current: Any = payload
        for key in ("result", "data", "json"):
            if not isinstance(current, Mapping):
                logger.error("%s returned an unexpected response schema", operation)
                return None
            current = current.get(key)
        if not isinstance(current, Mapping):
            logger.error("%s returned an unexpected response schema", operation)
            return None
        return current

    @staticmethod
    def _request_failure(operation: str, error: Exception) -> None:
        # Do not interpolate request exceptions: query strings may embed the API key.
        logger.error("%s failed (%s)", operation, error.__class__.__name__)

    def _validate_response_transport(self, response: Any) -> None:
        """Reject an HTTPS-to-HTTP redirect before consuming its response body."""
        response_url = getattr(response, "url", None)
        if isinstance(response_url, str) and response_url:
            validate_remote_url(response_url, self.allow_insecure_hub, allow_query=True)

    def _job_is_valid(self, job: Any, index: int) -> bool:
        if not isinstance(job, Mapping):
            logger.warning("Ignoring malformed job at index %d", index)
            return False
        job_id = job.get("id")
        job_type = job.get("type")
        payload = job.get("payload")
        if (
            not isinstance(job_id, int)
            or isinstance(job_id, bool)
            or job_id <= 0
            or not isinstance(job_type, str)
            or not job_type
            or not isinstance(payload, Mapping)
        ):
            logger.warning("Ignoring malformed job at index %d", index)
            return False
        return True

    def get_pending_jobs(self) -> List[Dict[str, Any]]:
        """Fetch and schema-check pending jobs; a bad response becomes one failed poll."""
        try:
            url = urljoin(self.server_url, "/api/trpc/droneJobs.getPendingJobs")
            params = {
                "input": json.dumps({"json": {"droneId": self.drone_id, "apiKey": self.api_key}})
            }
            response = self.session.get(url, params=params, timeout=10)
            self._validate_response_transport(response)
            response.raise_for_status()
            decoded = self._response_object(response, "Pending-jobs request")
            if decoded is None:
                return []
            result = self._trpc_json(decoded, "Pending-jobs request")
            if result is None:
                return []
            jobs = result.get("jobs")
            if not isinstance(jobs, list):
                logger.error("Pending-jobs request returned an invalid jobs list")
                return []
            valid_jobs = [dict(job) for index, job in enumerate(jobs) if self._job_is_valid(job, index)]
            if valid_jobs:
                logger.info("Found %d pending job(s)", len(valid_jobs))
            return valid_jobs
        except Exception as error:
            self._request_failure("Pending-jobs request", error)
            return []

    def acknowledge_job(self, job_id: int) -> bool:
        """Acquire the server's job mutex, returning false for malformed server results."""
        try:
            url = urljoin(self.server_url, "/api/trpc/droneJobs.acknowledgeJob")
            payload = {
                "json": {
                    "jobId": job_id,
                    "apiKey": self.api_key,
                    "droneId": self.drone_id,
                    "lockedBy": self.companion_id,
                }
            }
            response = self.session.post(url, json=payload, timeout=10)
            self._validate_response_transport(response)
            response.raise_for_status()
            decoded = self._response_object(response, "Acknowledge-job request")
            if decoded is None:
                return False
            result = self._trpc_json(decoded, "Acknowledge-job request")
            if result is None:
                return False
            success = result.get("success")
            if not isinstance(success, bool):
                logger.error("Acknowledge-job request returned an invalid success flag")
                return False
            if not success:
                logger.warning("Job %d is already locked or was rejected", job_id)
            return success
        except Exception as error:
            self._request_failure("Acknowledge-job request", error)
            return False

    def complete_job(self, job_id: int, success: bool, error_message: Optional[str] = None) -> bool:
        """Report completion and validate the Hub's success response."""
        try:
            url = urljoin(self.server_url, "/api/trpc/droneJobs.completeJob")
            json_data: Dict[str, Any] = {
                "jobId": job_id,
                "apiKey": self.api_key,
                "droneId": self.drone_id,
                "success": success,
            }
            if error_message is not None:
                json_data["errorMessage"] = error_message
            response = self.session.post(url, json={"json": json_data}, timeout=10)
            self._validate_response_transport(response)
            response.raise_for_status()
            decoded = self._response_object(response, "Complete-job request")
            if decoded is None:
                return False
            result = self._trpc_json(decoded, "Complete-job request")
            if result is None:
                return False
            completed = result.get("success")
            if not isinstance(completed, bool):
                logger.error("Complete-job request returned an invalid success flag")
                return False
            if completed:
                logger.info("Reported completion for job %d", job_id)
            else:
                logger.warning("Hub rejected completion for job %d", job_id)
            return completed
        except Exception as error:
            self._request_failure("Complete-job request", error)
            return False

    @staticmethod
    def _prepare_root(root: Path) -> Path:
        """Create a configured root only through non-symlink ancestors."""
        if not root.is_absolute():
            raise ValueError("configured write directories must be absolute")
        if _contains_symlink(root):
            raise ValueError("configured write directory contains a symlink")
        root.mkdir(parents=True, exist_ok=True)
        if not root.is_dir() or root.is_symlink() or _contains_symlink(root):
            raise ValueError("configured write directory is unsafe")
        return root.resolve(strict=False)

    @staticmethod
    def _safe_data_name(target: Path) -> bool:
        return not target.name.startswith(".") and target.suffix.lower() in SAFE_DATA_SUFFIXES

    def _resolve_write_target(
        self,
        raw_target: Any,
        roots: Sequence[Path],
        *,
        json_only: bool,
    ) -> Path:
        """Resolve an absolute target under an approved root with no symlink traversal."""
        if not isinstance(raw_target, str) or not raw_target.strip():
            raise ValueError("write target is required")
        supplied = Path(raw_target).expanduser()
        if not supplied.is_absolute():
            raise ValueError("write target must be absolute")
        if _contains_symlink(supplied):
            raise ValueError("write target contains a symlink")

        approved_roots = [self._prepare_root(root) for root in roots]
        target = supplied.resolve(strict=False)
        if target.name in {"", ".", ".."}:
            raise ValueError("write target must name a file")
        if not self._safe_data_name(target):
            raise ValueError("write target is not an approved data filename")
        if json_only and target.suffix.lower() != ".json":
            raise ValueError("configuration files must use a .json filename")
        if not any(target.is_relative_to(root) for root in approved_roots):
            raise ValueError("write target is outside approved data directories")

        # Create parent directories only after containment validation, then check
        # again because a pre-existing path component may be a symlink.
        target.parent.mkdir(parents=True, exist_ok=True)
        if _contains_symlink(target) or (os.path.lexists(str(target)) and target.is_symlink()):
            raise ValueError("write target contains a symlink")
        return target

    @staticmethod
    def _temporary_path(directory: Path) -> Tuple[int, Path]:
        descriptor, name = tempfile.mkstemp(prefix=".quiver-download-", dir=str(directory))
        os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
        return descriptor, Path(name)

    @classmethod
    def _stream_to_temporary_file(
        cls, response: Any, directory: Path, maximum_bytes: int
    ) -> Tuple[Path, int, str]:
        """Stream a response to a same-directory temp file with a strict byte cap."""
        header_length = getattr(response, "headers", {}).get("Content-Length")
        if header_length:
            try:
                if int(header_length) > maximum_bytes:
                    raise ValueError("download exceeds maximum size")
            except ValueError as error:
                if str(error) == "download exceeds maximum size":
                    raise
                raise ValueError("download sent an invalid Content-Length") from error

        descriptor, temporary = cls._temporary_path(directory)
        total = 0
        digest = hashlib.sha256()
        try:
            iterator = getattr(response, "iter_content", None)
            if not callable(iterator):
                raise ValueError("download response cannot be streamed")
            with os.fdopen(descriptor, "wb") as output:
                for chunk in iterator(chunk_size=STREAM_CHUNK_SIZE):
                    if not chunk:
                        continue
                    if not isinstance(chunk, (bytes, bytearray)):
                        raise ValueError("download response contained non-bytes data")
                    total += len(chunk)
                    if total > maximum_bytes:
                        raise ValueError("download exceeds maximum size")
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            return temporary, total, digest.hexdigest()
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temporary.unlink(missing_ok=True)
            raise

    @classmethod
    def _decompress_gzip_to_temporary_file(
        cls, source: Path, directory: Path, maximum_bytes: int
    ) -> Tuple[Path, int]:
        """Decompress incrementally into a bounded, durable same-directory temp file."""
        descriptor, temporary = cls._temporary_path(directory)
        total = 0
        try:
            with gzip.open(str(source), "rb") as compressed, os.fdopen(descriptor, "wb") as output:
                while True:
                    chunk = compressed.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > maximum_bytes:
                        raise ValueError("decompressed download exceeds maximum size")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            return temporary, total
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temporary.unlink(missing_ok=True)
            raise

    @staticmethod
    def _optional_sha256(file_info: Mapping[str, Any]) -> Optional[str]:
        """Return an optional declared SHA-256, rejecting malformed supplied hashes."""
        for key in ("sha256", "hash"):
            if key not in file_info:
                continue
            supplied = file_info[key]
            if not isinstance(supplied, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", supplied):
                raise ValueError("file metadata contained an invalid SHA-256")
            return supplied.lower()
        return None

    def _file_metadata(self, file_id: str) -> Optional[Mapping[str, Any]]:
        try:
            url = urljoin(self.server_url, "/api/trpc/droneJobs.getFile")
            params = {
                "input": json.dumps({"json": {"fileId": file_id, "apiKey": self.api_key, "droneId": self.drone_id}})
            }
            response = self.session.get(url, params=params, timeout=10)
            self._validate_response_transport(response)
            response.raise_for_status()
            decoded = self._response_object(response, "Get-file request")
            if decoded is None:
                return None
            result = self._trpc_json(decoded, "Get-file request")
            if result is None:
                return None
            file_info = result.get("file")
            if not isinstance(file_info, Mapping):
                logger.error("Get-file request returned an invalid file object")
                return None
            return file_info
        except Exception as error:
            self._request_failure("Get-file request", error)
            return None

    def download_file(self, file_id: str, target_path: str, is_compressed: bool = False) -> bool:
        """Download an approved data artifact using bounded, atomic replacement."""
        if not self.allow_remote_file_writes:
            logger.warning("Rejected remote file write because it is disabled")
            return False
        if not isinstance(file_id, str) or not file_id or len(file_id) > 128:
            logger.warning("Rejected remote file write with an invalid file ID")
            return False
        if not isinstance(is_compressed, bool):
            logger.warning("Rejected remote file write with an invalid compression flag")
            return False

        source_temporary: Optional[Path] = None
        output_temporary: Optional[Path] = None
        response: Any = None
        try:
            target = self._resolve_write_target(
                target_path, (self.upload_dir, self.parsers_dir), json_only=False
            )
            file_info = self._file_metadata(file_id)
            if file_info is None:
                return False
            file_url = validate_remote_url(
                file_info.get("url"), self.allow_insecure_hub, allow_query=True
            )
            declared_size = file_info.get("fileSize")
            if declared_size is not None:
                if (
                    not isinstance(declared_size, int)
                    or isinstance(declared_size, bool)
                    or declared_size < 0
                    or declared_size > MAX_DOWNLOAD_BYTES
                ):
                    raise ValueError("file metadata contained an invalid size")
            expected_hash = self._optional_sha256(file_info)

            # Never log this URL: presigned URLs routinely include secrets in the query.
            response = self.session.get(file_url, timeout=(10, 30), stream=True)
            self._validate_response_transport(response)
            response.raise_for_status()
            source_temporary, downloaded_size, actual_hash = self._stream_to_temporary_file(
                response, target.parent, MAX_DOWNLOAD_BYTES
            )
            if declared_size is not None and downloaded_size != declared_size:
                raise ValueError("download size did not match metadata")
            if expected_hash is not None and actual_hash != expected_hash:
                raise ValueError("download SHA-256 did not match metadata")

            if is_compressed:
                output_temporary, _ = self._decompress_gzip_to_temporary_file(
                    source_temporary, target.parent, MAX_DOWNLOAD_BYTES
                )
                replacement = output_temporary
            else:
                replacement = source_temporary

            # Re-check before replacement so an existing/sudden symlink is never followed.
            self._resolve_write_target(
                str(target), (self.upload_dir, self.parsers_dir), json_only=False
            )
            os.replace(str(replacement), str(target))
            if replacement == source_temporary:
                source_temporary = None
            else:
                output_temporary = None
            os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
            _fsync_directory(target.parent)
            logger.info("Saved approved remote data artifact (%d bytes)", downloaded_size)
            return True
        except Exception as error:
            # Avoid exception text: requests includes credential-bearing request URLs.
            logger.error("File download failed (%s)", error.__class__.__name__)
            return False
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            if source_temporary is not None:
                source_temporary.unlink(missing_ok=True)
            if output_temporary is not None:
                output_temporary.unlink(missing_ok=True)

    @staticmethod
    def _atomic_write(target: Path, content: bytes) -> None:
        """Write one data file via fsynced temporary file and atomic rename."""
        descriptor, temporary = QuiverHubClient._temporary_path(target.parent)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.replace(str(temporary), str(target))
            os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
            _fsync_directory(target.parent)
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temporary.unlink(missing_ok=True)
            raise

    def handle_upload_file_job(self, job: Mapping[str, Any]) -> Tuple[bool, Optional[str]]:
        """Handle one opt-in upload_file job, limited to approved data roots."""
        if not self.allow_remote_file_writes:
            return False, "Remote file writes are disabled"
        payload = job.get("payload")
        if not isinstance(payload, Mapping):
            return False, "Invalid upload job payload"
        file_id = payload.get("fileId")
        target_path = payload.get("targetPath")
        is_compressed = payload.get("isCompressed", False)
        if not isinstance(file_id, str) or not isinstance(target_path, str) or not isinstance(is_compressed, bool):
            return False, "Invalid upload job payload"
        if self.download_file(file_id, target_path, is_compressed):
            return True, None
        return False, "File download failed"

    def handle_update_config_job(self, job: Mapping[str, Any]) -> Tuple[bool, Optional[str]]:
        """Atomically write a bounded JSON object below the dedicated configuration root."""
        if not self.allow_remote_file_writes:
            return False, "Remote file writes are disabled"
        try:
            payload = job.get("payload")
            if not isinstance(payload, Mapping):
                return False, "Invalid configuration job payload"
            config_data = payload.get("config")
            if not isinstance(config_data, dict):
                return False, "Configuration must be a JSON object"
            raw_config_file = payload.get("configFile", str(self.config_dir / "quiver_config.json"))
            target = self._resolve_write_target(raw_config_file, (self.config_dir,), json_only=True)
            content = json.dumps(config_data, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(content) + 1 > MAX_CONFIG_BYTES:
                return False, "Configuration exceeds maximum size"
            self._resolve_write_target(str(target), (self.config_dir,), json_only=True)
            self._atomic_write(target, content + b"\n")
            logger.info("Updated approved JSON configuration")
            return True, None
        except Exception as error:
            logger.error("Configuration update failed (%s)", error.__class__.__name__)
            return False, "Configuration update failed"

    def process_job(self, job: Mapping[str, Any]) -> None:
        """Acknowledge and execute a validated job without trusting its payload shape."""
        if not self._job_is_valid(job, 0):
            return
        job_id = job["id"]
        job_type = job["type"]
        logger.info("Processing job %d", job_id)
        if not self.acknowledge_job(job_id):
            logger.error("Failed to acknowledge job %d", job_id)
            return

        success = False
        error_message: Optional[str] = None
        try:
            if job_type == "upload_file":
                success, error_message = self.handle_upload_file_job(job)
            elif job_type == "update_config":
                success, error_message = self.handle_update_config_job(job)
            else:
                error_message = "Unknown job type"
                logger.warning("Rejected unknown job type for job %d", job_id)
        except Exception as error:
            logger.error("Unexpected job error (%s)", error.__class__.__name__)
            error_message = "Unexpected job error"
        self.complete_job(job_id, success, error_message)

    def run(self) -> None:
        """Poll serially until stopped; malformed server data fails only its current poll."""
        logger.info("Starting Quiver Hub client; press Ctrl+C to stop")
        try:
            while True:
                for job in self.get_pending_jobs():
                    self.process_job(job)
                time.sleep(self.poll_interval)
        except KeyboardInterrupt:
            logger.info("Shutting down")
        except Exception as error:
            logger.error("Fatal client error (%s)", error.__class__.__name__)
            sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Quiver Hub Raspberry Pi Client",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 raspberry_pi_client.py --server https://your-server.com --drone-id quiver_001 --api-key abc123
  python3 raspberry_pi_client.py --server https://your-server.com --drone-id quiver_001 --api-key abc123 --poll-interval 10
        """,
    )
    parser.add_argument(
        "--server", "--hub-url", dest="server", default=CONFIG.get("HUB_URL", ""),
        help="Quiver Hub HTTPS URL (or HUB_URL/WEB_SERVER_URL in the environment)",
    )
    parser.add_argument(
        "--drone-id", default=CONFIG.get("DRONE_ID", ""),
        help="Unique identifier for this drone (or DRONE_ID in the environment)",
    )
    parser.add_argument(
        "--api-key", default=CONFIG.get("API_KEY", ""),
        help="API key for authentication (or API_KEY in the environment)",
    )
    # Keep this default as None.  Parsing a malformed EnvironmentFile default
    # here would otherwise prevent --help and a valid explicit override.
    parser.add_argument(
        "--poll-interval", type=positive_poll_interval, default=None,
        help="Polling seconds, greater than zero and at most 3600 (default: POLL_INTERVAL or 5)",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    parser.add_argument(
        "--companion-id", default=None,
        help="Unique companion identifier for mutex locking (default: hub_client@<hostname>)",
    )
    return parser


def parse_arguments(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """Parse CLI arguments while allowing an explicit interval to override a bad env default."""
    parser = build_parser()
    args = parser.parse_args(argv)
    for option, value, environment_key in (
        ("--server/--hub-url", args.server, "HUB_URL or WEB_SERVER_URL"),
        ("--drone-id", args.drone_id, "DRONE_ID"),
        ("--api-key", args.api_key, "API_KEY"),
    ):
        if not value:
            parser.error("{} is required; provide it or set {}".format(option, environment_key))
    if args.poll_interval is None:
        try:
            args.poll_interval = _parse_poll_interval(CONFIG.get("POLL_INTERVAL", "5"))
        except ValueError as error:
            parser.error("invalid POLL_INTERVAL: {}".format(error))
    try:
        validate_remote_url(
            args.server, _bool_setting(CONFIG.get("ALLOW_INSECURE_HUB", "false")), allow_query=False
        )
    except ValueError as error:
        parser.error(str(error))
    return args


def main(argv: Optional[Sequence[str]] = None) -> None:
    """Main entry point."""
    args = parse_arguments(argv)
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    client = QuiverHubClient(
        server_url=args.server,
        drone_id=args.drone_id,
        api_key=args.api_key,
        poll_interval=args.poll_interval,
        companion_id=args.companion_id,
    )
    client.run()


if __name__ == "__main__":
    main()
