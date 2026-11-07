/**
 * Drone subscriber manager — the Hub's outbound "pull" data plane (Tailscale
 * Phase B). For every drone whose `ingestMode = "pull"`, the Hub opens an
 * outbound WebSocket to that drone's tailnet stream service, receives telemetry/
 * camera/pointcloud frames, and feeds them into the SAME broadcast + persistence
 * path the REST "push" ingest uses. Browser-facing Socket.IO is unchanged.
 *
 * This inverts today's flow (companion POSTs to the Hub). Push and pull coexist:
 * a drone left in "push" mode is never touched here, so existing deployments are
 * unaffected until explicitly switched.
 *
 * Design notes:
 *  - Transport is native `WebSocket` (Node 22 global; zero new deps). Auth is
 *    carried in the WebSocket subprotocol as `bearer.<apiKey>` so the per-drone
 *    API key never appears in the URL/path (and never in logs).
 *  - Everything external (socket factory, drone loader, broadcast/persist sink,
 *    clock, scheduler) is injectable, so the manager is unit-testable with a fake
 *    transport and no sockets, DB, or Socket.IO.
 *
 * Spec: docs/architecture/Quiver_Drone_Stream_Protocol.md
 */

import os from "node:os";
import {
  interpretDroneFrame,
  DRONE_STREAM_PROTOCOL_VERSION,
  type DroneDispatch,
  type CapabilityManifest,
} from "./droneStreamProtocol";
import type {
  TelemetryMessage,
  CameraStatusMessage,
  PointCloudMessage,
} from "./websocket";
import {
  broadcastTelemetry,
  broadcastCameraStatus,
  broadcastPointCloud,
  broadcastControlStatus,
  broadcastCapabilities,
} from "./websocket";
import { getPullDrones, getActiveApiKeyForDrone, insertTelemetry, upsertDrone } from "./db";

/** Stable identity for this Hub instance, used as the control-lease holder id. */
export const HUB_ID = process.env.HUB_ID?.trim() || `hub-${os.hostname()}`;

export const STREAM_SUBPROTOCOL = `quiver.stream.v${DRONE_STREAM_PROTOCOL_VERSION}`;

/** How the Hub reaches one drone's stream service. */
export interface DroneConnConfig {
  droneId: string;
  host: string;
  port: number;
  /** Bearer credential presented to the drone (its per-drone API key). */
  token: string;
}

/** A minimal socket handle the manager drives. */
export interface StreamSocketHandle {
  send(data: string): void;
  close(): void;
}

/** Callbacks the manager wires to a live socket. */
export interface StreamSocketHandlers {
  onOpen(): void;
  onMessage(data: string | Buffer | ArrayBuffer): void;
  onClose(code: number, reason: string): void;
  onError(err: unknown): void;
}

export type StreamSocketFactory = (
  url: string,
  protocols: string[],
  handlers: StreamSocketHandlers
) => StreamSocketHandle;

/** Where interpreted frames go. Defaults wire to the real broadcast/persist. */
export interface DispatchSink {
  telemetry(message: TelemetryMessage): void | Promise<void>;
  cameraStatus(message: CameraStatusMessage): void;
  pointcloud(message: PointCloudMessage): void;
  /** Mark a drone seen (mirrors REST ingest's upsertDrone lastSeen). */
  markSeen(droneId: string, when: Date): void | Promise<void>;
}

/** Single-writer control lease state (Phase B2), per drone, from this Hub's view. */
export type ControlState = "none" | "requesting" | "held" | "denied";

export interface ControlStatus {
  droneId: string;
  /** This Hub's relationship to the drone's lease. */
  state: ControlState;
  /** Whether *this* Hub currently holds control. */
  haveControl: boolean;
  /** Who holds it (a hub id), when known and not us. */
  heldBy: string | null;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  /** Whether the underlying pull stream is connected. */
  connected: boolean;
}

export interface AcquireResult {
  granted: boolean;
  heldBy: string | null;
  reason: string | null;
}

export interface CommandResult {
  ok: boolean;
  result: unknown;
  error: string | null;
}

export interface SubscriberManagerOptions {
  socketFactory?: StreamSocketFactory;
  /** Resolve the current set of drones to pull from (host+port+token). */
  loadPullDrones?: () => Promise<DroneConnConfig[]>;
  sink?: DispatchSink;
  clock?: { nowIso?: () => string; nowMs?: () => number };
  /** Injectable scheduler for deterministic backoff tests. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  /** Heartbeat ping interval in ms. 0 disables (used in tests). */
  heartbeatMs?: number;
  /** Reconnect backoff bounds in ms. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Logger (defaults to console). */
  log?: (msg: string) => void;
  /** This Hub's lease-holder identity (default HUB_ID). */
  hubId?: string;
  /** Called whenever a drone's control status changes (→ broadcast to browsers). */
  onControlChange?: (status: ControlStatus) => void;
  /** Called whenever a drone's capability manifest changes (→ broadcast to browsers). */
  onCapabilitiesChange?: (droneId: string, manifest: CapabilityManifest) => void;
  /** Timeout for a lease_acquire / command round-trip (ms). */
  acquireTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Fallback lease TTL if the drone's grant omits one (ms). */
  leaseTtlDefaultMs?: number;
}

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

export interface ConnectionStatus {
  droneId: string;
  host: string;
  port: number;
  state: ConnectionState;
  reconnectAttempts: number;
  lastFrameAt: number | null;
  lastError: string | null;
}

// ── Default wiring (real runtime) ────────────────────────────────────────────

const defaultSocketFactory: StreamSocketFactory = (url, protocols, handlers) => {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (ev: MessageEvent) => handlers.onMessage(ev.data as string | ArrayBuffer);
  ws.onclose = (ev: CloseEvent) => handlers.onClose(ev.code, ev.reason);
  ws.onerror = (ev: Event) => handlers.onError(ev);
  return {
    send: (data: string) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closing/closed */
      }
    },
  };
};

const defaultSink: DispatchSink = {
  async telemetry(message) {
    // Parity with REST ingest: persist + broadcast.
    await insertTelemetry({
      droneId: message.drone_id,
      timestamp: new Date(message.timestamp),
      telemetryData: message.telemetry,
    });
    broadcastTelemetry(message);
  },
  cameraStatus(message) {
    broadcastCameraStatus(message);
  },
  pointcloud(message) {
    broadcastPointCloud(message);
  },
  async markSeen(droneId, when) {
    await upsertDrone({ droneId, lastSeen: when, isActive: true });
  },
};

const defaultLoadPullDrones = async (): Promise<DroneConnConfig[]> => {
  const drones = await getPullDrones();
  const configs: DroneConnConfig[] = [];
  for (const d of drones) {
    if (!d.tailnetHost) {
      console.warn(`[DroneSubscriber] Drone ${d.droneId} is pull-mode but has no tailnetHost; skipping`);
      continue;
    }
    const token = await getActiveApiKeyForDrone(d.droneId);
    if (!token) {
      console.warn(`[DroneSubscriber] Drone ${d.droneId} is pull-mode but has no active API key; skipping`);
      continue;
    }
    configs.push({ droneId: d.droneId, host: d.tailnetHost, port: d.streamPort, token });
  }
  return configs;
};

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  if (typeof t === "object" && typeof (t as NodeJS.Timeout).unref === "function") {
    (t as NodeJS.Timeout).unref();
  }
  return { cancel: () => clearTimeout(t) };
};

// ── One drone's connection ───────────────────────────────────────────────────

class DroneStreamConnection {
  state: ConnectionState = "idle";
  reconnectAttempts = 0;
  lastFrameAt: number | null = null;
  lastError: string | null = null;

  private socket: StreamSocketHandle | null = null;
  private reconnectTimer: { cancel: () => void } | null = null;
  private heartbeatTimer: { cancel: () => void } | null = null;
  private stopped = false;
  // True once the current socket attempt's failure has been handled, so a
  // coincident error+close pair only schedules one reconnect. Reset per attempt.
  private attemptSettled = false;
  private attemptSeq = 0;

  // ── Control lease (Phase B2) ──
  private controlState: ControlState = "none";
  private leaseId: string | null = null;
  private leaseExpiresAt: number | null = null;
  private heldBy: string | null = null;
  private leaseHeartbeatTimer: { cancel: () => void } | null = null;
  private reqCounter = 0;
  private pendingAcquire: { requestId: string; resolve: (r: AcquireResult) => void; timer: { cancel: () => void } } | null = null;
  private pendingCommands = new Map<string, { resolve: (r: CommandResult) => void; timer: { cancel: () => void } }>();

  // ── Capability manifest (B-next) ──
  private manifest: CapabilityManifest | null = null;

  constructor(
    public config: DroneConnConfig,
    private deps: Required<
      Pick<
        SubscriberManagerOptions,
        | "socketFactory" | "sink" | "schedule" | "heartbeatMs" | "backoffMinMs" | "backoffMaxMs" | "log"
        | "hubId" | "onControlChange" | "onCapabilitiesChange" | "acquireTimeoutMs" | "commandTimeoutMs" | "leaseTtlDefaultMs"
      >
    > & { clock: { nowIso?: () => string; nowMs?: () => number } }
  ) {}

  getCapabilities(): CapabilityManifest | null {
    return this.manifest;
  }

  /** Set of every action the drone advertises (across payloads), or null if no manifest. */
  private knownActions(): Set<string> | null {
    if (!this.manifest) return null;
    const actions = new Set<string>();
    for (const payload of this.manifest.payloads) {
      for (const cmd of payload.commands) actions.add(cmd.action);
    }
    return actions;
  }

  private now(): number {
    return this.deps.clock.nowMs ? this.deps.clock.nowMs() : Date.now();
  }

  private nextReqId(prefix: string): string {
    return `${prefix}-${++this.reqCounter}`;
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.state !== "open" || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.handleError(err);
      return false;
    }
  }

  controlStatus(): ControlStatus {
    return {
      droneId: this.config.droneId,
      state: this.controlState,
      haveControl: this.controlState === "held",
      heldBy: this.heldBy,
      leaseId: this.leaseId,
      leaseExpiresAt: this.leaseExpiresAt,
      connected: this.state === "open",
    };
  }

  private emitControlChange() {
    this.deps.onControlChange(this.controlStatus());
  }

  get url(): string {
    return `ws://${this.config.host}:${this.config.port}/stream?drone_id=${encodeURIComponent(this.config.droneId)}`;
  }

  start() {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    this.attemptSettled = false;
    // Events are bound to this attempt: a late `close`/`error` from a previous
    // socket (undici can deliver them after we have already moved on) must not
    // settle, or re-fail, the attempt that replaced it.
    const attempt = ++this.attemptSeq;
    const current = () => attempt === this.attemptSeq;
    this.state = this.reconnectAttempts === 0 ? "connecting" : "reconnecting";
    const protocols = [STREAM_SUBPROTOCOL, `bearer.${this.config.token}`];
    try {
      this.socket = this.deps.socketFactory(this.url, protocols, {
        onOpen: () => { if (current()) this.handleOpen(); },
        onMessage: (data) => { if (current()) this.handleMessage(data); },
        onClose: (code, reason) => { if (current()) this.handleClose(code, reason); },
        onError: (err) => { if (current()) this.handleError(err); },
      });
    } catch (err) {
      // Synchronous factory failure — handleError drives the reconnect.
      this.handleError(err);
    }
  }

  private handleOpen() {
    this.state = "open";
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.deps.log(`[DroneSubscriber] Connected to ${this.config.droneId} (${this.config.host}:${this.config.port})`);
    this.startHeartbeat();
    // Request the capability manifest (the drone may also push it unsolicited).
    this.send({ type: "get_manifest" });
    // A reconnect means any prior lease was lost (the drone expires it while we
    // were gone) — reset control state and let browsers know we're live again.
    this.controlState = "none";
    this.leaseId = null;
    this.leaseExpiresAt = null;
    this.heldBy = null;
    this.emitControlChange();
  }

  private async handleMessage(data: string | Buffer | ArrayBuffer) {
    const now = this.deps.clock.nowMs ? this.deps.clock.nowMs() : Date.now();
    this.lastFrameAt = now;
    const dispatch = interpretDroneFrame(this.config.droneId, data, this.deps.clock);
    await this.apply(dispatch);
  }

  private async apply(dispatch: DroneDispatch) {
    switch (dispatch.kind) {
      case "telemetry":
        await this.deps.sink.markSeen(this.config.droneId, new Date(dispatch.message.timestamp));
        await this.deps.sink.telemetry(dispatch.message);
        break;
      case "camera_status":
        this.deps.sink.cameraStatus(dispatch.message);
        break;
      case "pointcloud":
        this.deps.sink.pointcloud(dispatch.message);
        break;
      case "hello":
        this.deps.log(
          `[DroneSubscriber] ${this.config.droneId} hello: protocol v${dispatch.protocol}, services=[${dispatch.services.join(", ")}]`
        );
        break;
      case "manifest":
        this.manifest = dispatch.manifest;
        this.deps.log(
          `[DroneSubscriber] ${this.config.droneId} manifest: ${dispatch.manifest.payloads.length} payload(s)`
        );
        this.deps.onCapabilitiesChange(this.config.droneId, dispatch.manifest);
        break;
      case "pong":
        break;
      case "lease_granted":
        this.onLeaseGranted(dispatch.leaseId, dispatch.ttlMs, dispatch.requestId);
        break;
      case "lease_denied":
        this.onLeaseDenied(dispatch.heldBy, dispatch.reason, dispatch.requestId);
        break;
      case "lease_revoked":
        this.onLeaseRevoked(dispatch.reason);
        break;
      case "lease_released":
        this.onLeaseReleased();
        break;
      case "command_result":
        this.onCommandResult(dispatch.requestId, dispatch.ok, dispatch.result, dispatch.error);
        break;
      case "ignored":
        this.deps.log(`[DroneSubscriber] ${this.config.droneId} ignored frame: ${dispatch.reason}`);
        break;
      case "error":
        this.lastError = dispatch.error;
        this.deps.log(`[DroneSubscriber] ${this.config.droneId} bad frame: ${dispatch.error}`);
        break;
    }
  }

  // ── Control lease: public API ──

  /**
   * Acquire (or renew) the single-writer control lease on this drone. Resolves
   * with whether control was granted; if denied, `heldBy` names the holder.
   */
  acquireControl(): Promise<AcquireResult> {
    if (this.state !== "open") {
      return Promise.resolve({ granted: false, heldBy: this.heldBy, reason: "not_connected" });
    }
    if (this.controlState === "held") {
      return Promise.resolve({ granted: true, heldBy: this.deps.hubId, reason: null });
    }
    // Coalesce concurrent acquires onto the in-flight request.
    if (this.pendingAcquire) {
      const existing = this.pendingAcquire;
      return new Promise((resolve) => {
        const prev = existing.resolve;
        existing.resolve = (r) => {
          prev(r);
          resolve(r);
        };
      });
    }
    const requestId = this.nextReqId("acq");
    this.controlState = "requesting";
    this.emitControlChange();
    return new Promise<AcquireResult>((resolve) => {
      const timer = this.deps.schedule(() => {
        if (this.pendingAcquire?.requestId === requestId) {
          this.pendingAcquire = null;
          if (this.controlState === "requesting") {
            this.controlState = "none";
            this.emitControlChange();
          }
          resolve({ granted: false, heldBy: this.heldBy, reason: "timeout" });
        }
      }, this.deps.acquireTimeoutMs);
      this.pendingAcquire = { requestId, resolve, timer };
      this.send({ type: "lease_acquire", hub_id: this.deps.hubId, request_id: requestId });
    });
  }

  /** Release control if held. Best-effort: clears local state immediately. */
  releaseControl(): Promise<void> {
    if (this.controlState === "held" && this.leaseId) {
      this.send({ type: "lease_release", lease_id: this.leaseId, request_id: this.nextReqId("rel") });
    }
    this.clearLease("none");
    return Promise.resolve();
  }

  /** Send a lease-gated command. Rejects if this Hub does not hold control. */
  sendCommand(action: string, params?: Record<string, unknown>): Promise<CommandResult> {
    if (this.controlState !== "held" || !this.leaseId) {
      return Promise.resolve({ ok: false, result: null, error: "no_control" });
    }
    if (this.state !== "open") {
      return Promise.resolve({ ok: false, result: null, error: "not_connected" });
    }
    // If the drone advertised a manifest, reject unknown actions early (the drone
    // remains the final authority; this is fast UX feedback). No manifest → allow.
    const actions = this.knownActions();
    if (actions && !actions.has(action)) {
      return Promise.resolve({ ok: false, result: null, error: "unknown_action" });
    }
    const requestId = this.nextReqId("cmd");
    return new Promise<CommandResult>((resolve) => {
      const timer = this.deps.schedule(() => {
        if (this.pendingCommands.has(requestId)) {
          this.pendingCommands.delete(requestId);
          resolve({ ok: false, result: null, error: "timeout" });
        }
      }, this.deps.commandTimeoutMs);
      this.pendingCommands.set(requestId, { resolve, timer });
      this.send({ type: "command", request_id: requestId, lease_id: this.leaseId, action, params });
    });
  }

  // ── Control lease: inbound handling ──

  private onLeaseGranted(leaseId: string, ttlMs: number, requestId: string | null) {
    this.leaseId = leaseId;
    this.heldBy = this.deps.hubId;
    const ttl = ttlMs > 0 ? ttlMs : this.deps.leaseTtlDefaultMs;
    this.leaseExpiresAt = this.now() + ttl;
    this.controlState = "held";
    this.startLeaseHeartbeat(ttl);
    const p = this.pendingAcquire;
    if (p && (!requestId || p.requestId === requestId)) {
      p.timer.cancel();
      this.pendingAcquire = null;
      p.resolve({ granted: true, heldBy: this.deps.hubId, reason: null });
    }
    this.deps.log(`[DroneSubscriber] ${this.config.droneId} control GRANTED (lease ${leaseId}, ttl ${ttl}ms)`);
    this.emitControlChange();
  }

  private onLeaseDenied(heldBy: string | null, reason: string | null, requestId: string | null) {
    this.heldBy = heldBy;
    this.controlState = "denied";
    this.leaseId = null;
    this.leaseExpiresAt = null;
    this.stopLeaseHeartbeat();
    const p = this.pendingAcquire;
    if (p && (!requestId || p.requestId === requestId)) {
      p.timer.cancel();
      this.pendingAcquire = null;
      p.resolve({ granted: false, heldBy, reason: reason ?? "denied" });
    }
    this.deps.log(`[DroneSubscriber] ${this.config.droneId} control DENIED (held by ${heldBy ?? "unknown"})`);
    this.emitControlChange();
  }

  private onLeaseRevoked(reason: string | null) {
    this.deps.log(`[DroneSubscriber] ${this.config.droneId} control REVOKED (${reason ?? "unspecified"})`);
    this.clearLease("none");
  }

  private onLeaseReleased() {
    this.clearLease("none");
  }

  private onCommandResult(requestId: string, ok: boolean, result: unknown, error: string | null) {
    const pending = this.pendingCommands.get(requestId);
    if (!pending) return;
    pending.timer.cancel();
    this.pendingCommands.delete(requestId);
    pending.resolve({ ok, result, error });
  }

  private startLeaseHeartbeat(ttlMs: number) {
    this.stopLeaseHeartbeat();
    const interval = Math.max(1000, Math.floor(ttlMs / 2));
    const tick = () => {
      if (this.controlState !== "held" || !this.leaseId) return;
      this.send({ type: "lease_heartbeat", lease_id: this.leaseId });
      this.leaseExpiresAt = this.now() + ttlMs;
      this.leaseHeartbeatTimer = this.deps.schedule(tick, interval);
    };
    this.leaseHeartbeatTimer = this.deps.schedule(tick, interval);
  }

  private stopLeaseHeartbeat() {
    this.leaseHeartbeatTimer?.cancel();
    this.leaseHeartbeatTimer = null;
  }

  /** Reset lease state to `next` and notify. Rejects nothing (commands keep their own timeouts). */
  private clearLease(next: ControlState) {
    const changed = this.controlState !== next || this.leaseId !== null;
    this.stopLeaseHeartbeat();
    this.leaseId = null;
    this.leaseExpiresAt = null;
    if (next === "none") this.heldBy = null;
    this.controlState = next;
    if (changed) this.emitControlChange();
  }

  private handleClose(code: number, reason: string) {
    this.failAttempt(code, reason);
  }

  /**
   * Settle a failed/closed socket and schedule a reconnect. Idempotent within one
   * socket attempt: a WS failure can surface as `error` then `close` (or, during
   * the opening handshake on undici, as `error` with no `close` at all), and both
   * paths funnel here — the `attemptSettled` guard ensures exactly one reconnect.
   */
  private failAttempt(code: number, reason: string) {
    if (this.attemptSettled) return;
    this.attemptSettled = true;
    this.stopHeartbeat();
    this.failPendingControl("disconnected");
    this.socket = null;
    if (this.stopped) {
      this.state = "stopped";
      this.clearLease("none");
      return;
    }
    this.state = "reconnecting";
    this.clearLease("none"); // lost any lease; will re-acquire after reconnect
    this.deps.log(`[DroneSubscriber] ${this.config.droneId} disconnected (code=${code}${reason ? `, ${reason}` : ""}); reconnecting`);
    this.scheduleReconnect();
  }

  /** Resolve any in-flight acquire/command promises as failed (connection lost). */
  private failPendingControl(reason: string) {
    if (this.pendingAcquire) {
      this.pendingAcquire.timer.cancel();
      this.pendingAcquire.resolve({ granted: false, heldBy: this.heldBy, reason });
      this.pendingAcquire = null;
    }
    for (const [, pending] of Array.from(this.pendingCommands.entries())) {
      pending.timer.cancel();
      pending.resolve({ ok: false, result: null, error: reason });
    }
    this.pendingCommands.clear();
  }

  private handleError(err: unknown) {
    this.lastError = err instanceof Error ? err.message : String((err as any)?.message ?? err);
    if (this.stopped || this.attemptSettled) return;
    // A WebSocket "error" event always signals connection failure. The browser/
    // undici spec is meant to follow it with a "close", but undici does NOT
    // reliably emit `close` for failures during the opening handshake — which
    // would otherwise leave this connection parked in "connecting" forever with
    // no backoff retry. Drive the failure path directly; failAttempt() dedupes
    // if a real "close" does follow.
    //
    // Order matters: settle (and arm the reconnect timer) BEFORE closing the
    // socket. On Node 22 undici, close() while still CONNECTING synchronously
    // re-fires `error`; without the settled guard above that recursed until the
    // stack overflowed and the reconnect was never scheduled.
    const socket = this.socket;
    this.failAttempt(1006, "error");
    try {
      socket?.close();
    } catch {
      /* already closing/closed */
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.state = "reconnecting";
    const attempt = this.reconnectAttempts++;
    const base = Math.min(this.deps.backoffMaxMs, this.deps.backoffMinMs * 2 ** attempt);
    const jitter = Math.floor(Math.random() * (base / 2));
    const delay = Math.min(this.deps.backoffMaxMs, base + jitter);
    this.reconnectTimer?.cancel();
    this.reconnectTimer = this.deps.schedule(() => this.open(), delay);
  }

  private startHeartbeat() {
    if (!this.deps.heartbeatMs) return;
    this.stopHeartbeat();
    const tick = () => {
      if (this.state !== "open" || !this.socket) return;
      const ts = this.deps.clock.nowMs ? this.deps.clock.nowMs() : Date.now();
      try {
        this.socket.send(JSON.stringify({ type: "ping", ts }));
      } catch (err) {
        this.handleError(err);
      }
      this.heartbeatTimer = this.deps.schedule(tick, this.deps.heartbeatMs);
    };
    this.heartbeatTimer = this.deps.schedule(tick, this.deps.heartbeatMs);
  }

  private stopHeartbeat() {
    this.heartbeatTimer?.cancel();
    this.heartbeatTimer = null;
  }

  stop() {
    this.stopped = true;
    this.state = "stopped";
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.failPendingControl("stopped");
    this.clearLease("none");
    this.socket?.close();
    this.socket = null;
  }

  status(): ConnectionStatus {
    return {
      droneId: this.config.droneId,
      host: this.config.host,
      port: this.config.port,
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      lastFrameAt: this.lastFrameAt,
      lastError: this.lastError,
    };
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class DroneSubscriberManager {
  private connections = new Map<string, DroneStreamConnection>();
  private started = false;

  private socketFactory: StreamSocketFactory;
  private loadPullDrones: () => Promise<DroneConnConfig[]>;
  private sink: DispatchSink;
  private clock: { nowIso?: () => string; nowMs?: () => number };
  private schedule: (fn: () => void, ms: number) => { cancel: () => void };
  private heartbeatMs: number;
  private backoffMinMs: number;
  private backoffMaxMs: number;
  private log: (msg: string) => void;
  private hubId: string;
  private onControlChange: (status: ControlStatus) => void;
  private onCapabilitiesChange: (droneId: string, manifest: CapabilityManifest) => void;
  private acquireTimeoutMs: number;
  private commandTimeoutMs: number;
  private leaseTtlDefaultMs: number;

  constructor(options: SubscriberManagerOptions = {}) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.loadPullDrones = options.loadPullDrones ?? defaultLoadPullDrones;
    this.sink = options.sink ?? defaultSink;
    this.clock = options.clock ?? {};
    this.schedule = options.schedule ?? defaultSchedule;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.backoffMinMs = options.backoffMinMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.log = options.log ?? ((m) => console.log(m));
    this.hubId = options.hubId ?? HUB_ID;
    this.onControlChange = options.onControlChange ?? ((status) => broadcastControlStatus(status));
    this.onCapabilitiesChange =
      options.onCapabilitiesChange ?? ((droneId, manifest) => broadcastCapabilities(droneId, manifest));
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 8_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.leaseTtlDefaultMs = options.leaseTtlDefaultMs ?? 30_000;
  }

  private connDeps() {
    return {
      socketFactory: this.socketFactory,
      sink: this.sink,
      schedule: this.schedule,
      heartbeatMs: this.heartbeatMs,
      backoffMinMs: this.backoffMinMs,
      backoffMaxMs: this.backoffMaxMs,
      log: this.log,
      clock: this.clock,
      hubId: this.hubId,
      onControlChange: this.onControlChange,
      onCapabilitiesChange: this.onCapabilitiesChange,
      acquireTimeoutMs: this.acquireTimeoutMs,
      commandTimeoutMs: this.commandTimeoutMs,
      leaseTtlDefaultMs: this.leaseTtlDefaultMs,
    };
  }

  /** Start pulling from all currently-configured pull-mode drones. */
  async start() {
    this.started = true;
    await this.reconcile();
  }

  /**
   * Bring live connections in line with the current pull-drone set: open new
   * ones, drop removed ones, and reconnect those whose host/port/token changed.
   * Safe to call any time a drone's config changes (mode toggle, host edit).
   */
  async reconcile() {
    if (!this.started) return;
    const desired = await this.loadPullDrones();
    const desiredById = new Map(desired.map((c) => [c.droneId, c]));

    // Remove connections no longer wanted.
    for (const [droneId, conn] of Array.from(this.connections.entries())) {
      const want = desiredById.get(droneId);
      if (!want) {
        conn.stop();
        this.connections.delete(droneId);
        this.log(`[DroneSubscriber] Stopped pulling ${droneId} (no longer pull-mode)`);
      } else if (want.host !== conn.config.host || want.port !== conn.config.port || want.token !== conn.config.token) {
        // Endpoint/credential changed — recreate.
        conn.stop();
        this.connections.delete(droneId);
      }
    }

    // Add connections for newly-wanted drones.
    for (const cfg of desired) {
      if (this.connections.has(cfg.droneId)) continue;
      const conn = new DroneStreamConnection(cfg, this.connDeps());
      this.connections.set(cfg.droneId, conn);
      conn.start();
      this.log(`[DroneSubscriber] Started pulling ${cfg.droneId} from ${cfg.host}:${cfg.port}`);
    }
  }

  /** Stop all connections (server shutdown). */
  stop() {
    for (const conn of Array.from(this.connections.values())) conn.stop();
    this.connections.clear();
    this.started = false;
  }

  /** Snapshot of every active connection (for diagnostics / a future UI). */
  status(): ConnectionStatus[] {
    return Array.from(this.connections.values()).map((c) => c.status());
  }

  // ── Control lease (Phase B2) ──

  /** This Hub's id (lease holder identity). */
  get hubIdentity() {
    return this.hubId;
  }

  /** Acquire the single-writer control lease on a drone (must be pull-mode). */
  async acquireControl(droneId: string): Promise<AcquireResult> {
    const conn = this.connections.get(droneId);
    if (!conn) return { granted: false, heldBy: null, reason: "not_connected" };
    return conn.acquireControl();
  }

  /** Release this Hub's control lease on a drone. */
  async releaseControl(droneId: string): Promise<void> {
    await this.connections.get(droneId)?.releaseControl();
  }

  /** Send a lease-gated command to a drone (requires holding control). */
  async sendCommand(droneId: string, action: string, params?: Record<string, unknown>): Promise<CommandResult> {
    const conn = this.connections.get(droneId);
    if (!conn) return { ok: false, result: null, error: "not_connected" };
    return conn.sendCommand(action, params);
  }

  /** This Hub's control status for a drone (default "none"/disconnected). */
  controlStatus(droneId: string): ControlStatus {
    const conn = this.connections.get(droneId);
    if (conn) return conn.controlStatus();
    return {
      droneId,
      state: "none",
      haveControl: false,
      heldBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      connected: false,
    };
  }

  /** A drone's advertised capability manifest, or null if unknown/not connected. */
  capabilities(droneId: string): CapabilityManifest | null {
    return this.connections.get(droneId)?.getCapabilities() ?? null;
  }

  /** Number of live connections (test/diagnostic helper). */
  get size() {
    return this.connections.size;
  }
}

// ── Module-level singleton used by the running server ────────────────────────

let _manager: DroneSubscriberManager | null = null;

export function getDroneSubscriberManager(): DroneSubscriberManager {
  if (!_manager) _manager = new DroneSubscriberManager();
  return _manager;
}

/** Start the singleton subscriber. No-op under Vitest (never opens sockets). */
export async function startDroneSubscribers() {
  if (process.env.VITEST) return;
  await getDroneSubscriberManager().start();
}

/** Re-sync the singleton after a drone's connection settings change. */
export async function reconcileDroneSubscribers() {
  if (process.env.VITEST) return;
  await getDroneSubscriberManager().reconcile();
}

// ── Control-lease helpers used by tRPC (operate on the singleton) ────────────

export async function acquireDroneControl(droneId: string): Promise<AcquireResult> {
  return getDroneSubscriberManager().acquireControl(droneId);
}

export async function releaseDroneControl(droneId: string): Promise<void> {
  return getDroneSubscriberManager().releaseControl(droneId);
}

export async function sendDroneCommand(
  droneId: string,
  action: string,
  params?: Record<string, unknown>
): Promise<CommandResult> {
  return getDroneSubscriberManager().sendCommand(droneId, action, params);
}

export function droneControlStatus(droneId: string): ControlStatus {
  return getDroneSubscriberManager().controlStatus(droneId);
}

export function droneCapabilities(droneId: string): CapabilityManifest | null {
  return getDroneSubscriberManager().capabilities(droneId);
}
