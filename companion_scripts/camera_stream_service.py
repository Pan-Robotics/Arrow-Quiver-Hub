#!/usr/bin/env python3
"""
SIYI A8 Mini WebRTC Video Streaming Service (go2rtc + Tailscale)

This script manages go2rtc for low-latency WebRTC streaming from the
SIYI A8 mini camera. It replaces the previous HLS-based pipeline.

Architecture:
  SIYI Camera (RTSP) → go2rtc (WebRTC) → Tailscale Funnel → Browser

go2rtc handles:
  - RTSP ingest from the camera
  - WebRTC encoding and signaling (WHEP API)
  - ICE/STUN negotiation for peer-to-peer media

Tailscale Funnel handles:
  - Exposing the go2rtc API to the internet (HTTPS signaling only)
  - WebRTC media flows peer-to-peer via UDP, not through the funnel

Features:
  - Manages go2rtc process lifecycle
  - Auto-detects Tailscale funnel URL
  - Registers WebRTC URL with Quiver Hub
  - Health monitoring and auto-restart
  - Combined mode with SIYI gimbal controller

RTSP Sources:
  - Main stream (4K): rtsp://192.168.144.25:8554/main.264
  - Sub stream (720p): rtsp://192.168.144.25:8554/sub.264

Usage:
    python camera_stream_service.py --stream sub --hub-url https://your-hub.com --drone-id quiver_001 --api-key YOUR_KEY
"""

import asyncio
import subprocess
import os
import signal
import sys
import time
import json
import argparse
import logging
import tempfile
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:
    requests = None

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('camera_stream')

# ============================================================================
# Configuration
# ============================================================================

SIYI_CAMERA_IP = "192.168.144.25"
RTSP_PORT = 8554

RTSP_STREAMS = {
    "main": f"rtsp://{SIYI_CAMERA_IP}:{RTSP_PORT}/main.264",   # 4K
    "sub": f"rtsp://{SIYI_CAMERA_IP}:{RTSP_PORT}/sub.264",     # 720p (lower bandwidth)
}

# go2rtc defaults
GO2RTC_API_PORT = 1984
GO2RTC_WEBRTC_PORT = 8555
GO2RTC_BINARY = "go2rtc"  # Expected in PATH or /usr/local/bin/go2rtc

# Tailscale funnel port (must be 443, 8443, or 10000)
TAILSCALE_FUNNEL_PORT = 443


# ============================================================================
# go2rtc Configuration Generator
# ============================================================================

def generate_go2rtc_config(rtsp_url: str, api_port: int = GO2RTC_API_PORT,
                           webrtc_port: int = GO2RTC_WEBRTC_PORT) -> str:
    """
    Generate go2rtc YAML configuration.
    
    Uses STUN for automatic public IP detection so WebRTC media
    can flow peer-to-peer even when the Pi is behind NAT.
    """
    lines = []
    
    # streams section
    lines.append("streams:")
    lines.append(f"  camera: {rtsp_url}")
    lines.append("")
    
    # api section
    lines.append("api:")
    lines.append(f'  listen: ":{api_port}"')
    lines.append("")
    
    # webrtc section
    lines.append("webrtc:")
    lines.append(f'  listen: ":{webrtc_port}"')
    lines.append("  candidates:")
    lines.append(f"    - stun:{webrtc_port}")
    lines.append("")
    
    # rtsp section - disable re-streaming
    lines.append("rtsp:")
    lines.append('  listen: ""')
    lines.append("")
    
    # log section
    lines.append("log:")
    lines.append("  level: info")
    
    return "\n".join(lines)


# ============================================================================
# Tailscale Funnel URL Detection
# ============================================================================

def get_tailscale_funnel_url(funnel_port: int = TAILSCALE_FUNNEL_PORT,
                              max_retries: int = 30,
                              retry_interval: float = 2.0) -> Optional[str]:
    """
    Auto-detect the Tailscale funnel URL by querying tailscale status.
    
    Returns the public HTTPS URL (e.g. https://quiver.tail1234.ts.net)
    or None if Tailscale is not running or funnel is not configured.
    
    Retries because Tailscale may still be connecting on boot.
    """
    for attempt in range(max_retries):
        try:
            result = subprocess.run(
                ["tailscale", "status", "--json"],
                capture_output=True, text=True, timeout=10
            )
            
            if result.returncode != 0:
                if attempt < max_retries - 1:
                    logger.debug(f"Tailscale not ready (attempt {attempt + 1}/{max_retries})")
                    time.sleep(retry_interval)
                    continue
                logger.warning(f"tailscale status failed: {result.stderr}")
                return None
            
            status = json.loads(result.stdout)
            
            # Get the DNS name of this machine
            self_status = status.get("Self", {})
            dns_name = self_status.get("DNSName", "")
            
            if not dns_name:
                if attempt < max_retries - 1:
                    logger.debug(f"No DNS name yet (attempt {attempt + 1}/{max_retries})")
                    time.sleep(retry_interval)
                    continue
                logger.warning("Tailscale has no DNS name assigned")
                return None
            
            # Remove trailing dot from DNS name
            dns_name = dns_name.rstrip(".")
            
            # Construct the funnel URL
            if funnel_port == 443:
                funnel_url = f"https://{dns_name}"
            else:
                funnel_url = f"https://{dns_name}:{funnel_port}"
            
            logger.info(f"Tailscale funnel URL detected: {funnel_url}")
            return funnel_url
            
        except subprocess.TimeoutExpired:
            logger.debug(f"tailscale status timed out (attempt {attempt + 1}/{max_retries})")
            if attempt < max_retries - 1:
                time.sleep(retry_interval)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse tailscale status JSON: {e}")
            if attempt < max_retries - 1:
                time.sleep(retry_interval)
        except FileNotFoundError:
            logger.error("tailscale CLI not found. Is Tailscale installed?")
            return None
        except Exception as e:
            logger.error(f"Unexpected error querying Tailscale: {e}")
            if attempt < max_retries - 1:
                time.sleep(retry_interval)
    
    logger.error(f"Failed to detect Tailscale funnel URL after {max_retries} attempts")
    return None


def setup_tailscale_funnel(local_port: int = GO2RTC_API_PORT,
                            funnel_port: int = TAILSCALE_FUNNEL_PORT) -> bool:
    """
    Configure Tailscale serve + funnel to expose go2rtc API.
    
    This runs:
      tailscale serve --bg --https=<funnel_port> http://localhost:<local_port>
      tailscale funnel <funnel_port> on
    
    Returns True if successful.
    """
    try:
        # Step 1: Set up tailscale serve (proxy HTTPS to local HTTP)
        serve_cmd = [
            "tailscale", "serve", "--bg",
            f"--https={funnel_port}",
            f"http://localhost:{local_port}"
        ]
        logger.info(f"Setting up Tailscale serve: {' '.join(serve_cmd)}")
        result = subprocess.run(serve_cmd, capture_output=True, text=True, timeout=15)
        
        if result.returncode != 0:
            logger.error(f"tailscale serve failed: {result.stderr}")
            return False
        
        logger.info("Tailscale serve configured")
        
        # Step 2: Enable funnel (make it public)
        funnel_cmd = ["tailscale", "funnel", str(funnel_port), "on"]
        logger.info(f"Enabling Tailscale funnel: {' '.join(funnel_cmd)}")
        result = subprocess.run(funnel_cmd, capture_output=True, text=True, timeout=15)
        
        if result.returncode != 0:
            logger.error(f"tailscale funnel failed: {result.stderr}")
            return False
        
        logger.info(f"Tailscale funnel enabled on port {funnel_port}")
        return True
        
    except subprocess.TimeoutExpired:
        logger.error("Tailscale command timed out")
        return False
    except FileNotFoundError:
        logger.error("tailscale CLI not found")
        return False
    except Exception as e:
        logger.error(f"Failed to setup Tailscale funnel: {e}")
        return False


# ============================================================================
# WebRTC Streaming Service (go2rtc)
# ============================================================================

class WebRTCStreamingService:
    """
    Service that manages go2rtc for RTSP-to-WebRTC streaming.
    
    Replaces the previous HLS pipeline with:
    1. go2rtc binary for RTSP ingest and WebRTC serving
    2. Tailscale funnel for public access to signaling API
    3. Hub registration so the browser knows the WebRTC URL
    """
    
    def __init__(self,
                 stream_type: str = "sub",
                 rtsp_url: Optional[str] = None,
                 api_port: int = GO2RTC_API_PORT,
                 webrtc_port: int = GO2RTC_WEBRTC_PORT,
                 funnel_port: int = TAILSCALE_FUNNEL_PORT,
                 hub_url: Optional[str] = None,
                 drone_id: Optional[str] = None,
                 api_key: Optional[str] = None,
                 public_url: Optional[str] = None,
                 skip_funnel_setup: bool = False):
        
        self.stream_type = stream_type
        self.rtsp_url = rtsp_url or RTSP_STREAMS.get(stream_type, RTSP_STREAMS["sub"])
        self.api_port = api_port
        self.webrtc_port = webrtc_port
        self.funnel_port = funnel_port
        
        # Quiver Hub registration
        self.hub_url = hub_url
        self.drone_id = drone_id
        self.api_key = api_key
        self.public_url = public_url  # Override: skip Tailscale detection
        self.skip_funnel_setup = skip_funnel_setup
        self._stream_registered = False
        
        # go2rtc process
        self.go2rtc_process: Optional[subprocess.Popen] = None
        self.config_path: Optional[str] = None
        
        self.running = False
        self.stream_healthy = False
        self.reconnect_count = 0
        self.max_reconnects = 10
    
    def _write_go2rtc_config(self) -> str:
        """Write go2rtc config to a temp file and return the path."""
        config_content = generate_go2rtc_config(
            rtsp_url=self.rtsp_url,
            api_port=self.api_port,
            webrtc_port=self.webrtc_port
        )
        
        config_dir = Path("/tmp/go2rtc")
        config_dir.mkdir(parents=True, exist_ok=True)
        config_path = config_dir / "go2rtc.yaml"
        
        config_path.write_text(config_content)
        logger.info(f"go2rtc config written to {config_path}")
        logger.debug(f"Config:\n{config_content}")
        
        return str(config_path)
    
    def _start_go2rtc(self) -> bool:
        """Start the go2rtc process."""
        try:
            self.config_path = self._write_go2rtc_config()
            
            cmd = [GO2RTC_BINARY, "-config", self.config_path]
            logger.info(f"Starting go2rtc: {' '.join(cmd)}")
            
            self.go2rtc_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                preexec_fn=os.setsid
            )
            
            # Give go2rtc a moment to start and connect to RTSP
            time.sleep(3)
            
            if self.go2rtc_process.poll() is None:
                logger.info(f"go2rtc started (PID {self.go2rtc_process.pid})")
                return True
            else:
                output = self.go2rtc_process.stdout.read().decode() if self.go2rtc_process.stdout else ""
                logger.error(f"go2rtc failed to start: {output}")
                return False
                
        except FileNotFoundError:
            logger.error(f"go2rtc binary not found at '{GO2RTC_BINARY}'. "
                        "Install with: install_camera_services.sh")
            return False
        except Exception as e:
            logger.error(f"Failed to start go2rtc: {e}")
            return False
    
    def _stop_go2rtc(self):
        """Stop the go2rtc process."""
        if self.go2rtc_process:
            try:
                os.killpg(os.getpgid(self.go2rtc_process.pid), signal.SIGTERM)
                self.go2rtc_process.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(os.getpgid(self.go2rtc_process.pid), signal.SIGKILL)
                except Exception:
                    pass
            self.go2rtc_process = None
            logger.info("go2rtc stopped")
    
    def _check_stream_health(self) -> bool:
        """Check if go2rtc is healthy by querying its API."""
        if self.go2rtc_process is None or self.go2rtc_process.poll() is not None:
            return False
        
        if requests is None:
            # If requests not available, just check process is alive
            return True
        
        try:
            resp = requests.get(
                f"http://localhost:{self.api_port}/api/streams",
                timeout=3
            )
            if resp.status_code == 200:
                streams = resp.json()
                # Check if our camera stream exists and has producers
                camera = streams.get("camera", {})
                producers = camera.get("producers", [])
                return len(producers) > 0
            return False
        except Exception:
            return False
    
    def _detect_webrtc_url(self) -> Optional[str]:
        """
        Detect the public WebRTC signaling URL.
        
        Priority:
        1. Explicit --public-url flag
        2. Auto-detect Tailscale funnel URL
        3. Fall back to local URL (LAN only)
        """
        if self.public_url:
            url = f"{self.public_url.rstrip('/')}/api/webrtc?src=camera"
            logger.info(f"Using explicit public URL: {url}")
            return url
        
        # Try Tailscale auto-detection
        funnel_url = get_tailscale_funnel_url(
            funnel_port=self.funnel_port,
            max_retries=15,
            retry_interval=2.0
        )
        
        if funnel_url:
            url = f"{funnel_url}/api/webrtc?src=camera"
            logger.info(f"Using Tailscale funnel URL: {url}")
            return url
        
        # Fallback to local (won't work remotely)
        logger.warning("No public URL available. Stream will only be accessible on LAN.")
        url = f"http://localhost:{self.api_port}/api/webrtc?src=camera"
        return url
    
    def _register_stream_with_hub(self, webrtc_url: str):
        """Register the WebRTC stream URL with Quiver Hub."""
        if not self.hub_url or not self.drone_id or not self.api_key:
            logger.debug("Hub registration skipped: missing hub_url, drone_id, or api_key")
            return
        
        if requests is None:
            logger.warning("'requests' package not installed. Cannot register stream with Hub.")
            return
        
        try:
            rest_base = self.hub_url.replace("wss://", "https://").replace("ws://", "http://")
            rest_base = rest_base.rstrip("/ws").rstrip("/")
            register_url = f"{rest_base}/api/rest/camera/stream-register"
            
            response = requests.post(register_url, json={
                "api_key": self.api_key,
                "drone_id": self.drone_id,
                "webrtc_url": webrtc_url,
            }, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                logger.info(f"Stream registered with Hub. WebRTC URL: {webrtc_url}")
                self._stream_registered = True
            else:
                logger.warning(f"Stream registration failed ({response.status_code}): {response.text}")
                
        except Exception as e:
            logger.error(f"Failed to register stream with Hub: {e}")
    
    def _unregister_stream_from_hub(self):
        """Unregister the stream from Quiver Hub on shutdown."""
        if not self._stream_registered or not self.hub_url or not self.drone_id or not self.api_key:
            return
        
        if requests is None:
            return
        
        try:
            rest_base = self.hub_url.replace("wss://", "https://").replace("ws://", "http://")
            rest_base = rest_base.rstrip("/ws").rstrip("/")
            unregister_url = f"{rest_base}/api/rest/camera/stream-unregister"
            
            requests.post(unregister_url, json={
                "api_key": self.api_key,
                "drone_id": self.drone_id,
            }, timeout=5)
            
            logger.info("Stream unregistered from Hub")
            self._stream_registered = False
            
        except Exception as e:
            logger.warning(f"Failed to unregister stream from Hub: {e}")
    
    async def run(self):
        """Main service loop."""
        self.running = True
        
        # Setup Tailscale funnel if not skipped and no explicit public URL
        if not self.skip_funnel_setup and not self.public_url:
            logger.info("Setting up Tailscale funnel...")
            if not setup_tailscale_funnel(self.api_port, self.funnel_port):
                logger.warning("Tailscale funnel setup failed. "
                             "Stream may only be accessible on LAN.")
        
        while self.running:
            try:
                # Start go2rtc if not running
                if self.go2rtc_process is None or self.go2rtc_process.poll() is not None:
                    if self.reconnect_count >= self.max_reconnects:
                        logger.error("Max reconnection attempts reached. Waiting 30s...")
                        await asyncio.sleep(30)
                        self.reconnect_count = 0
                        continue
                    
                    logger.info(f"Starting go2rtc with RTSP source: {self.rtsp_url}")
                    
                    if self._start_go2rtc():
                        self.reconnect_count = 0
                    else:
                        self.reconnect_count += 1
                        logger.warning(f"Reconnect attempt {self.reconnect_count}/{self.max_reconnects}")
                        await asyncio.sleep(5)
                        continue
                
                # Monitor stream health
                was_healthy = self.stream_healthy
                self.stream_healthy = self._check_stream_health()
                
                if not self.stream_healthy and was_healthy:
                    logger.warning("Stream became unhealthy, restarting go2rtc...")
                    self._stop_go2rtc()
                    self.reconnect_count += 1
                    await asyncio.sleep(2)
                    continue
                
                # Register with Hub when stream first becomes healthy
                if self.stream_healthy and not was_healthy:
                    webrtc_url = self._detect_webrtc_url()
                    if webrtc_url:
                        self._register_stream_with_hub(webrtc_url)
                
                await asyncio.sleep(2)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                await asyncio.sleep(5)
        
        # Cleanup
        self._unregister_stream_from_hub()
        self._stop_go2rtc()
    
    def stop(self):
        """Stop the service."""
        self.running = False
    
    def get_status(self) -> dict:
        """Get current service status."""
        return {
            "running": self.running,
            "stream_type": self.stream_type,
            "rtsp_url": self.rtsp_url,
            "api_port": self.api_port,
            "webrtc_port": self.webrtc_port,
            "stream_healthy": self.stream_healthy,
            "go2rtc_running": self.go2rtc_process is not None and self.go2rtc_process.poll() is None,
            "reconnect_count": self.reconnect_count,
            "registered": self._stream_registered,
        }


# ============================================================================
# Combined Camera Service (Controller + Streaming)
# ============================================================================

class CombinedCameraService:
    """
    Combined service running both camera controller and video streaming.
    
    This is the recommended deployment: a single service that handles
    both gimbal control commands and WebRTC video streaming.
    """
    
    def __init__(self,
                 hub_url: str,
                 drone_id: str,
                 api_key: str,
                 stream_type: str = "sub",
                 rtsp_url: Optional[str] = None,
                 api_port: int = GO2RTC_API_PORT,
                 webrtc_port: int = GO2RTC_WEBRTC_PORT,
                 funnel_port: int = TAILSCALE_FUNNEL_PORT,
                 public_url: Optional[str] = None,
                 skip_funnel_setup: bool = False):
        
        # Import camera controller
        from siyi_camera_controller import CameraWebSocketBridge
        
        self.controller = CameraWebSocketBridge(hub_url, drone_id, api_key)
        self.streamer = WebRTCStreamingService(
            stream_type=stream_type,
            rtsp_url=rtsp_url,
            api_port=api_port,
            webrtc_port=webrtc_port,
            funnel_port=funnel_port,
            hub_url=hub_url,
            drone_id=drone_id,
            api_key=api_key,
            public_url=public_url,
            skip_funnel_setup=skip_funnel_setup,
        )
        
    async def run(self):
        """Run both services concurrently."""
        await asyncio.gather(
            self.controller.run(),
            self.streamer.run()
        )
    
    def stop(self):
        """Stop both services."""
        self.controller.stop()
        self.streamer.stop()


# ============================================================================
# Main Entry Point
# ============================================================================

async def main():
    parser = argparse.ArgumentParser(
        description='SIYI Camera WebRTC Streaming Service (go2rtc + Tailscale)'
    )
    parser.add_argument('--stream', type=str, choices=['main', 'sub'], default='sub',
                       help='Stream type: main (4K) or sub (720p)')
    parser.add_argument('--rtsp-url', type=str, default=None,
                       help='Override RTSP URL (e.g. rtsp://192.168.144.25:8554/sub.264)')
    parser.add_argument('--api-port', type=int, default=GO2RTC_API_PORT,
                       help=f'go2rtc API port (default: {GO2RTC_API_PORT})')
    parser.add_argument('--webrtc-port', type=int, default=GO2RTC_WEBRTC_PORT,
                       help=f'go2rtc WebRTC media port (default: {GO2RTC_WEBRTC_PORT})')
    parser.add_argument('--funnel-port', type=int, default=TAILSCALE_FUNNEL_PORT,
                       choices=[443, 8443, 10000],
                       help=f'Tailscale funnel port (default: {TAILSCALE_FUNNEL_PORT})')
    parser.add_argument('--combined', action='store_true',
                       help='Run combined service (streaming + gimbal controller)')
    parser.add_argument('--hub-url', type=str, default=None,
                       help='Quiver Hub URL for stream registration')
    parser.add_argument('--drone-id', type=str, default='quiver_001',
                       help='Drone identifier')
    parser.add_argument('--api-key', type=str, default='',
                       help='API key for Quiver Hub authentication')
    parser.add_argument('--public-url', type=str, default=None,
                       help='Override public URL (skip Tailscale auto-detection)')
    parser.add_argument('--skip-funnel-setup', action='store_true',
                       help='Skip Tailscale funnel setup (if already configured)')
    
    args = parser.parse_args()
    
    if args.combined:
        service = CombinedCameraService(
            hub_url=args.hub_url or '',
            drone_id=args.drone_id,
            api_key=args.api_key,
            stream_type=args.stream,
            rtsp_url=args.rtsp_url,
            api_port=args.api_port,
            webrtc_port=args.webrtc_port,
            funnel_port=args.funnel_port,
            public_url=args.public_url,
            skip_funnel_setup=args.skip_funnel_setup,
        )
    else:
        service = WebRTCStreamingService(
            stream_type=args.stream,
            rtsp_url=args.rtsp_url,
            api_port=args.api_port,
            webrtc_port=args.webrtc_port,
            funnel_port=args.funnel_port,
            hub_url=args.hub_url if args.api_key else None,
            drone_id=args.drone_id if args.api_key else None,
            api_key=args.api_key or None,
            public_url=args.public_url,
            skip_funnel_setup=args.skip_funnel_setup,
        )
    
    # Handle shutdown signals
    def signal_handler(sig, frame):
        logger.info("Shutdown signal received")
        service.stop()
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    try:
        await service.run()
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
        service.stop()


if __name__ == '__main__':
    asyncio.run(main())
