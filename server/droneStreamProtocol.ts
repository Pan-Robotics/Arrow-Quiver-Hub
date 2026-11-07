/**
 * Quiver drone stream protocol — wire format + IO-free interpreter.
 *
 * This module defines the JSON frames exchanged on the WebSocket the Hub opens
 * *to* a drone's tailnet stream service (Tailscale Phase B, "pull" mode), and a
 * pure function that turns an inbound frame into a normalized dispatch result.
 *
 * It performs NO IO (no sockets, no DB, no Socket.IO). The subscriber
 * (server/droneSubscriber.ts) calls `interpretDroneFrame` and then applies the
 * result via the existing broadcast + persistence functions. Keeping the
 * interpreter pure makes the wire contract exhaustively unit-testable.
 *
 * Spec: docs/architecture/Quiver_Drone_Stream_Protocol.md
 */

import type {
  TelemetryMessage,
  CameraStatusMessage,
  PointCloudMessage,
} from "./websocket";

/** Protocol version the Hub speaks. Bumped on a breaking frame change. */
export const DRONE_STREAM_PROTOCOL_VERSION = 1;

// ── Capability manifest (per-payload typed commands) ──────────────────────────

/** A single command parameter, used to render a typed input in the UI. */
export interface CapabilityParam {
  name: string;
  type: "number" | "string" | "boolean" | "enum";
  label?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values when type === "enum". */
  options?: string[];
  default?: unknown;
}

/** One command a payload supports. */
export interface CapabilityCommand {
  action: string;
  label?: string;
  description?: string;
  params: CapabilityParam[];
}

/** A payload (camera, winch, sensor, …) and the commands it exposes. */
export interface CapabilityPayload {
  id: string;
  name?: string;
  commands: CapabilityCommand[];
}

/** What a drone advertises it can do — drives typed command UI + validation. */
export interface CapabilityManifest {
  payloads: CapabilityPayload[];
}

const PARAM_TYPES = new Set(["number", "string", "boolean", "enum"]);

/**
 * Coerce an untrusted manifest payload into a typed `CapabilityManifest`,
 * dropping malformed entries rather than throwing. Lenient so a partially-broken
 * manifest still yields whatever is well-formed.
 */
export function normalizeManifest(raw: unknown): CapabilityManifest {
  const payloadsRaw = isObject(raw) && Array.isArray((raw as any).payloads) ? (raw as any).payloads : [];
  const payloads: CapabilityPayload[] = [];
  for (const p of payloadsRaw) {
    if (!isObject(p) || typeof p.id !== "string") continue;
    const commandsRaw = Array.isArray(p.commands) ? p.commands : [];
    const commands: CapabilityCommand[] = [];
    for (const c of commandsRaw) {
      if (!isObject(c) || typeof c.action !== "string") continue;
      const paramsRaw = Array.isArray(c.params) ? c.params : [];
      const params: CapabilityParam[] = [];
      for (const pr of paramsRaw) {
        if (!isObject(pr) || typeof pr.name !== "string") continue;
        const type = typeof pr.type === "string" && PARAM_TYPES.has(pr.type) ? (pr.type as CapabilityParam["type"]) : "string";
        const param: CapabilityParam = { name: pr.name, type };
        if (typeof pr.label === "string") param.label = pr.label;
        if (typeof pr.required === "boolean") param.required = pr.required;
        if (typeof pr.min === "number") param.min = pr.min;
        if (typeof pr.max === "number") param.max = pr.max;
        if (typeof pr.step === "number") param.step = pr.step;
        if (Array.isArray(pr.options)) param.options = pr.options.filter((o: unknown): o is string => typeof o === "string");
        if (pr.default !== undefined) param.default = pr.default;
        params.push(param);
      }
      const command: CapabilityCommand = { action: c.action, params };
      if (typeof c.label === "string") command.label = c.label;
      if (typeof c.description === "string") command.description = c.description;
      commands.push(command);
    }
    const payload: CapabilityPayload = { id: p.id, commands };
    if (typeof p.name === "string") payload.name = p.name;
    payloads.push(payload);
  }
  return { payloads };
}

/**
 * Frames a drone may send to the Hub. `drone_id` is intentionally NOT carried
 * per-frame — the Hub knows which drone a connection belongs to and injects it,
 * so a compromised/buggy drone cannot spoof telemetry for another drone over its
 * own socket.
 */
export type DroneInboundFrame =
  | { type: "hello"; protocol?: number; services?: string[] }
  | { type: "manifest"; payloads?: unknown }
  | { type: "pong"; ts?: number }
  | { type: "telemetry"; timestamp?: string; telemetry: unknown }
  | ({ type: "camera_status" } & Omit<CameraStatusMessage, "drone_id" | "timestamp"> & { timestamp?: number })
  | { type: "pointcloud"; timestamp?: string; points: unknown; stats: unknown }
  // ── Control / lease (Phase B2, write path) ──
  | { type: "lease_granted"; lease_id: string; ttl_ms?: number; request_id?: string }
  | { type: "lease_denied"; held_by?: string; reason?: string; request_id?: string }
  | { type: "lease_revoked"; lease_id?: string; reason?: string }
  | { type: "lease_released"; lease_id?: string; request_id?: string }
  | { type: "command_result"; request_id: string; ok: boolean; result?: unknown; error?: string };

/** Frames the Hub sends to a drone. */
export type DroneOutboundFrame =
  | { type: "ping"; ts: number }
  | { type: "get_manifest" }
  // ── Control / lease (Phase B2). The drone is the single lease arbiter. ──
  | { type: "lease_acquire"; hub_id: string; request_id: string }
  | { type: "lease_heartbeat"; lease_id: string }
  | { type: "lease_release"; lease_id: string; request_id: string }
  | { type: "command"; request_id: string; lease_id: string; action: string; params?: Record<string, unknown> };

/**
 * Normalized result of interpreting one inbound frame. The subscriber maps each
 * variant to a concrete side effect; everything here is plain data.
 */
export type DroneDispatch =
  | { kind: "hello"; protocol: number; services: string[] }
  | { kind: "manifest"; manifest: CapabilityManifest }
  | { kind: "pong" }
  | { kind: "telemetry"; message: TelemetryMessage }
  | { kind: "camera_status"; message: CameraStatusMessage }
  | { kind: "pointcloud"; message: PointCloudMessage }
  | { kind: "lease_granted"; leaseId: string; ttlMs: number; requestId: string | null }
  | { kind: "lease_denied"; heldBy: string | null; reason: string | null; requestId: string | null }
  | { kind: "lease_revoked"; leaseId: string | null; reason: string | null }
  | { kind: "lease_released"; leaseId: string | null; requestId: string | null }
  | { kind: "command_result"; requestId: string; ok: boolean; result: unknown; error: string | null }
  | { kind: "ignored"; reason: string }
  | { kind: "error"; error: string };

/** Parse a raw WS payload (string or bytes) into a frame object. */
export function parseDroneFrame(raw: string | Buffer | ArrayBuffer): DroneInboundFrame | { type: "__parse_error__"; error: string } {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  } else {
    text = raw.toString("utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { type: "__parse_error__", error: "frame is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as any).type !== "string") {
    return { type: "__parse_error__", error: "frame missing string 'type'" };
  }
  return parsed as DroneInboundFrame;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Interpret a single inbound frame for a known drone. Pure: returns a normalized
 * dispatch describing what the Hub should do. `nowIso`/`nowMs` are injectable for
 * deterministic tests and supply a server-side timestamp when the drone omits one.
 */
export function interpretDroneFrame(
  droneId: string,
  raw: string | Buffer | ArrayBuffer,
  clock: { nowIso?: () => string; nowMs?: () => number } = {}
): DroneDispatch {
  const nowIso = clock.nowIso ?? (() => new Date().toISOString());
  const nowMs = clock.nowMs ?? (() => Date.now());

  const frame = parseDroneFrame(raw);
  if (frame.type === "__parse_error__") {
    return { kind: "error", error: frame.error };
  }

  switch (frame.type) {
    case "hello": {
      const f = frame as Extract<DroneInboundFrame, { type: "hello" }>;
      return {
        kind: "hello",
        protocol: typeof f.protocol === "number" ? f.protocol : DRONE_STREAM_PROTOCOL_VERSION,
        services: Array.isArray(f.services) ? f.services.filter((s): s is string => typeof s === "string") : [],
      };
    }

    case "manifest": {
      const f = frame as Extract<DroneInboundFrame, { type: "manifest" }>;
      return { kind: "manifest", manifest: normalizeManifest(f) };
    }

    case "pong":
      return { kind: "pong" };

    case "telemetry": {
      const f = frame as Extract<DroneInboundFrame, { type: "telemetry" }>;
      if (!isObject(f.telemetry)) {
        return { kind: "error", error: "telemetry frame missing 'telemetry' object" };
      }
      return {
        kind: "telemetry",
        message: {
          drone_id: droneId,
          timestamp: typeof f.timestamp === "string" ? f.timestamp : nowIso(),
          telemetry: f.telemetry as TelemetryMessage["telemetry"],
        },
      };
    }

    case "camera_status": {
      const f = frame as Extract<DroneInboundFrame, { type: "camera_status" }>;
      if (typeof f.connected !== "boolean") {
        return { kind: "error", error: "camera_status frame missing boolean 'connected'" };
      }
      const message: CameraStatusMessage = {
        drone_id: droneId,
        timestamp: typeof f.timestamp === "number" ? f.timestamp : nowMs(),
        connected: f.connected,
      };
      if (f.attitude !== undefined) message.attitude = f.attitude;
      if (f.recording !== undefined) message.recording = f.recording;
      if (f.hdr_enabled !== undefined) message.hdr_enabled = f.hdr_enabled;
      if (f.tf_card_present !== undefined) message.tf_card_present = f.tf_card_present;
      if (f.zoom_level !== undefined) message.zoom_level = f.zoom_level;
      return { kind: "camera_status", message };
    }

    case "pointcloud": {
      const f = frame as Extract<DroneInboundFrame, { type: "pointcloud" }>;
      if (!Array.isArray(f.points) || !isObject(f.stats)) {
        return { kind: "error", error: "pointcloud frame missing 'points' array or 'stats' object" };
      }
      return {
        kind: "pointcloud",
        message: {
          drone_id: droneId,
          timestamp: typeof f.timestamp === "string" ? f.timestamp : nowIso(),
          points: f.points as PointCloudMessage["points"],
          stats: f.stats as PointCloudMessage["stats"],
        },
      };
    }

    case "lease_granted": {
      const f = frame as Extract<DroneInboundFrame, { type: "lease_granted" }>;
      if (typeof f.lease_id !== "string") {
        return { kind: "error", error: "lease_granted missing string 'lease_id'" };
      }
      return {
        kind: "lease_granted",
        leaseId: f.lease_id,
        ttlMs: typeof f.ttl_ms === "number" ? f.ttl_ms : 0,
        requestId: typeof f.request_id === "string" ? f.request_id : null,
      };
    }

    case "lease_denied": {
      const f = frame as Extract<DroneInboundFrame, { type: "lease_denied" }>;
      return {
        kind: "lease_denied",
        heldBy: typeof f.held_by === "string" ? f.held_by : null,
        reason: typeof f.reason === "string" ? f.reason : null,
        requestId: typeof f.request_id === "string" ? f.request_id : null,
      };
    }

    case "lease_revoked": {
      const f = frame as Extract<DroneInboundFrame, { type: "lease_revoked" }>;
      return {
        kind: "lease_revoked",
        leaseId: typeof f.lease_id === "string" ? f.lease_id : null,
        reason: typeof f.reason === "string" ? f.reason : null,
      };
    }

    case "lease_released": {
      const f = frame as Extract<DroneInboundFrame, { type: "lease_released" }>;
      return {
        kind: "lease_released",
        leaseId: typeof f.lease_id === "string" ? f.lease_id : null,
        requestId: typeof f.request_id === "string" ? f.request_id : null,
      };
    }

    case "command_result": {
      const f = frame as Extract<DroneInboundFrame, { type: "command_result" }>;
      if (typeof f.request_id !== "string" || typeof f.ok !== "boolean") {
        return { kind: "error", error: "command_result missing 'request_id' or boolean 'ok'" };
      }
      return {
        kind: "command_result",
        requestId: f.request_id,
        ok: f.ok,
        result: f.result,
        error: typeof f.error === "string" ? f.error : null,
      };
    }

    default:
      return { kind: "ignored", reason: `unknown frame type '${(frame as { type: string }).type}'` };
  }
}
