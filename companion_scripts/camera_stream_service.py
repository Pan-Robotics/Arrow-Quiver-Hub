#!/usr/bin/env python3
"""
SIYI A8 Mini RTSP to HLS Video Streaming Service

This script captures the RTSP video stream from the SIYI A8 mini camera
and transcodes it to HLS (HTTP Live Streaming) format for web delivery.

The HLS stream is served via a local HTTP server that Quiver Hub can proxy.
A cloudflared quick tunnel exposes the local HLS server to the internet so
the cloud-hosted Hub can reach it — no manual URL configuration needed.

Features:
- RTSP to HLS transcoding via FFmpeg (stream copy, no re-encoding)
- Automatic cloudflared tunnel URL detection
- Automatic reconnection on stream failure
- Low-latency configuration for real-time viewing
- Health monitoring and status reporting

RTSP Sources:
- Main stream (4K): rtsp://192.168.144.25:8554/main.264
- Sub stream (720p): rtsp://192.168.144.25:8554/sub.264

Usage:
    python camera_stream_service.py --stream sub --port 8080 \\
        --hub-url https://your-hub.example.com \\
        --drone-id quiver_001 --api-key YOUR_KEY

Cloudflared Tunnel:
    This script auto-detects the public URL from a cloudflared quick tunnel
    running alongside it. Start cloudflared with a fixed metrics port:

        cloudflared tunnel --url http://localhost:8080 --metrics 127.0.0.1:33843

    The script polls http://127.0.0.1:33843/quicktunnel to discover the
    public hostname and registers it with the Hub instead of the LAN IP.
    See companion systemd files: cloudflared-hls.service, camera-stream.service
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
import threading
import socket
from http.server import HTTPServer, SimpleHTTPRequestHandler
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

# SIYI A8 RTSP paths:
#   /main.264  - Main stream (4K)
#   /sub.264   - Sub stream (720p)
#   /video1    - Legacy main stream path (older firmware)
#   /video2    - Legacy sub stream path (older firmware)
# Use --rtsp-url to override if your camera uses a different path
RTSP_STREAMS = {
    "main": f"rtsp://{SIYI_CAMERA_IP}:{RTSP_PORT}/main.264",   # 4K
    "sub": f"rtsp://{SIYI_CAMERA_IP}:{RTSP_PORT}/sub.264",     # 720p (lower bandwidth)
}

# Default HLS output directory
DEFAULT_HLS_DIR = "/tmp/hls_stream"

# FFmpeg HLS settings optimized for low latency
HLS_SETTINGS = {
    "segment_time": 1,          # 1 second segments for low latency
    "list_size": 3,             # Keep only 3 segments in playlist
    "delete_threshold": 1,      # Delete old segments quickly
    "start_number": 0,
}

# Cloudflared tunnel auto-detection
DEFAULT_CLOUDFLARED_METRICS_PORT = 33843
TUNNEL_DETECT_TIMEOUT = 60       # Max seconds to wait for tunnel on startup
TUNNEL_DETECT_INTERVAL = 2       # Seconds between detection attempts


# ============================================================================
# CORS-enabled HTTP Handler
# ============================================================================

class CORSHTTPRequestHandler(SimpleHTTPRequestHandler):
    """HTTP handler with CORS headers for cross-origin access."""
    
    def __init__(self, *args, directory=None, **kwargs):
        self.directory = directory
        super().__init__(*args, directory=directory, **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
    
    def log_message(self, format, *args):
        # Suppress HTTP request logging (too verbose)
        pass


# ============================================================================
# Cloudflared Tunnel Detection
# ============================================================================

def detect_tunnel_url(metrics_port: int = DEFAULT_CLOUDFLARED_METRICS_PORT,
                      timeout: int = TUNNEL_DETECT_TIMEOUT,
                      interval: int = TUNNEL_DETECT_INTERVAL) -> Optional[str]:
    """
    Auto-detect the public URL from a running cloudflared quick tunnel.
    
    Cloudflared exposes a /quicktunnel endpoint on its metrics HTTP server
    that returns JSON: {"hostname": "abc123.trycloudflare.com"}
    
    Args:
        metrics_port: The port cloudflared's metrics server is listening on.
                      Must match the --metrics flag used when starting cloudflared.
        timeout: Maximum seconds to wait for the tunnel to become available.
        interval: Seconds between polling attempts.
    
    Returns:
        The public HTTPS URL (e.g. "https://abc123.trycloudflare.com") or None.
    """
    if requests is None:
        logger.warning("'requests' package not installed. Cannot detect tunnel URL.")
        return None
    
    metrics_url = f"http://127.0.0.1:{metrics_port}/quicktunnel"
    deadline = time.time() + timeout
    attempt = 0
    
    logger.info(f"Waiting for cloudflared tunnel (polling {metrics_url}, timeout {timeout}s)...")
    
    while time.time() < deadline:
        attempt += 1
        try:
            resp = requests.get(metrics_url, timeout=3)
            if resp.status_code == 200:
                data = resp.json()
                hostname = data.get("hostname")
                if hostname:
                    public_url = f"https://{hostname}"
                    logger.info(f"Cloudflared tunnel detected: {public_url} (attempt {attempt})")
                    return public_url
                else:
                    logger.debug(f"Tunnel response missing hostname: {data}")
            else:
                logger.debug(f"Tunnel metrics returned {resp.status_code} (attempt {attempt})")
        except requests.ConnectionError:
            logger.debug(f"Tunnel not ready yet (attempt {attempt})")
        except Exception as e:
            logger.debug(f"Tunnel detection error: {e} (attempt {attempt})")
        
        time.sleep(interval)
    
    logger.warning(f"Cloudflared tunnel not detected after {timeout}s ({attempt} attempts)")
    return None


# ============================================================================
# HLS Streaming Service
# ============================================================================

class HLSStreamingService:
    """
    Service that captures RTSP stream and converts to HLS.
    
    Uses FFmpeg to:
    1. Connect to RTSP stream from SIYI camera
    2. Remux H.264 into HLS segments (stream copy, no re-encoding)
    3. Output HLS segments (.ts) and playlist (.m3u8)
    4. Serve via built-in HTTP server
    
    On startup, if cloudflared tunnel detection is enabled, the service
    polls the cloudflared metrics endpoint to discover the public URL.
    It then registers the public URL (not the LAN IP) with the Hub so
    the cloud-hosted proxy can reach the stream.
    """
    
    def __init__(self,
                 stream_type: str = "sub",
                 http_port: int = 8080,
                 hls_dir: str = DEFAULT_HLS_DIR,
                 hub_url: Optional[str] = None,
                 drone_id: Optional[str] = None,
                 api_key: Optional[str] = None,
                 rtsp_url: Optional[str] = None,
                 tunnel_metrics_port: Optional[int] = None,
                 public_url: Optional[str] = None):
        
        self.stream_type = stream_type
        self.rtsp_url = rtsp_url or RTSP_STREAMS.get(stream_type, RTSP_STREAMS["sub"])
        self.http_port = http_port
        self.hls_dir = Path(hls_dir)
        
        # Quiver Hub registration
        self.hub_url = hub_url          # e.g. "https://your-quiver-hub.com"
        self.drone_id = drone_id
        self.api_key = api_key
        self._stream_registered = False
        
        # Tunnel configuration
        self.tunnel_metrics_port = tunnel_metrics_port  # None = disabled
        self.public_url = public_url                    # Manual override
        self._tunnel_url: Optional[str] = None          # Auto-detected URL
        
        self.ffmpeg_process: Optional[subprocess.Popen] = None
        self.http_server: Optional[HTTPServer] = None
        self.http_thread: Optional[threading.Thread] = None
        
        self.running = False
        self.stream_healthy = False
        self.last_segment_time = 0
        self.reconnect_count = 0
        self.max_reconnects = 10
        
    def _setup_hls_directory(self):
        """Create and clean HLS output directory."""
        self.hls_dir.mkdir(parents=True, exist_ok=True)
        
        # Clean old segments
        for f in self.hls_dir.glob("*.ts"):
            f.unlink()
        for f in self.hls_dir.glob("*.m3u8"):
            f.unlink()
            
        logger.info(f"HLS directory ready: {self.hls_dir}")
    
    def _build_ffmpeg_command(self) -> list:
        """
        Build FFmpeg command for RTSP to HLS conversion.
        
        Uses -c:v copy to remux the camera's existing H.264 stream into HLS
        segments without re-encoding. This is critical for the Pi 5 which has
        no hardware H.264 encoder — software encoding (libx264) would pin the
        CPU at 100% and cause thermal shutdown.
        
        Optimized for:
        - Near-zero CPU usage (stream copy, no transcoding)
        - Low latency (small segments, minimal buffering)
        - Use the sub-stream (720p) to keep bandwidth reasonable
        """
        output_path = self.hls_dir / "stream.m3u8"
        
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            
            # RTSP input settings
            "-rtsp_transport", "tcp",       # Use TCP for reliability
            "-fflags", "nobuffer",          # Reduce buffering
            "-flags", "low_delay",          # Low delay mode
            "-strict", "experimental",
            "-i", self.rtsp_url,
            
            # Video: copy the existing H.264 stream as-is (no re-encoding)
            # The SIYI camera already outputs H.264, so we just remux into
            # HLS .ts segments. This uses ~1-2% CPU vs ~100% with libx264.
            "-c:v", "copy",
            
            # Note: with -c:v copy, scaling (-vf scale=...) and bitrate
            # limits (-b:v, -maxrate, -bufsize) are not available.
            # Use the sub-stream (720p) instead of main (4K) to control
            # resolution and bandwidth at the source.
        ]
        
        # Audio: disable (camera typically has no mic)
        cmd.extend(["-an"])
        
        # HLS output settings
        cmd.extend([
            "-f", "hls",
            "-hls_time", str(HLS_SETTINGS["segment_time"]),
            "-hls_list_size", str(HLS_SETTINGS["list_size"]),
            "-hls_flags", "delete_segments+append_list+omit_endlist",
            "-hls_delete_threshold", str(HLS_SETTINGS["delete_threshold"]),
            "-hls_segment_filename", str(self.hls_dir / "segment_%03d.ts"),
            "-start_number", str(HLS_SETTINGS["start_number"]),
            str(output_path)
        ])
        
        return cmd
    
    def _start_ffmpeg(self) -> bool:
        """Start FFmpeg process."""
        try:
            cmd = self._build_ffmpeg_command()
            logger.info(f"Starting FFmpeg: {' '.join(cmd[:10])}...")
            
            self.ffmpeg_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid  # Create new process group
            )
            
            # Give FFmpeg a moment to start
            time.sleep(2)
            
            if self.ffmpeg_process.poll() is None:
                logger.info("FFmpeg started successfully")
                return True
            else:
                stderr = self.ffmpeg_process.stderr.read().decode()
                logger.error(f"FFmpeg failed to start: {stderr}")
                return False
                
        except Exception as e:
            logger.error(f"Failed to start FFmpeg: {e}")
            return False
    
    def _stop_ffmpeg(self):
        """Stop FFmpeg process."""
        if self.ffmpeg_process:
            try:
                os.killpg(os.getpgid(self.ffmpeg_process.pid), signal.SIGTERM)
                self.ffmpeg_process.wait(timeout=5)
            except:
                try:
                    os.killpg(os.getpgid(self.ffmpeg_process.pid), signal.SIGKILL)
                except:
                    pass
            self.ffmpeg_process = None
            logger.info("FFmpeg stopped")
    
    def _start_http_server(self):
        """Start HTTP server to serve HLS files."""
        try:
            handler = lambda *args, **kwargs: CORSHTTPRequestHandler(
                *args, directory=str(self.hls_dir), **kwargs
            )
            
            self.http_server = HTTPServer(('0.0.0.0', self.http_port), handler)
            
            self.http_thread = threading.Thread(
                target=self.http_server.serve_forever,
                daemon=True
            )
            self.http_thread.start()
            
            logger.info(f"HTTP server started on port {self.http_port}")
            logger.info(f"HLS stream available at: http://localhost:{self.http_port}/stream.m3u8")
            
        except Exception as e:
            logger.error(f"Failed to start HTTP server: {e}")
            raise
    
    def _stop_http_server(self):
        """Stop HTTP server."""
        if self.http_server:
            self.http_server.shutdown()
            self.http_server = None
            logger.info("HTTP server stopped")
    
    def _get_local_ip(self) -> str:
        """Get the local IP address of this machine."""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"
    
    def _get_stream_base_url(self) -> str:
        """
        Determine the base URL to register with the Hub.
        
        Priority order:
        1. Manual --public-url override (for fixed/named tunnels)
        2. Auto-detected cloudflared tunnel URL
        3. Fallback to LAN IP (only works if Hub is on same network)
        """
        if self.public_url:
            logger.info(f"Using manual public URL: {self.public_url}")
            return self.public_url
        
        if self._tunnel_url:
            logger.info(f"Using cloudflared tunnel URL: {self._tunnel_url}")
            return self._tunnel_url
        
        local_ip = self._get_local_ip()
        local_url = f"http://{local_ip}:{self.http_port}"
        logger.warning(f"No tunnel available, falling back to LAN URL: {local_url}")
        logger.warning("The Hub will only be able to proxy if it can reach this LAN address.")
        return local_url
    
    def _detect_tunnel(self):
        """
        Attempt to auto-detect the cloudflared tunnel URL.
        Called once during startup before the main loop.
        """
        if self.tunnel_metrics_port is None:
            logger.debug("Tunnel detection disabled (no --tunnel-metrics-port)")
            return
        
        self._tunnel_url = detect_tunnel_url(
            metrics_port=self.tunnel_metrics_port,
            timeout=TUNNEL_DETECT_TIMEOUT,
            interval=TUNNEL_DETECT_INTERVAL,
        )
        
        if self._tunnel_url:
            logger.info(f"Will register stream via tunnel: {self._tunnel_url}")
        else:
            logger.warning("Tunnel detection failed. Will fall back to LAN IP.")
    
    def _register_stream_with_hub(self):
        """
        Register the HLS stream URL with Quiver Hub.
        The Hub will then proxy requests from the browser to this URL.
        
        Uses the tunnel URL if available, otherwise falls back to LAN IP.
        """
        if not self.hub_url or not self.drone_id or not self.api_key:
            logger.debug("Hub registration skipped: missing hub_url, drone_id, or api_key")
            return
        
        if requests is None:
            logger.warning("'requests' package not installed. Cannot register stream with Hub.")
            logger.warning("Install with: pip install requests")
            return
        
        base_url = self._get_stream_base_url()
        stream_url = f"{base_url}/stream.m3u8"
        
        try:
            # Convert ws/wss URL to http/https for REST call
            rest_base = self.hub_url.replace("wss://", "https://").replace("ws://", "http://")
            rest_base = rest_base.rstrip("/ws").rstrip("/")
            register_url = f"{rest_base}/api/rest/camera/stream-register"
            
            logger.info(f"Registering stream with Hub: {stream_url}")
            
            response = requests.post(register_url, json={
                "api_key": self.api_key,
                "drone_id": self.drone_id,
                "stream_url": stream_url,
            }, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                logger.info(f"Stream registered with Hub. Proxy URL: {data.get('proxy_url')}")
                self._stream_registered = True
            else:
                logger.warning(f"Stream registration failed ({response.status_code}): {response.text}")
                
        except Exception as e:
            logger.error(f"Failed to register stream with Hub: {e}")
    
    def _unregister_stream_from_hub(self):
        """Unregister the HLS stream from Quiver Hub on shutdown."""
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
    
    def _check_stream_health(self) -> bool:
        """Check if stream is healthy by monitoring segment creation."""
        playlist_path = self.hls_dir / "stream.m3u8"
        
        if not playlist_path.exists():
            return False
        
        # Check if playlist was recently modified
        mtime = playlist_path.stat().st_mtime
        age = time.time() - mtime
        
        if age > 5:  # No update in 5 seconds
            return False
        
        # Check if segments exist
        segments = list(self.hls_dir.glob("segment_*.ts"))
        if len(segments) == 0:
            return False
        
        return True
    
    async def run(self):
        """Main service loop."""
        self.running = True
        
        # Setup
        self._setup_hls_directory()
        self._start_http_server()
        
        # Detect cloudflared tunnel before entering main loop
        self._detect_tunnel()
        
        while self.running:
            try:
                # Start FFmpeg if not running
                if self.ffmpeg_process is None or self.ffmpeg_process.poll() is not None:
                    if self.reconnect_count >= self.max_reconnects:
                        logger.error("Max reconnection attempts reached")
                        await asyncio.sleep(30)
                        self.reconnect_count = 0
                        continue
                    
                    logger.info(f"Connecting to RTSP stream: {self.rtsp_url}")
                    
                    if self._start_ffmpeg():
                        self.reconnect_count = 0
                    else:
                        self.reconnect_count += 1
                        logger.warning(f"Reconnect attempt {self.reconnect_count}/{self.max_reconnects}")
                        await asyncio.sleep(5)
                        continue
                
                # Monitor stream health
                was_healthy = self.stream_healthy
                self.stream_healthy = self._check_stream_health()
                
                if not self.stream_healthy:
                    logger.warning("Stream unhealthy, restarting FFmpeg...")
                    self._stop_ffmpeg()
                    self.reconnect_count += 1
                    await asyncio.sleep(2)
                    continue
                
                # Register with Hub when stream first becomes healthy
                if self.stream_healthy and not was_healthy:
                    self._register_stream_with_hub()
                
                await asyncio.sleep(1)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                await asyncio.sleep(5)
        
        # Cleanup
        self._unregister_stream_from_hub()
        self._stop_ffmpeg()
        self._stop_http_server()
    
    def stop(self):
        """Stop the service."""
        self.running = False
    
    def get_status(self) -> dict:
        """Get current service status."""
        return {
            "running": self.running,
            "stream_type": self.stream_type,
            "rtsp_url": self.rtsp_url,
            "http_port": self.http_port,
            "hls_url": f"http://localhost:{self.http_port}/stream.m3u8",
            "tunnel_url": self._tunnel_url,
            "public_url": self.public_url,
            "stream_healthy": self.stream_healthy,
            "ffmpeg_running": self.ffmpeg_process is not None and self.ffmpeg_process.poll() is None,
            "reconnect_count": self.reconnect_count
        }


# ============================================================================
# Combined Camera Service (Controller + Streaming)
# ============================================================================

class CombinedCameraService:
    """
    Combined service running both camera controller and video streaming.
    
    This is the recommended deployment: a single service that handles
    both gimbal control commands and video streaming.
    """
    
    def __init__(self,
                 hub_url: str,
                 drone_id: str,
                 api_key: str,
                 stream_type: str = "sub",
                 http_port: int = 8080,
                 rtsp_url: Optional[str] = None,
                 tunnel_metrics_port: Optional[int] = None,
                 public_url: Optional[str] = None):
        
        # Import camera controller
        from siyi_camera_controller import CameraWebSocketBridge
        
        self.controller = CameraWebSocketBridge(hub_url, drone_id, api_key)
        self.streamer = HLSStreamingService(
            stream_type=stream_type,
            http_port=http_port,
            hub_url=hub_url,
            drone_id=drone_id,
            api_key=api_key,
            rtsp_url=rtsp_url,
            tunnel_metrics_port=tunnel_metrics_port,
            public_url=public_url,
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
    parser = argparse.ArgumentParser(description='SIYI Camera RTSP to HLS Streaming Service')
    parser.add_argument('--stream', type=str, choices=['main', 'sub'], default='sub',
                       help='Stream type: main (4K) or sub (720p)')
    parser.add_argument('--rtsp-url', type=str, default=None,
                       help='Override RTSP URL (e.g. rtsp://192.168.144.25:8554/main.264)')
    parser.add_argument('--port', type=int, default=8080,
                       help='HTTP port for HLS server')
    parser.add_argument('--hls-dir', type=str, default=DEFAULT_HLS_DIR,
                       help='Directory for HLS output files')
    parser.add_argument('--combined', action='store_true',
                       help='Run combined service (streaming + controller)')
    parser.add_argument('--hub-url', type=str, default='wss://localhost:3000/ws',
                       help='Quiver Hub URL (for stream registration and combined mode)')
    parser.add_argument('--drone-id', type=str, default='quiver_001',
                       help='Drone identifier')
    parser.add_argument('--api-key', type=str, default='',
                       help='API key for Quiver Hub authentication')
    
    # Tunnel options
    parser.add_argument('--tunnel-metrics-port', type=int, default=None,
                       help='Cloudflared metrics port for tunnel URL auto-detection '
                            '(e.g. 33843). Omit to disable tunnel detection and use LAN IP.')
    parser.add_argument('--public-url', type=str, default=None,
                       help='Manual override for the public stream URL registered with Hub. '
                            'Use this for named tunnels with a fixed domain. '
                            'Takes priority over auto-detected tunnel URL.')
    
    args = parser.parse_args()
    
    if args.combined:
        # Combined mode: controller + streaming
        service = CombinedCameraService(
            hub_url=args.hub_url,
            drone_id=args.drone_id,
            api_key=args.api_key,
            stream_type=args.stream,
            http_port=args.port,
            rtsp_url=args.rtsp_url,
            tunnel_metrics_port=args.tunnel_metrics_port,
            public_url=args.public_url,
        )
    else:
        # Streaming only mode (still registers with Hub if credentials provided)
        service = HLSStreamingService(
            stream_type=args.stream,
            http_port=args.port,
            hls_dir=args.hls_dir,
            hub_url=args.hub_url if args.api_key else None,
            drone_id=args.drone_id if args.api_key else None,
            api_key=args.api_key or None,
            rtsp_url=args.rtsp_url,
            tunnel_metrics_port=args.tunnel_metrics_port,
            public_url=args.public_url,
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
