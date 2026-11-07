import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const suite = resolve("companion_scripts");

function python(code: string, env: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", code], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
}

const hasAiohttp = python("import aiohttp").status === 0;
const itIf = hasAiohttp ? it : it.skip;

describe("hublink_service.py (pull-mode stream service)", () => {
  it("compiles and validates its configuration offline (--check)", () => {
    const compiled = spawnSync("python3", ["-m", "py_compile", join(suite, "hublink_service.py")], { encoding: "utf8" });
    expect(compiled.status, compiled.stderr).toBe(0);
    if (!hasAiohttp) return;
    const root = mkdtempSync(join(tmpdir(), "quiver-hublink-"));
    try {
      for (const name of ["hublink_service.py", "companion_config.py", "companion-config.example"]) {
        copyFileSync(join(suite, name), join(root, name));
      }
      writeFileSync(join(root, ".env"), "DRONE_ID=quiver_test\nAPI_KEY=k\nSTREAM_PORT=9\n");
      const result = spawnSync("python3", [join(root, "hublink_service.py"), "--check"], { encoding: "utf8", cwd: root, timeout: 30000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("drone quiver_test");
      expect(result.stdout).toContain("auth on");
      const badPort = spawnSync("python3", [join(root, "hublink_service.py"), "--check", "--port", "70000"], { encoding: "utf8", cwd: root, timeout: 30000 });
      expect(badPort.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itIf("authenticates Hubs, bridges REST ingest into stream frames, arbitrates the lease and validates commands", () => {
    // Runs the real service in-process on an ephemeral loopback port and drives
    // it with an aiohttp client: exactly what the Hub subscriber does on the wire.
    const result = python(`
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(suite)})
import os
os.environ["DRONE_ID"] = "quiver_test"
os.environ["API_KEY"] = "secret-key"
import importlib
hublink = importlib.import_module("hublink_service")
hublink.DRONE_ID = "quiver_test"
from aiohttp import web, ClientSession, WSMsgType

async def main():
    svc = hublink.HubLinkService("secret-key", demo=False, rate_hz=10, lease_ttl_ms=400, manifest=hublink.DEFAULT_MANIFEST)
    runner = web.AppRunner(svc.build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    base = f"http://127.0.0.1:{port}"
    out = {}
    async with ClientSession() as s:
        # health before anything
        async with s.get(base + "/api/rest/health") as r:
            h = await r.json(); out["health0"] = (r.status, h["subscribers"], h["telemetry_stale"], h["source"])
        # wrong subprotocol / wrong key / right key
        try:
            await s.ws_connect(base + "/stream", protocols=("bearer.secret-key",))
            out["no_proto"] = "connected"
        except Exception as e:
            out["no_proto"] = getattr(e, "status", type(e).__name__)
        try:
            await s.ws_connect(base + "/stream", protocols=("quiver.stream.v1", "bearer.wrong"))
            out["bad_key"] = "connected"
        except Exception as e:
            out["bad_key"] = getattr(e, "status", type(e).__name__)
        hubA = await s.ws_connect(base + "/stream?drone_id=quiver_test", protocols=("quiver.stream.v1", "bearer.secret-key"))
        hubB = await s.ws_connect(base + "/stream", protocols=("quiver.stream.v1", "bearer.secret-key"))
        async def recv(ws, want, tries=20):
            for _ in range(tries):
                m = await asyncio.wait_for(ws.receive(), 5)
                if m.type != WSMsgType.TEXT:
                    return None
                d = json.loads(m.data)
                if d.get("type") == want:
                    return d
            return None
        out["protocol"] = hubA.protocol
        hello = await recv(hubA, "hello"); out["hello"] = hello["services"]
        man = await recv(hubA, "manifest"); out["manifest_actions"] = sorted(c["action"] for p in man["payloads"] for c in p["commands"])
        await recv(hubB, "manifest")
        # ping/pong
        await hubA.send_str(json.dumps({"type": "ping", "ts": 123}))
        out["pong"] = (await recv(hubA, "pong"))["ts"]
        # REST ingest bridge: rejected key, then accepted sample reaches BOTH hubs
        async with s.post(base + "/api/rest/telemetry/ingest", json={"api_key": "nope", "drone_id": "quiver_test", "timestamp": "t", "telemetry": {}}) as r:
            out["ingest_bad_key"] = r.status
        async with s.post(base + "/api/rest/telemetry/ingest", json={"api_key": "secret-key", "drone_id": "other", "timestamp": "t", "telemetry": {}}) as r:
            out["ingest_wrong_drone"] = r.status
        async with s.post(base + "/api/rest/telemetry/ingest", json={"api_key": "secret-key", "drone_id": "quiver_test", "timestamp": "2026-01-01T00:00:00Z", "telemetry": {"position": {"relative_altitude_m": 12.5}}}) as r:
            out["ingest_ok"] = (r.status, (await r.json())["stats"]["subscribers"])
        tA = await recv(hubA, "telemetry"); tB = await recv(hubB, "telemetry")
        out["telemetry"] = (tA["timestamp"], tA["telemetry"]["position"]["relative_altitude_m"], tB["telemetry"]["position"]["relative_altitude_m"], "drone_id" in tA)
        async with s.post(base + "/api/rest/camera/status", json={"api_key": "secret-key", "drone_id": "quiver_test", "status": {"connected": True, "zoom_level": 2.0}}) as r:
            out["camera_ok"] = r.status
        cam = await recv(hubA, "camera_status"); out["camera"] = (cam["connected"], cam["zoom_level"], isinstance(cam["timestamp"], int))
        async with s.post(base + "/api/rest/pointcloud/ingest", json={"api_key": "secret-key", "drone_id": "quiver_test", "points": [[1, 2, 3]], "stats": {"point_count": 1}}) as r:
            out["pc_ok"] = r.status
        pc = await recv(hubA, "pointcloud"); out["pointcloud"] = (len(pc["points"]), pc["stats"]["point_count"])
        async with s.post(base + "/api/rest/test-connection", json={"api_key": "secret-key", "drone_id": "quiver_test"}) as r:
            out["test_connection"] = (await r.json())["success"]
        # lease: A acquires, B is denied, B cannot command, A can; unknown action rejected
        await hubA.send_str(json.dumps({"type": "lease_acquire", "hub_id": "hub-A", "request_id": "r1"}))
        g = await recv(hubA, "lease_granted"); out["granted"] = (g["request_id"], g["ttl_ms"])
        await hubB.send_str(json.dumps({"type": "lease_acquire", "hub_id": "hub-B", "request_id": "r2"}))
        d = await recv(hubB, "lease_denied"); out["denied"] = (d["held_by"], d["reason"])
        await hubB.send_str(json.dumps({"type": "command", "lease_id": g["lease_id"], "action": "set_zoom", "params": {"level": 2}, "request_id": "c0"}))
        out["b_command"] = (await recv(hubB, "command_result"))["error"]
        await hubA.send_str(json.dumps({"type": "command", "lease_id": g["lease_id"], "action": "set_zoom", "params": {"level": 2}, "request_id": "c1"}))
        c1 = await recv(hubA, "command_result"); out["a_command"] = (c1["ok"], c1["result"]["action"])
        await hubA.send_str(json.dumps({"type": "command", "lease_id": g["lease_id"], "action": "self_destruct", "params": {}, "request_id": "c2"}))
        out["unknown_action"] = (await recv(hubA, "command_result"))["error"]
        async with s.get(base + "/api/rest/health") as r:
            h = await r.json(); out["health1"] = (h["subscribers"], h["lease_held_by"], h["telemetry_stale"], h["ingested"]["telemetry"])
        # lease expiry without heartbeat -> revoked, then B can take it
        rv = await recv(hubA, "lease_revoked", tries=30); out["revoked"] = rv["reason"]
        await hubB.send_str(json.dumps({"type": "lease_acquire", "hub_id": "hub-B", "request_id": "r3"}))
        out["b_granted"] = (await recv(hubB, "lease_granted"))["request_id"]
        await hubB.close()
        await asyncio.sleep(0.2)
        # holder disconnect frees the lease: A can acquire again and release it
        await hubA.send_str(json.dumps({"type": "lease_acquire", "hub_id": "hub-A", "request_id": "r4"}))
        g2 = await recv(hubA, "lease_granted"); out["a_regranted"] = g2["request_id"]
        await hubA.send_str(json.dumps({"type": "lease_release", "lease_id": g2["lease_id"], "request_id": "r5"}))
        out["released"] = (await recv(hubA, "lease_released"))["request_id"]
        await hubA.close()
    await runner.cleanup()
    print(json.dumps(out))

asyncio.run(main())
`);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim().split("\n").pop()!);
    expect(out.health0).toEqual([200, 0, true, "local-ingest"]);
    expect(out.no_proto).toBe(426);
    expect(out.bad_key).toBe(401);
    expect(out.protocol).toBe("quiver.stream.v1");
    expect(out.hello).toEqual(["telemetry", "control", "camera_status", "pointcloud"]);
    expect(out.manifest_actions).toContain("set_zoom");
    expect(out.pong).toBe(123);
    expect(out.ingest_bad_key).toBe(401);
    expect(out.ingest_wrong_drone).toBe(403);
    expect(out.ingest_ok).toEqual([200, 2]);
    expect(out.telemetry).toEqual(["2026-01-01T00:00:00Z", 12.5, 12.5, false]);
    expect(out.camera_ok).toBe(200);
    expect(out.camera).toEqual([true, 2.0, true]);
    expect(out.pc_ok).toBe(200);
    expect(out.pointcloud).toEqual([1, 1]);
    expect(out.test_connection).toBe(true);
    expect(out.granted).toEqual(["r1", 400]);
    expect(out.denied).toEqual(["hub-A", "held"]);
    expect(out.b_command).toBe("no_control");
    expect(out.a_command).toEqual([true, "set_zoom"]);
    expect(out.unknown_action).toBe("unknown_action");
    expect(out.health1).toEqual([2, "hub-A", false, 1]);
    expect(out.revoked).toBe("expired");
    expect(out.b_granted).toBe("r3");
    expect(out.a_regranted).toBe("r4");
    expect(out.released).toBe("r5");
  });

  it("the telemetry forwarder honours TELEMETRY_HUB_URL (local bridge) over WEB_SERVER_URL", () => {
    const source = readFileSync(join(suite, "telemetry_forwarder.py"), "utf8");
    expect(source).toMatch(/WEB_SERVER_URL = CONFIG\.get\('TELEMETRY_HUB_URL', ''\)\.strip\(\) or CONFIG\.get\('WEB_SERVER_URL', ''\)/);
  });
});
