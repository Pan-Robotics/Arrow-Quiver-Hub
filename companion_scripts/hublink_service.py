#!/usr/bin/env python3
"""
Quiver HubLink - drone-side tailnet stream service (Tailscale Phase B).

The drone-side counterpart of the Hub's outbound "pull" subscriber
(server/droneSubscriber.ts). In push mode the companion POSTs telemetry *to*
one Hub (telemetry_forwarder.py). In pull mode the drone runs this small
WebSocket service on its tailnet (MagicDNS) or drone-subnet address and any
number of authorised Hubs connect *in* and pull the same stream. The drone is
the single arbiter of the control lease: at most one Hub commands it at a time.

Wire protocol (docs/architecture/Quiver_Drone_Stream_Protocol.md):
  - Transport: WebSocket, JSON text frames, one connection per subscribing Hub.
  - Auth: the Hub presents the per-drone API key in the WebSocket subprotocol as
    "bearer.<key>"; the negotiated app subprotocol is "quiver.stream.v1".
  - Drone -> Hub: hello, manifest, telemetry, camera_status, pointcloud, pong,
    lease_granted | lease_denied | lease_revoked | lease_released, command_result.
  - Hub -> Drone: ping, get_manifest, lease_acquire | lease_heartbeat |
    lease_release, command.
  - drone_id is NOT carried per frame; the Hub injects it from the connection.

Telemetry source - the local ingest bridge (default):
  The existing companion services keep working unchanged. Point them at this
  service instead of the Hub (TELEMETRY_HUB_URL=http://127.0.0.1:8765 for the
  telemetry forwarder) and it accepts the same REST bodies the Hub does:
      POST /api/rest/telemetry/ingest      {api_key, drone_id, timestamp, telemetry}
      POST /api/rest/camera/status         {api_key, drone_id, status:{...}} or flat
      POST /api/rest/pointcloud/ingest     {api_key, drone_id, timestamp, points, stats}
      POST /api/rest/test-connection       {api_key, drone_id}
      GET  /api/rest/health
  Each accepted body is fanned out immediately to every subscribed Hub as the
  matching stream frame. Only loopback clients may post unless --ingest-any.
  `--demo` emits synthetic telemetry instead, for benchtop tests of the pull path.

Commands: the reference implementation acknowledges commands that match the
capability manifest; wire real payload handlers in `execute_command`.

Configuration (shared INSTALL_DIR/.env via companion_config, or environment):
    DRONE_ID, API_KEY        identity; Hubs must present this API_KEY
    STREAM_HOST, STREAM_PORT bind address/port (default 0.0.0.0:8765)
    UPDATE_RATE_HZ           demo telemetry rate (default 10)
    LEASE_TTL_MS             control-lease lifetime without a heartbeat (default 30000)
    HUBLINK_STALE_S          drop subscribers' telemetry if no sample for N s (default 10)

Requires: aiohttp (already in requirements-companion.txt).
"""

import argparse
import asyncio
import ipaddress
import json
import logging
import math
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    from aiohttp import web, WSMsgType
except ImportError:  # pragma: no cover - dependency is pinned in requirements
    sys.stderr.write("ERROR: hublink_service.py requires 'aiohttp' (pip install -r requirements-companion.txt)\n")
    sys.exit(1)

try:
    from companion_config import load_environment
    CONFIG = load_environment()
except Exception:  # standalone use without the suite's config helper
    CONFIG = dict(os.environ)

PROTOCOL_VERSION = 1
APP_SUBPROTOCOL = f"quiver.stream.v{PROTOCOL_VERSION}"
DRONE_ID = CONFIG.get("DRONE_ID", "quiver_001")
API_KEY = CONFIG.get("API_KEY", "")
STREAM_HOST = CONFIG.get("STREAM_HOST", "0.0.0.0")
STREAM_PORT = int(CONFIG.get("STREAM_PORT", "8765") or 8765)
UPDATE_RATE_HZ = float(CONFIG.get("UPDATE_RATE_HZ", "10") or 10)
LEASE_TTL_MS = int(CONFIG.get("LEASE_TTL_MS", "30000") or 30000)
STALE_SECONDS = float(CONFIG.get("HUBLINK_STALE_S", "10") or 10)
MAX_BODY_BYTES = 8 * 1024 * 1024

logger = logging.getLogger("hublink")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── Telemetry sources ────────────────────────────────────────────────────────

class DemoTelemetrySource:
    """Synthetic telemetry in the same dict shape as the REST ingest / push
    forwarder, so a Hub treats pulled demo data exactly like real data."""

    def __init__(self) -> None:
        self._t0 = time.monotonic()
        self._batt = 100.0

    def sample(self) -> dict:
        t = time.monotonic() - self._t0
        self._batt = max(0.0, self._batt - 0.01)
        return {
            "attitude": {"roll_deg": 5.0 * math.sin(t * 0.5), "pitch_deg": 3.0 * math.cos(t * 0.4),
                         "yaw_deg": (t * 10.0) % 360.0, "timestamp": _now_iso()},
            "position": {"latitude_deg": 51.5074 + 0.0001 * math.sin(t * 0.1),
                         "longitude_deg": -0.1278 + 0.0001 * math.cos(t * 0.1),
                         "absolute_altitude_m": 100.0 + 5.0 * math.sin(t * 0.2),
                         "relative_altitude_m": 50.0 + 5.0 * math.sin(t * 0.2), "timestamp": _now_iso()},
            "gps": {"num_satellites": 14, "fix_type": 3, "timestamp": _now_iso()},
            "battery_fc": {"voltage_v": 22.2 * (0.6 + 0.4 * self._batt / 100.0),
                           "remaining_percent": self._batt, "timestamp": _now_iso()},
            "in_air": True,
        }


# ── Capability manifest ──────────────────────────────────────────────────────
# Per-payload typed commands this drone advertises. The Hub renders typed forms
# and rejects unknown actions locally; the drone stays the final authority.
# A production build derives this from the detected payload loadout.
DEFAULT_MANIFEST: Dict[str, Any] = {
    "payloads": [
        {
            "id": "camera",
            "name": "SIYI Gimbal Camera",
            "commands": [
                {"action": "set_zoom", "label": "Set Zoom",
                 "params": [{"name": "level", "type": "number", "label": "Zoom level",
                             "min": 1, "max": 6, "step": 1, "required": True, "default": 1}]},
                {"action": "center_gimbal", "label": "Center Gimbal", "params": []},
                {"action": "take_photo", "label": "Take Photo", "params": []},
                {"action": "start_recording", "label": "Start Recording", "params": []},
                {"action": "stop_recording", "label": "Stop Recording", "params": []},
            ],
        },
    ],
}


def load_manifest(path: Optional[str]) -> Dict[str, Any]:
    """Load a capability manifest JSON file, or fall back to the default."""
    if not path:
        return DEFAULT_MANIFEST
    with open(path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("payloads"), list):
        raise ValueError("manifest must be an object with a 'payloads' array")
    return manifest


def manifest_actions(manifest: Dict[str, Any]) -> set:
    actions = set()
    for payload in manifest.get("payloads", []):
        for command in (payload or {}).get("commands", []) or []:
            action = (command or {}).get("action")
            if isinstance(action, str):
                actions.add(action)
    return actions


# ── HubLink service ──────────────────────────────────────────────────────────

class HubLinkService:
    def __init__(self, expected_key: str, *, demo: bool, rate_hz: float, lease_ttl_ms: int,
                 manifest: Dict[str, Any], ingest_any: bool = False, stale_seconds: float = STALE_SECONDS) -> None:
        self.expected_key = expected_key
        self.demo_source = DemoTelemetrySource() if demo else None
        self.interval = 1.0 / rate_hz if rate_hz > 0 else 0.1
        self.lease_ttl_ms = lease_ttl_ms
        self.manifest = manifest
        self.known_actions = manifest_actions(manifest)
        self.ingest_any = ingest_any
        self.stale_seconds = stale_seconds
        self.clients: set = set()
        # Single-writer control lease: {id, hub_id, ws, expires_at_ms}
        self.lease: Optional[Dict[str, Any]] = None
        self.last_sample_at = 0.0
        self.frames_sent = 0
        self.ingested = {"telemetry": 0, "camera_status": 0, "pointcloud": 0}

    # ── fan-out ──

    async def broadcast(self, frame: Dict[str, Any]) -> None:
        if not self.clients:
            return
        data = json.dumps(frame)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_str(data)
                self.frames_sent += 1
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ── control lease (drone-authoritative) ──

    def _lease_active(self) -> bool:
        return self.lease is not None and self.lease["expires_at_ms"] > _now_ms()

    def _grant_lease(self, hub_id: str, ws) -> Dict[str, Any]:
        self.lease = {"id": uuid.uuid4().hex, "hub_id": hub_id, "ws": ws,
                      "expires_at_ms": _now_ms() + self.lease_ttl_ms}
        logger.info("Control lease GRANTED to %s (lease %s)", hub_id, self.lease["id"])
        return self.lease

    def _clear_lease(self, why: str) -> None:
        if self.lease:
            logger.info("Control lease cleared for %s (%s)", self.lease["hub_id"], why)
        self.lease = None

    async def execute_command(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Dispatch a lease-holder command to the payload. Reference: acknowledge
        manifest actions. Wire the SIYI controller / winch / etc. here."""
        logger.info("Executing command '%s' params=%s", action, params)
        return {"action": action, "accepted": True}

    async def _handle_control(self, ws, msg: Dict[str, Any]) -> bool:
        mtype = msg.get("type")
        req = msg.get("request_id")
        if mtype == "get_manifest":
            await ws.send_str(json.dumps({"type": "manifest", "payloads": self.manifest["payloads"]}))
            return True
        if mtype == "lease_acquire":
            hub_id = msg.get("hub_id") or "unknown"
            if not self._lease_active() or self.lease["hub_id"] == hub_id:
                lease = self._grant_lease(hub_id, ws)
                await ws.send_str(json.dumps({"type": "lease_granted", "lease_id": lease["id"],
                                              "ttl_ms": self.lease_ttl_ms, "request_id": req}))
            else:
                await ws.send_str(json.dumps({"type": "lease_denied", "held_by": self.lease["hub_id"],
                                              "reason": "held", "request_id": req}))
            return True
        if mtype == "lease_heartbeat":
            if self._lease_active() and self.lease["id"] == msg.get("lease_id"):
                self.lease["expires_at_ms"] = _now_ms() + self.lease_ttl_ms
            return True
        if mtype == "lease_release":
            if self.lease and self.lease["id"] == msg.get("lease_id"):
                lease_id = self.lease["id"]
                self._clear_lease("released by holder")
                await ws.send_str(json.dumps({"type": "lease_released", "lease_id": lease_id, "request_id": req}))
            return True
        if mtype == "command":
            lease_id = msg.get("lease_id")
            if not (self._lease_active() and self.lease["id"] == lease_id and self.lease["ws"] is ws):
                await ws.send_str(json.dumps({"type": "command_result", "request_id": req, "ok": False, "error": "no_control"}))
                return True
            action = msg.get("action")
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            if not isinstance(action, str) or action not in self.known_actions:
                await ws.send_str(json.dumps({"type": "command_result", "request_id": req, "ok": False, "error": "unknown_action"}))
                return True
            try:
                result = await self.execute_command(action, params)
                await ws.send_str(json.dumps({"type": "command_result", "request_id": req, "ok": True, "result": result}))
            except Exception as error:  # a payload failure must not drop the connection
                logger.exception("Command '%s' failed", action)
                await ws.send_str(json.dumps({"type": "command_result", "request_id": req, "ok": False, "error": "command_failed", "detail": str(error)[:200]}))
            return True
        return False

    async def _expiry_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            if self.lease and self.lease["expires_at_ms"] <= _now_ms():
                ws, lease_id = self.lease["ws"], self.lease["id"]
                self._clear_lease("expired (no heartbeat)")
                try:
                    await ws.send_str(json.dumps({"type": "lease_revoked", "lease_id": lease_id, "reason": "expired"}))
                except Exception:
                    pass

    async def _demo_loop(self) -> None:
        while True:
            await self.broadcast({"type": "telemetry", "timestamp": _now_iso(), "telemetry": self.demo_source.sample()})
            self.last_sample_at = time.monotonic()
            await asyncio.sleep(self.interval)

    # ── auth ──

    @staticmethod
    def _offered_subprotocols(request: web.Request) -> List[str]:
        raw = request.headers.get("Sec-WebSocket-Protocol", "")
        return [p.strip() for p in raw.split(",") if p.strip()]

    def _authorized_ws(self, offered: List[str]) -> bool:
        token = next((p[len("bearer."):] for p in offered if p.startswith("bearer.")), None)
        if not self.expected_key:
            logger.warning("No API_KEY configured: accepting Hub without authentication (benchtop only)")
            return True
        return token is not None and token == self.expected_key

    def _authorized_post(self, request: web.Request, body: Dict[str, Any]) -> Optional[str]:
        """Return an error string when a local ingest POST is not acceptable."""
        peer = request.remote or ""
        if not self.ingest_any:
            try:
                if not ipaddress.ip_address(peer).is_loopback:
                    return "ingest is loopback-only (start with --ingest-any to accept other hosts)"
            except ValueError:
                return "ingest is loopback-only"
        if self.expected_key and body.get("api_key") != self.expected_key:
            return "Invalid API key"
        if body.get("drone_id") not in (None, DRONE_ID):
            return "Drone ID mismatch"
        return None

    # ── WebSocket handler (Hub subscribers) ──

    async def ws_handler(self, request: web.Request) -> web.StreamResponse:
        offered = self._offered_subprotocols(request)
        if APP_SUBPROTOCOL not in offered:
            return web.Response(status=426, text=f"Subprotocol {APP_SUBPROTOCOL} required")
        if not self._authorized_ws(offered):
            logger.warning("Rejected unauthenticated Hub from %s", request.remote)
            return web.Response(status=401, text="unauthorized")
        ws = web.WebSocketResponse(protocols=(APP_SUBPROTOCOL,), heartbeat=None, max_msg_size=1024 * 1024)
        await ws.prepare(request)
        self.clients.add(ws)
        logger.info("Hub subscribed from %s (%d active)", request.remote, len(self.clients))
        try:
            services = ["telemetry", "control", "camera_status", "pointcloud"]
            await ws.send_str(json.dumps({"type": "hello", "protocol": PROTOCOL_VERSION, "services": services}))
            await ws.send_str(json.dumps({"type": "manifest", "payloads": self.manifest["payloads"]}))
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    if message.type in (WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSING):
                        break
                    continue
                try:
                    msg = json.loads(message.data)
                except (ValueError, TypeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "ping":
                    await ws.send_str(json.dumps({"type": "pong", "ts": msg.get("ts")}))
                    continue
                await self._handle_control(ws, msg)
        finally:
            self.clients.discard(ws)
            if self.lease and self.lease["ws"] is ws:
                self._clear_lease("holder disconnected")
            logger.info("Hub unsubscribed from %s (%d active)", request.remote, len(self.clients))
        return ws

    # ── Local ingest bridge (REST-compatible with the Hub) ──

    async def _read_json(self, request: web.Request) -> Optional[Dict[str, Any]]:
        if request.content_length and request.content_length > MAX_BODY_BYTES:
            return None
        try:
            body = await request.json()
        except Exception:
            return None
        return body if isinstance(body, dict) else None

    async def ingest_telemetry(self, request: web.Request) -> web.Response:
        body = await self._read_json(request)
        if body is None:
            return web.json_response({"success": False, "error": "Invalid JSON body"}, status=400)
        error = self._authorized_post(request, body)
        if error:
            return web.json_response({"success": False, "error": error}, status=401 if "key" in error else 403)
        telemetry = body.get("telemetry")
        if not isinstance(telemetry, dict):
            return web.json_response({"success": False, "error": "Missing required fields: api_key, drone_id, timestamp, telemetry"}, status=400)
        timestamp = body.get("timestamp") if isinstance(body.get("timestamp"), str) else _now_iso()
        await self.broadcast({"type": "telemetry", "timestamp": timestamp, "telemetry": telemetry})
        self.last_sample_at = time.monotonic()
        self.ingested["telemetry"] += 1
        return web.json_response({"success": True, "message": "Telemetry data received",
                                  "stats": {"drone_id": DRONE_ID, "timestamp": timestamp, "subscribers": len(self.clients)}})

    async def ingest_camera_status(self, request: web.Request) -> web.Response:
        body = await self._read_json(request)
        if body is None:
            return web.json_response({"success": False, "error": "Invalid JSON body"}, status=400)
        error = self._authorized_post(request, body)
        if error:
            return web.json_response({"success": False, "error": error}, status=401 if "key" in error else 403)
        status = body.get("status") if isinstance(body.get("status"), dict) else body
        if not isinstance(status.get("connected"), bool):
            return web.json_response({"success": False, "error": "camera status requires boolean 'connected'"}, status=400)
        frame: Dict[str, Any] = {"type": "camera_status", "connected": status["connected"]}
        for key in ("attitude", "recording", "hdr_enabled", "tf_card_present", "zoom_level"):
            if key in status:
                frame[key] = status[key]
        frame["timestamp"] = _now_ms()
        await self.broadcast(frame)
        self.ingested["camera_status"] += 1
        return web.json_response({"success": True})

    async def ingest_pointcloud(self, request: web.Request) -> web.Response:
        body = await self._read_json(request)
        if body is None:
            return web.json_response({"success": False, "error": "Invalid JSON body"}, status=400)
        error = self._authorized_post(request, body)
        if error:
            return web.json_response({"success": False, "error": error}, status=401 if "key" in error else 403)
        points, stats = body.get("points"), body.get("stats")
        if not isinstance(points, list) or not isinstance(stats, dict):
            return web.json_response({"success": False, "error": "Missing required fields: points, stats"}, status=400)
        timestamp = body.get("timestamp") if isinstance(body.get("timestamp"), str) else _now_iso()
        await self.broadcast({"type": "pointcloud", "timestamp": timestamp, "points": points, "stats": stats})
        self.ingested["pointcloud"] += 1
        return web.json_response({"success": True, "stats": {"point_count": len(points), "subscribers": len(self.clients)}})

    async def test_connection(self, request: web.Request) -> web.Response:
        body = await self._read_json(request) or {}
        error = self._authorized_post(request, body)
        if error:
            return web.json_response({"success": False, "error": error}, status=401 if "key" in error else 403)
        return web.json_response({"success": True, "message": "HubLink reachable", "drone_id": DRONE_ID,
                                  "server_time": _now_iso(), "subscribers": len(self.clients)})

    async def health(self, _request: web.Request) -> web.Response:
        age = (time.monotonic() - self.last_sample_at) if self.last_sample_at else None
        return web.json_response({
            "success": True, "status": "healthy", "service": "hublink", "drone_id": DRONE_ID,
            "protocol": APP_SUBPROTOCOL, "subscribers": len(self.clients),
            "lease_held_by": self.lease["hub_id"] if self._lease_active() else None,
            "last_sample_age_s": None if age is None else round(age, 1),
            "telemetry_stale": age is None or age > self.stale_seconds,
            "ingested": dict(self.ingested), "frames_sent": self.frames_sent,
            "source": "demo" if self.demo_source else "local-ingest", "timestamp": _now_iso(),
        })

    # ── app ──

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=MAX_BODY_BYTES)
        app.router.add_get("/", self.ws_handler)
        app.router.add_get("/stream", self.ws_handler)
        app.router.add_get("/api/rest/health", self.health)
        app.router.add_post("/api/rest/test-connection", self.test_connection)
        app.router.add_post("/api/rest/telemetry/ingest", self.ingest_telemetry)
        app.router.add_post("/api/rest/camera/status", self.ingest_camera_status)
        app.router.add_post("/api/rest/pointcloud/ingest", self.ingest_pointcloud)

        async def start_background(_app: web.Application) -> None:
            _app["expiry"] = asyncio.create_task(self._expiry_loop())
            if self.demo_source:
                _app["demo"] = asyncio.create_task(self._demo_loop())

        async def stop_background(_app: web.Application) -> None:
            for key in ("expiry", "demo"):
                task = _app.get(key)
                if task:
                    task.cancel()
            for ws in list(self.clients):
                try:
                    await ws.close(code=1001, message=b"shutdown")
                except Exception:
                    pass

        app.on_startup.append(start_background)
        app.on_shutdown.append(stop_background)
        return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Quiver HubLink drone-side stream service (pull mode)")
    parser.add_argument("--host", default=STREAM_HOST, help="Bind address (default: STREAM_HOST or 0.0.0.0)")
    parser.add_argument("--port", type=int, default=STREAM_PORT, help="Listen port (default: STREAM_PORT or 8765)")
    parser.add_argument("--rate", type=float, default=UPDATE_RATE_HZ, help="Demo telemetry rate in Hz")
    parser.add_argument("--demo", action="store_true", help="Emit synthetic telemetry instead of the local ingest bridge")
    parser.add_argument("--manifest", default=CONFIG.get("HUBLINK_MANIFEST", ""), help="Capability manifest JSON file")
    parser.add_argument("--ingest-any", action="store_true", help="Accept ingest POSTs from non-loopback hosts (API key still required)")
    parser.add_argument("--check", action="store_true", help="Validate configuration and exit")
    parser.add_argument("--debug", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s [HubLink] %(levelname)s %(message)s")
    if not (1 <= args.port <= 65535):
        parser.error("--port must be 1..65535")
    try:
        manifest = load_manifest(args.manifest or None)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(f"invalid manifest: {error}")
    if not API_KEY:
        logger.warning("API_KEY is empty: Hubs will not be authenticated. Set it in the shared .env for any deployment.")
    if args.check:
        print(f"HubLink configuration OK: drone {DRONE_ID}, bind {args.host}:{args.port}, "
              f"{len(manifest_actions(manifest))} manifest actions, auth {'on' if API_KEY else 'OFF'}")
        return
    service = HubLinkService(API_KEY, demo=args.demo, rate_hz=args.rate, lease_ttl_ms=LEASE_TTL_MS,
                             manifest=manifest, ingest_any=args.ingest_any)
    logger.info("HubLink for drone '%s' listening on ws://%s:%d/ (subprotocol %s, auth %s, source %s)",
                DRONE_ID, args.host, args.port, APP_SUBPROTOCOL, "on" if API_KEY else "OFF",
                "demo" if args.demo else "local ingest bridge")
    web.run_app(service.build_app(), host=args.host, port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
