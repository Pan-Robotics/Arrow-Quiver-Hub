#!/usr/bin/env python3
"""
SIYI A8 Mini RTSP to HLS Video Streaming Service

This script captures the RTSP video stream from the SIYI A8 mini camera
and transcodes it to HLS (HTTP Live Streaming) format for web delivery.

The HLS stream is served via a local HTTP server that Quiver Hub can proxy.

Features:
- RTSP to HLS transcoding via FFmpeg
- Automatic reconnection on stream failure
- Low-latency configuration for real-time viewing
- Health monitoring and status reporting

RTSP Sources:
- Main stream (4K): rtsp://192.168.144.25:8554/video1
- Sub stream (720p): rtsp://192.168.144.25:8554/video2

Usage:
    python camera_stream_service.py --stream main --port 8080
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

RTSP_STREAMS = {
    "main": f"rtsp://{SIYI_CAMERA_IP}:{RTSP_PORT}/video1",   # 4K
    "sub": f"rtsp://{SIYI_CAMERA_IP}:{RTSP_PORT}/video2",    # 720p (lower bandwidth)
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
# HLS Streaming Service
# ============================================================================

class HLSStreamingService:
    """
    Service that captures RTSP stream and converts to HLS.
    
    Uses FFmpeg to:
    1. Connect to RTSP stream from SIYI camera
    2. Transcode to H.264 (if needed) with low-latency settings
    3. Output HLS segments (.ts) and playlist (.m3u8)
    4. Serve via built-in HTTP server
    """
    
    def __init__(self, 
                 stream_type: str = "sub",
                 http_port: int = 8080,
                 hls_dir: str = DEFAULT_HLS_DIR,
                 hub_url: Optional[str] = None,
                 drone_id: Optional[str] = None,
                 api_key: Optional[str] = None):
        
        self.stream_type = stream_type
        self.rtsp_url = RTSP_STREAMS.get(stream_type, RTSP_STREAMS["sub"])
        self.http_port = http_port
        self.hls_dir = Path(hls_dir)
        
        # Quiver Hub registration
        self.hub_url = hub_url          # e.g. "https://your-quiver-hub.com"
        self.drone_id = drone_id
        self.api_key = api_key
        self._stream_registered = False
        
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
        
        Optimized for:
        - Low latency (small segments, minimal buffering)
        - Web compatibility (H.264 baseline profile)
        - Bandwidth efficiency (appropriate bitrate for stream type)
        """
        output_path = self.hls_dir / "stream.m3u8"
        
        # Base settings
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
            
            # Video encoding settings
            "-c:v", "libx264",              # H.264 codec
            "-preset", "ultrafast",         # Fastest encoding
            "-tune", "zerolatency",         # Zero latency tuning
            "-profile:v", "baseline",       # Baseline profile for compatibility
            "-level", "3.1",
        ]
        
        # Bitrate based on stream type
        if self.stream_type == "main":
            cmd.extend(["-b:v", "4000k", "-maxrate", "4500k", "-bufsize", "8000k"])
        else:
            cmd.extend(["-b:v", "1500k", "-maxrate", "2000k", "-bufsize", "3000k"])
        
        # Scale down if main stream (4K is too heavy for web)
        if self.stream_type == "main":
            cmd.extend(["-vf", "scale=1920:1080"])
        
        # Audio settings (copy if present, or disable)
        cmd.extend(["-an"])  # Disable audio for now (camera may not have mic)
        
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
    
    def _register_stream_with_hub(self):
        """
        Register the HLS stream URL with Quiver Hub.
        The Hub will then proxy requests from the browser to this local server.
        """
        if not self.hub_url or not self.drone_id or not self.api_key:
            logger.debug("Hub registration skipped: missing hub_url, drone_id, or api_key")
            return
        
        if requests is None:
            logger.warning("'requests' package not installed. Cannot register stream with Hub.")
            logger.warning("Install with: pip install requests")
            return
        
        local_ip = self._get_local_ip()
        stream_url = f"http://{local_ip}:{self.http_port}/stream.m3u8"
        
        try:
            # Convert ws/wss URL to http/https for REST call
            rest_base = self.hub_url.replace("wss://", "https://").replace("ws://", "http://")
            rest_base = rest_base.rstrip("/ws").rstrip("/")
            register_url = f"{rest_base}/api/rest/camera/stream-register"
            
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
                 http_port: int = 8080):
        
        # Import camera controller
        from siyi_camera_controller import CameraWebSocketBridge
        
        self.controller = CameraWebSocketBridge(hub_url, drone_id, api_key)
        self.streamer = HLSStreamingService(
            stream_type=stream_type,
            http_port=http_port,
            hub_url=hub_url,
            drone_id=drone_id,
            api_key=api_key
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
    
    args = parser.parse_args()
    
    if args.combined:
        # Combined mode: controller + streaming
        service = CombinedCameraService(
            hub_url=args.hub_url,
            drone_id=args.drone_id,
            api_key=args.api_key,
            stream_type=args.stream,
            http_port=args.port
        )
    else:
        # Streaming only mode (still registers with Hub if credentials provided)
        service = HLSStreamingService(
            stream_type=args.stream,
            http_port=args.port,
            hls_dir=args.hls_dir,
            hub_url=args.hub_url if args.api_key else None,
            drone_id=args.drone_id if args.api_key else None,
            api_key=args.api_key or None
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
