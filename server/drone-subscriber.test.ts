import { describe, it, expect, vi, beforeEach } from "vitest";
import { interpretDroneFrame, parseDroneFrame, normalizeManifest, DRONE_STREAM_PROTOCOL_VERSION } from "./droneStreamProtocol";

// The manager imports ./websocket (Socket.IO) and ./db; stub both so the unit
// tests stay isolated and never touch sockets or the filesystem. The manager
// itself is exercised purely through injected dependencies.
vi.mock("./websocket", () => ({
  broadcastTelemetry: vi.fn(),
  broadcastCameraStatus: vi.fn(),
  broadcastPointCloud: vi.fn(),
  broadcastControlStatus: vi.fn(),
  broadcastCapabilities: vi.fn(),
}));
vi.mock("./db", () => ({
  getPullDrones: vi.fn().mockResolvedValue([]),
  getActiveApiKeyForDrone: vi.fn().mockResolvedValue(null),
  insertTelemetry: vi.fn(),
  upsertDrone: vi.fn(),
}));

import {
  DroneSubscriberManager,
  STREAM_SUBPROTOCOL,
  type StreamSocketFactory,
  type StreamSocketHandlers,
  type DispatchSink,
  type DroneConnConfig,
  type ControlStatus,
} from "./droneSubscriber";

const flush = () => new Promise((r) => setImmediate(r));

// ── Pure interpreter ─────────────────────────────────────────────────────────

describe("droneStreamProtocol.interpretDroneFrame", () => {
  const clock = { nowIso: () => "2020-01-01T00:00:00.000Z", nowMs: () => 1577836800000 };

  it("parses hello with protocol + services", () => {
    const d = interpretDroneFrame("drone-1", JSON.stringify({ type: "hello", protocol: 1, services: ["telemetry", "x"] }));
    expect(d).toEqual({ kind: "hello", protocol: 1, services: ["telemetry", "x"] });
  });

  it("defaults hello protocol/services when missing", () => {
    const d = interpretDroneFrame("drone-1", JSON.stringify({ type: "hello" }));
    expect(d).toEqual({ kind: "hello", protocol: DRONE_STREAM_PROTOCOL_VERSION, services: [] });
  });

  it("maps telemetry and injects drone_id from the connection (not the frame)", () => {
    const d = interpretDroneFrame(
      "drone-1",
      JSON.stringify({ type: "telemetry", drone_id: "SPOOFED", timestamp: "2026-01-01T00:00:00Z", telemetry: { in_air: true } })
    );
    expect(d.kind).toBe("telemetry");
    if (d.kind !== "telemetry") throw new Error("unreachable");
    expect(d.message.drone_id).toBe("drone-1");
    expect(d.message.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(d.message.telemetry).toEqual({ in_air: true });
  });

  it("stamps server time when telemetry omits a timestamp", () => {
    const d = interpretDroneFrame("drone-1", JSON.stringify({ type: "telemetry", telemetry: {} }), clock);
    if (d.kind !== "telemetry") throw new Error("expected telemetry");
    expect(d.message.timestamp).toBe("2020-01-01T00:00:00.000Z");
  });

  it("errors on telemetry without a telemetry object", () => {
    const d = interpretDroneFrame("drone-1", JSON.stringify({ type: "telemetry" }));
    expect(d.kind).toBe("error");
  });

  it("maps camera_status with epoch-ms timestamp and only present optionals", () => {
    const d = interpretDroneFrame(
      "drone-1",
      JSON.stringify({ type: "camera_status", connected: true, recording: false, zoom_level: 2 })
    , clock);
    if (d.kind !== "camera_status") throw new Error("expected camera_status");
    expect(d.message.drone_id).toBe("drone-1");
    expect(d.message.timestamp).toBe(1577836800000);
    expect(d.message.connected).toBe(true);
    expect(d.message.recording).toBe(false);
    expect(d.message.zoom_level).toBe(2);
    expect("attitude" in d.message).toBe(false);
  });

  it("errors on camera_status without boolean connected", () => {
    const d = interpretDroneFrame("drone-1", JSON.stringify({ type: "camera_status" }));
    expect(d.kind).toBe("error");
  });

  it("maps pointcloud and injects drone_id", () => {
    const d = interpretDroneFrame(
      "drone-1",
      JSON.stringify({ type: "pointcloud", points: [{ x: 1 }], stats: { point_count: 1 } })
    );
    if (d.kind !== "pointcloud") throw new Error("expected pointcloud");
    expect(d.message.drone_id).toBe("drone-1");
    expect(d.message.points).toEqual([{ x: 1 }]);
  });

  it("errors on pointcloud missing points/stats", () => {
    expect(interpretDroneFrame("d", JSON.stringify({ type: "pointcloud", points: [] })).kind).toBe("error");
    expect(interpretDroneFrame("d", JSON.stringify({ type: "pointcloud", stats: {} })).kind).toBe("error");
  });

  it("returns pong for pong frames", () => {
    expect(interpretDroneFrame("d", JSON.stringify({ type: "pong", ts: 1 })).kind).toBe("pong");
  });

  it("ignores unknown frame types (forward-compatible)", () => {
    const d = interpretDroneFrame("d", JSON.stringify({ type: "something_new", foo: 1 }));
    expect(d.kind).toBe("ignored");
  });

  it("errors on invalid JSON and on missing type", () => {
    expect(interpretDroneFrame("d", "not json").kind).toBe("error");
    expect(interpretDroneFrame("d", JSON.stringify({ foo: 1 })).kind).toBe("error");
  });

  it("parses Buffer and ArrayBuffer payloads", () => {
    const json = JSON.stringify({ type: "pong" });
    expect(parseDroneFrame(Buffer.from(json)).type).toBe("pong");
    const ab = new TextEncoder().encode(json).buffer;
    expect(parseDroneFrame(ab).type).toBe("pong");
  });

  // ── Control / lease frames (Phase B2) ──

  it("parses lease_granted with ttl + request id, defaults ttl to 0", () => {
    const d = interpretDroneFrame("d", JSON.stringify({ type: "lease_granted", lease_id: "L1", ttl_ms: 5000, request_id: "acq-1" }));
    expect(d).toEqual({ kind: "lease_granted", leaseId: "L1", ttlMs: 5000, requestId: "acq-1" });
    const d2 = interpretDroneFrame("d", JSON.stringify({ type: "lease_granted", lease_id: "L1" }));
    expect(d2).toEqual({ kind: "lease_granted", leaseId: "L1", ttlMs: 0, requestId: null });
  });

  it("errors on lease_granted without lease_id", () => {
    expect(interpretDroneFrame("d", JSON.stringify({ type: "lease_granted" })).kind).toBe("error");
  });

  it("parses lease_denied with holder + reason", () => {
    const d = interpretDroneFrame("d", JSON.stringify({ type: "lease_denied", held_by: "hub-other", reason: "held", request_id: "acq-1" }));
    expect(d).toEqual({ kind: "lease_denied", heldBy: "hub-other", reason: "held", requestId: "acq-1" });
    const d2 = interpretDroneFrame("d", JSON.stringify({ type: "lease_denied" }));
    expect(d2).toEqual({ kind: "lease_denied", heldBy: null, reason: null, requestId: null });
  });

  it("parses lease_revoked and lease_released", () => {
    expect(interpretDroneFrame("d", JSON.stringify({ type: "lease_revoked", reason: "expired" }))).toEqual({ kind: "lease_revoked", leaseId: null, reason: "expired" });
    expect(interpretDroneFrame("d", JSON.stringify({ type: "lease_released", lease_id: "L1" }))).toEqual({ kind: "lease_released", leaseId: "L1", requestId: null });
  });

  it("parses command_result and errors when malformed", () => {
    const d = interpretDroneFrame("d", JSON.stringify({ type: "command_result", request_id: "cmd-1", ok: true, result: { x: 1 } }));
    expect(d).toEqual({ kind: "command_result", requestId: "cmd-1", ok: true, result: { x: 1 }, error: null });
    expect(interpretDroneFrame("d", JSON.stringify({ type: "command_result", ok: true })).kind).toBe("error");
    expect(interpretDroneFrame("d", JSON.stringify({ type: "command_result", request_id: "x" })).kind).toBe("error");
  });

  // ── Capability manifest (B-next) ──

  it("normalizes a well-formed manifest", () => {
    const m = normalizeManifest({
      payloads: [
        {
          id: "camera",
          name: "Cam",
          commands: [
            { action: "set_zoom", label: "Zoom", params: [{ name: "level", type: "number", min: 1, max: 10, required: true }] },
            { action: "start", params: [] },
          ],
        },
      ],
    });
    expect(m.payloads).toHaveLength(1);
    expect(m.payloads[0].name).toBe("Cam");
    expect(m.payloads[0].commands.map((c) => c.action)).toEqual(["set_zoom", "start"]);
    expect(m.payloads[0].commands[0].params[0]).toMatchObject({ name: "level", type: "number", min: 1, max: 10, required: true });
  });

  it("drops malformed payloads/commands/params and defaults unknown param types to string", () => {
    const m = normalizeManifest({
      payloads: [
        { name: "no-id" }, // dropped (no id)
        {
          id: "p1",
          commands: [
            { label: "no action" }, // dropped (no action)
            { action: "ok", params: [{ name: "x", type: "weird" }, { type: "noname" }] },
          ],
        },
      ],
    });
    expect(m.payloads).toHaveLength(1);
    expect(m.payloads[0].id).toBe("p1");
    expect(m.payloads[0].commands).toHaveLength(1);
    expect(m.payloads[0].commands[0].params).toHaveLength(1); // the nameless param dropped
    expect(m.payloads[0].commands[0].params[0]).toEqual({ name: "x", type: "string" }); // unknown type → string
  });

  it("normalizes garbage to an empty manifest", () => {
    expect(normalizeManifest(null)).toEqual({ payloads: [] });
    expect(normalizeManifest({ payloads: "nope" })).toEqual({ payloads: [] });
  });

  it("interpretDroneFrame maps a manifest frame", () => {
    const d = interpretDroneFrame("d", JSON.stringify({ type: "manifest", payloads: [{ id: "c", commands: [] }] }));
    expect(d.kind).toBe("manifest");
    if (d.kind !== "manifest") throw new Error("unreachable");
    expect(d.manifest.payloads[0].id).toBe("c");
  });
});

// ── Manager lifecycle with a fake transport ──────────────────────────────────

interface FakeSocket {
  url: string;
  protocols: string[];
  handlers: StreamSocketHandlers;
  sent: string[];
  closed: boolean;
}

function makeHarness() {
  const sockets: FakeSocket[] = [];
  const factory: StreamSocketFactory = (url, protocols, handlers) => {
    const s: FakeSocket = { url, protocols, handlers, sent: [], closed: false };
    sockets.push(s);
    return {
      send: (d) => s.sent.push(d),
      close: () => {
        s.closed = true;
      },
    };
  };

  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false };
    scheduled.push(t);
    return { cancel: () => (t.cancelled = true) };
  };
  const runNextScheduled = () => {
    const t = scheduled.find((x) => !x.cancelled);
    if (!t) return false;
    t.cancelled = true;
    t.fn();
    return true;
  };

  const calls = { telemetry: [] as any[], cameraStatus: [] as any[], pointcloud: [] as any[], markSeen: [] as any[] };
  const sink: DispatchSink = {
    telemetry: (m) => void calls.telemetry.push(m),
    cameraStatus: (m) => void calls.cameraStatus.push(m),
    pointcloud: (m) => void calls.pointcloud.push(m),
    markSeen: (id, when) => void calls.markSeen.push({ id, when }),
  };

  let drones: DroneConnConfig[] = [];
  const setDrones = (d: DroneConnConfig[]) => (drones = d);

  const controlEvents: ControlStatus[] = [];
  const capabilityEvents: { droneId: string; manifest: any }[] = [];

  const manager = new DroneSubscriberManager({
    socketFactory: factory,
    loadPullDrones: async () => drones,
    sink,
    schedule,
    heartbeatMs: 0, // disable heartbeat noise in tests
    backoffMinMs: 10,
    backoffMaxMs: 100,
    log: () => {},
    hubId: "hub-test",
    onControlChange: (s) => controlEvents.push(s),
    onCapabilitiesChange: (droneId, manifest) => capabilityEvents.push({ droneId, manifest }),
    acquireTimeoutMs: 5000,
    commandTimeoutMs: 5000,
    leaseTtlDefaultMs: 1000,
  });

  // Only the live (not-closed) socket for a drone, by index order.
  const liveSockets = () => sockets.filter((s) => !s.closed);
  // Parse the frames a socket has sent (newest first).
  const sentFrames = (s: FakeSocket) => s.sent.map((j) => JSON.parse(j));

  return { manager, sockets, liveSockets, scheduled, runNextScheduled, calls, setDrones, controlEvents, capabilityEvents, sentFrames };
}

const droneA: DroneConnConfig = { droneId: "A", host: "a.tnet.ts.net", port: 8765, token: "tokA" };
const droneB: DroneConnConfig = { droneId: "B", host: "b.tnet.ts.net", port: 8765, token: "tokB" };

describe("DroneSubscriberManager", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens one connection per pull drone, with subprotocol-carried auth", async () => {
    const h = makeHarness();
    h.setDrones([droneA, droneB]);
    await h.manager.start();

    expect(h.manager.size).toBe(2);
    expect(h.sockets).toHaveLength(2);
    const a = h.sockets[0];
    expect(a.url).toBe("ws://a.tnet.ts.net:8765/stream?drone_id=A");
    expect(a.protocols).toContain(STREAM_SUBPROTOCOL);
    expect(a.protocols).toContain("bearer.tokA");
  });

  it("routes inbound frames to the sink with injected drone_id", async () => {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    const s = h.sockets[0];
    s.handlers.onOpen();

    s.handlers.onMessage(JSON.stringify({ type: "telemetry", timestamp: "2026-01-01T00:00:00Z", telemetry: { in_air: true } }));
    s.handlers.onMessage(JSON.stringify({ type: "camera_status", connected: true }));
    s.handlers.onMessage(JSON.stringify({ type: "pointcloud", points: [], stats: { point_count: 0 } }));
    await flush();

    expect(h.calls.telemetry).toHaveLength(1);
    expect(h.calls.telemetry[0].drone_id).toBe("A");
    expect(h.calls.markSeen).toHaveLength(1);
    expect(h.calls.cameraStatus).toHaveLength(1);
    expect(h.calls.pointcloud).toHaveLength(1);
  });

  it("reconcile() drops a drone no longer in pull mode", async () => {
    const h = makeHarness();
    h.setDrones([droneA, droneB]);
    await h.manager.start();
    expect(h.manager.size).toBe(2);

    h.setDrones([droneA]);
    await h.manager.reconcile();

    expect(h.manager.size).toBe(1);
    expect(h.sockets[1].closed).toBe(true); // B's socket closed
  });

  it("reconcile() recreates a connection when host/port/token changes", async () => {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    expect(h.sockets).toHaveLength(1);

    h.setDrones([{ ...droneA, host: "a2.tnet.ts.net" }]);
    await h.manager.reconcile();

    expect(h.sockets[0].closed).toBe(true);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].url).toContain("a2.tnet.ts.net");
    expect(h.manager.size).toBe(1);
  });

  it("reconnects with backoff after an unexpected close", async () => {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    const s = h.sockets[0];
    s.handlers.onOpen();

    s.handlers.onClose(1006, "abnormal");
    // A reconnect should have been scheduled.
    expect(h.scheduled.some((t) => !t.cancelled)).toBe(true);

    const reopened = h.runNextScheduled();
    expect(reopened).toBe(true);
    expect(h.sockets).toHaveLength(2); // new socket created on reconnect
  });

  it("schedules a reconnect when the socket errors before opening (no close follows)", async () => {
    // Regression: undici can fire `error` without a following `close` for a
    // failure during the opening handshake. The connection must not park.
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    const s = h.sockets[0];

    // Error with NO subsequent onClose (the parking failure mode).
    s.handlers.onError(new Error("handshake failed"));
    expect(h.scheduled.some((t) => !t.cancelled)).toBe(true);

    expect(h.runNextScheduled()).toBe(true);
    expect(h.sockets).toHaveLength(2); // reconnected rather than parked
  });

  it("survives close() re-firing error synchronously while still connecting (Node 22 undici)", async () => {
    // Regression: on Node 22, WebSocket.close() while CONNECTING synchronously
    // dispatches another `error`. handleError -> close() -> error -> handleError
    // recursed until the stack overflowed and the reconnect was never armed, so a
    // drone that was unreachable at Hub start was never retried.
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    const s = h.sockets[0];
    let reentrant = 0;
    // Emulate undici: closing a CONNECTING socket re-fires onError immediately.
    const closeWithReentry = () => {
      reentrant++;
      if (reentrant < 50) s.handlers.onError(new Error("ECONNREFUSED (re-fired by close)"));
      s.closed = true;
    };
    (h.manager as any).connections.get("A").socket.close = closeWithReentry;

    expect(() => s.handlers.onError(new Error("ECONNREFUSED"))).not.toThrow();
    expect(h.manager.status()[0].reconnectAttempts).toBe(1);
    expect(h.scheduled.filter((t) => !t.cancelled)).toHaveLength(1);

    // The retry actually happens, and a late event from the dead socket is ignored.
    expect(h.runNextScheduled()).toBe(true);
    expect(h.sockets).toHaveLength(2);
    s.handlers.onClose(1006, "late close from the first socket");
    expect(h.manager.status()[0].reconnectAttempts).toBe(1);
    expect(h.scheduled.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("dedupes a coincident error+close into a single reconnect attempt", async () => {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    const s = h.sockets[0];

    s.handlers.onError(new Error("boom"));
    s.handlers.onClose(1006, "after error");

    // Both paths funnel through failAttempt, but only one reconnect is counted.
    expect(h.manager.status()[0].reconnectAttempts).toBe(1);
  });

  it("does not reconnect after an explicit stop()", async () => {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    const s = h.sockets[0];
    s.handlers.onOpen();

    h.manager.stop();
    expect(s.closed).toBe(true);
    expect(h.manager.size).toBe(0);

    // A close arriving after stop must not schedule a reconnect.
    const before = h.scheduled.length;
    s.handlers.onClose(1000, "normal");
    expect(h.scheduled.length).toBe(before);
  });

  it("reconcile() is a no-op before start()", async () => {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.reconcile();
    expect(h.manager.size).toBe(0);
  });
});

// ── Control lease state machine (Phase B2) ───────────────────────────────────

describe("DroneSubscriberManager control lease", () => {
  beforeEach(() => vi.clearAllMocks());

  async function openHarness() {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    h.sockets[0].handlers.onOpen();
    return h;
  }

  it("acquireControl sends lease_acquire and resolves granted on lease_granted", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const p = h.manager.acquireControl("A");

    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    expect(acquire).toBeTruthy();
    expect(acquire.hub_id).toBe("hub-test");

    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", ttl_ms: 1000, request_id: acquire.request_id }));
    await flush();

    const result = await p;
    expect(result.granted).toBe(true);
    const status = h.manager.controlStatus("A");
    expect(status.state).toBe("held");
    expect(status.haveControl).toBe(true);
    expect(status.leaseId).toBe("L1");
    // A control-change event was emitted to browsers.
    expect(h.controlEvents.some((e) => e.state === "held")).toBe(true);
  });

  it("resolves denied with the current holder", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const p = h.manager.acquireControl("A");
    s.handlers.onMessage(JSON.stringify({ type: "lease_denied", held_by: "hub-other", reason: "held" }));
    await flush();

    const result = await p;
    expect(result.granted).toBe(false);
    expect(result.heldBy).toBe("hub-other");
    expect(h.manager.controlStatus("A").state).toBe("denied");
  });

  it("sendCommand fails fast without control", async () => {
    const h = await openHarness();
    const r = await h.manager.sendCommand("A", "do_thing");
    expect(r).toEqual({ ok: false, result: null, error: "no_control" });
  });

  it("sendCommand round-trips while holding control", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const ap = h.manager.acquireControl("A");
    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", ttl_ms: 1000, request_id: acquire.request_id }));
    await flush();
    await ap;

    const cp = h.manager.sendCommand("A", "set_zoom", { level: 2 });
    const cmd = h.sentFrames(s).find((f) => f.type === "command");
    expect(cmd).toBeTruthy();
    expect(cmd.lease_id).toBe("L1");
    expect(cmd.action).toBe("set_zoom");
    expect(cmd.params).toEqual({ level: 2 });

    s.handlers.onMessage(JSON.stringify({ type: "command_result", request_id: cmd.request_id, ok: true, result: { accepted: true } }));
    await flush();

    const result = await cp;
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ accepted: true });
  });

  it("releaseControl sends lease_release and drops to none", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const ap = h.manager.acquireControl("A");
    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", request_id: acquire.request_id }));
    await flush();
    await ap;

    await h.manager.releaseControl("A");
    expect(h.sentFrames(s).some((f) => f.type === "lease_release" && f.lease_id === "L1")).toBe(true);
    expect(h.manager.controlStatus("A").state).toBe("none");
  });

  it("lease_revoked drops control and notifies browsers", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const ap = h.manager.acquireControl("A");
    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", request_id: acquire.request_id }));
    await flush();
    await ap;

    h.controlEvents.length = 0;
    s.handlers.onMessage(JSON.stringify({ type: "lease_revoked", reason: "expired" }));
    await flush();
    expect(h.manager.controlStatus("A").state).toBe("none");
    expect(h.controlEvents.some((e) => e.state === "none")).toBe(true);
  });

  it("losing the connection resets control and rejects pending commands", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const ap = h.manager.acquireControl("A");
    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", request_id: acquire.request_id }));
    await flush();
    await ap;

    const cp = h.manager.sendCommand("A", "do_thing"); // in-flight, no result yet
    s.handlers.onClose(1006, "drop");
    const result = await cp;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("disconnected");
    expect(h.manager.controlStatus("A").state).toBe("none");
  });

  it("acquireControl on an unmanaged/non-pull drone reports not_connected", async () => {
    const h = makeHarness();
    h.setDrones([]);
    await h.manager.start();
    const r = await h.manager.acquireControl("ghost");
    expect(r).toEqual({ granted: false, heldBy: null, reason: "not_connected" });
    expect(h.manager.controlStatus("ghost").connected).toBe(false);
  });
});

// ── Capability manifest (B-next) ─────────────────────────────────────────────

describe("DroneSubscriberManager capabilities", () => {
  beforeEach(() => vi.clearAllMocks());

  async function openHarness() {
    const h = makeHarness();
    h.setDrones([droneA]);
    await h.manager.start();
    h.sockets[0].handlers.onOpen();
    return h;
  }

  const manifestFrame = {
    type: "manifest",
    payloads: [
      { id: "camera", name: "Cam", commands: [{ action: "set_zoom", params: [{ name: "level", type: "number" }] }] },
    ],
  };

  it("requests the manifest on open", async () => {
    const h = await openHarness();
    expect(h.sentFrames(h.sockets[0]).some((f) => f.type === "get_manifest")).toBe(true);
  });

  it("stores the manifest and notifies browsers on a manifest frame", async () => {
    const h = await openHarness();
    h.sockets[0].handlers.onMessage(JSON.stringify(manifestFrame));
    await flush();

    const caps = h.manager.capabilities("A");
    expect(caps?.payloads[0].id).toBe("camera");
    expect(caps?.payloads[0].commands[0].action).toBe("set_zoom");
    expect(h.capabilityEvents.some((e) => e.droneId === "A" && e.manifest.payloads.length === 1)).toBe(true);
  });

  it("capabilities() is null for an unknown drone", async () => {
    const h = await openHarness();
    expect(h.manager.capabilities("nope")).toBeNull();
  });

  it("rejects unknown actions once a manifest is loaded, but allows known ones", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    h.sockets[0].handlers.onMessage(JSON.stringify(manifestFrame));
    await flush();

    // Acquire control first.
    const ap = h.manager.acquireControl("A");
    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", request_id: acquire.request_id }));
    await flush();
    await ap;

    // Unknown action is rejected locally (no command frame sent).
    const before = h.sentFrames(s).filter((f) => f.type === "command").length;
    const bad = await h.manager.sendCommand("A", "nonexistent");
    expect(bad).toEqual({ ok: false, result: null, error: "unknown_action" });
    expect(h.sentFrames(s).filter((f) => f.type === "command").length).toBe(before);

    // Known action is sent.
    const cp = h.manager.sendCommand("A", "set_zoom", { level: 2 });
    const cmd = h.sentFrames(s).find((f) => f.type === "command" && f.action === "set_zoom");
    expect(cmd).toBeTruthy();
    s.handlers.onMessage(JSON.stringify({ type: "command_result", request_id: cmd.request_id, ok: true }));
    await flush();
    expect((await cp).ok).toBe(true);
  });

  it("allows any action when no manifest has been advertised", async () => {
    const h = await openHarness();
    const s = h.sockets[0];
    const ap = h.manager.acquireControl("A");
    const acquire = h.sentFrames(s).find((f) => f.type === "lease_acquire");
    s.handlers.onMessage(JSON.stringify({ type: "lease_granted", lease_id: "L1", request_id: acquire.request_id }));
    await flush();
    await ap;

    h.manager.sendCommand("A", "anything_goes");
    expect(h.sentFrames(s).some((f) => f.type === "command" && f.action === "anything_goes")).toBe(true);
  });
});
