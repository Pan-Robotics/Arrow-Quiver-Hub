# Quiver Drone Stream Protocol (pull data-plane)

**Status:** Implemented. Phase B1 — read path (telemetry/camera/pointcloud).
Phase B2 — write path (single-writer control lease + commands), §9. Capability
manifest (per-payload typed commands), §10.

This is the wire contract for the **pull** data plane: the Hub opens an outbound
WebSocket *to* a drone's tailnet stream service, receives telemetry, and — when it
holds the control lease — sends commands. It is the inversion of the legacy
**push** flow (companion `POST`s to the Hub's REST ingest). Both coexist; a
drone's `ingestMode` selects which one is active.

See [Tailscale_Network_Architecture.md](Tailscale_Network_Architecture.md) §6 for
where this fits in the network design.

---

## 1. Roles

| Side | Component | Role |
|---|---|---|
| Drone (Quiver drone) | `companion_scripts/hublink_service.py` (reference) | WebSocket **server**; emits frames |
| Hub | `server/droneSubscriber.ts` | WebSocket **client**; one connection per pull-mode drone |
| Hub | `server/droneStreamProtocol.ts` | IO-free frame parser/interpreter (pure, unit-tested) |

Multiple Hubs may connect to the **same** drone at once (multi-operator
monitoring) — the drone treats each connection independently.

---

## 2. Transport & endpoint

- **WebSocket**, JSON **text** frames, UTF-8. One connection per subscribing Hub.
- The drone listens on its tailnet (MagicDNS) address: `ws://<drone>.<tailnet>.ts.net:<port>/stream`.
- Default port **8765** (`drones.streamPort`, configurable per drone).
- Reachability is gated by **Tailscale ACLs** (only authorised hub tags reach
  `tag:fleet-*` on this port). This is layer 1; the API key below is layer 2.

The Hub builds the URL as
`ws://<tailnetHost>:<streamPort>/stream?drone_id=<id>` — `drone_id` is a routing/
logging convenience only and is **not** trusted for telemetry attribution.

---

## 3. Authentication

The Hub presents the drone's **per-drone API key** (the same secret used by push
mode) in the WebSocket **subprotocol** list, so it never appears in the URL/path
or in logs:

```
Sec-WebSocket-Protocol: quiver.stream.v1, bearer.<apiKey>
```

- The drone validates the `bearer.<apiKey>` value and negotiates the app
  subprotocol **`quiver.stream.v1`**.
- On failure the drone closes the socket with code **1008** (policy violation).
- The Hub resolves the key via `getActiveApiKeyForDrone()` (most-recent active
  key for that drone). A pull-mode drone with no active key is skipped with a
  warning.

> Two layers, both required: Tailscale ACLs decide *which hubs can reach the
> port*; the API key decides *which drone's data this hub may pull*.

---

## 4. Drone → Hub frames

Every frame is a JSON object with a string `type`. **`drone_id` is never sent per
frame** — the Hub injects it from the authenticated connection, so a drone cannot
attribute data to another drone over its own socket.

### `hello` (sent once, on connect)
```json
{ "type": "hello", "protocol": 1, "services": ["telemetry", "camera_status", "pointcloud"] }
```
Advertises protocol version and which streams this drone will emit. Informational;
the Hub logs it and continues.

### `telemetry`
```json
{ "type": "telemetry", "timestamp": "2026-06-16T12:00:00.000Z", "telemetry": { /* … */ } }
```
- `timestamp` (ISO-8601) is optional; the Hub stamps server time if omitted.
- `telemetry` is the **same object** the REST ingest and `telemetry_forwarder.py`
  use (`attitude`, `position`, `gps`, `battery_fc`, `battery_uavcan`, `in_air`,
  `arms`, …). The Hub persists it (`insertTelemetry`), updates the drone's
  `lastSeen`, and `broadcastTelemetry()`s it to browsers — identical to push.

### `camera_status`
```json
{ "type": "camera_status", "timestamp": 1718539200000, "connected": true,
  "attitude": { "yaw": 0, "pitch": 0, "roll": 0 }, "recording": false,
  "hdr_enabled": false, "tf_card_present": true, "zoom_level": 1 }
```
- `timestamp` is epoch **milliseconds**, optional (server stamps if omitted).
- `connected` is required. Maps to `broadcastCameraStatus()`.

### `pointcloud`
```json
{ "type": "pointcloud", "timestamp": "2026-06-16T12:00:00.000Z",
  "points": [ /* … */ ], "stats": { /* … */ } }
```
Maps to `broadcastPointCloud()`. Same shape as the REST `/pointcloud/ingest` body
(minus `drone_id`).

### `pong`
```json
{ "type": "pong", "ts": 1718539200000 }
```
Reply to the Hub's heartbeat `ping`. Ignored by the Hub beyond marking liveness.

Unknown `type` values are **ignored** (logged), so the protocol can grow without
breaking older Hubs. Malformed JSON or missing required fields are logged as a bad
frame and dropped (the connection stays up).

---

## 5. Hub → Drone frames

### `ping` (heartbeat)
```json
{ "type": "ping", "ts": 1718539200000 }
```
The Hub sends this every `heartbeatMs` (default 15 s) on an open connection. The
drone should reply with `pong`. The control/lease frames are in §9.

---

## 6. Connection lifecycle (Hub side)

- **Connect** when a drone is in `ingestMode = "pull"` with a `tailnetHost` and an
  active API key. Driven by `getPullDrones()` at startup and on every
  `drones.setConnection` mutation (`reconcileDroneSubscribers()`).
- **Reconnect** automatically with exponential backoff + jitter
  (`backoffMin` 1 s → `backoffMax` 30 s) on any close/error. Backoff resets on a
  successful open.
- **Reconcile** on config change: a drone switched to push, deleted, or whose
  host/port/key changed has its connection torn down (and re-opened if still
  pull-mode). Drones left in push mode are never connected.
- **Shutdown** closes all connections.

The manager and all its dependencies (socket factory, drone loader,
broadcast/persist sink, clock, scheduler) are injectable, so the logic is
unit-tested with a fake transport — no real sockets, DB, or Socket.IO.

---

## 7. Versioning

`quiver.stream.v1` is the negotiated app subprotocol and `protocol: 1` is echoed
in `hello`. A breaking change bumps both. Additive frame types do **not** bump the
version (unknown types are ignored by design).

---

## 8. Reference implementation

`companion_scripts/hublink_service.py` is a runnable drone-side reference:

```bash
# On the drone (or benchtop), emit synthetic telemetry:
python3 hublink_service.py --demo --port 8765
```

Then set the drone to pull mode from the Hub — **Drone Configuration → Data Plane
& Control**, or the tRPC `drones.setConnection` mutation:
`{ droneId, ingestMode: "pull", tailnetHost: "<drone>.<tailnet>.ts.net", streamPort: 8765 }`.

Production replaces the demo source with the real MAVSDK/UAVCAN assembly (as in
`telemetry_forwarder.py`); the wire protocol is unchanged.

---

## 9. Control lease & commands (Phase B2, write path)

Monitoring is many-hubs-read; **control is single-writer**. The **drone is the
lease arbiter** — it is the only node every hub shares, so it is the only place a
single-writer guarantee can be enforced. At most one hub holds the lease at a time.

### 9.1 Frames

**Hub → Drone**

```json
{ "type": "lease_acquire",   "hub_id": "hub-op1",  "request_id": "acq-1" }
{ "type": "lease_heartbeat", "lease_id": "<id>" }
{ "type": "lease_release",   "lease_id": "<id>",   "request_id": "rel-2" }
{ "type": "command",         "lease_id": "<id>",   "request_id": "cmd-3",
  "action": "set_zoom", "params": { "level": 2 } }
```

**Drone → Hub**

```json
{ "type": "lease_granted",  "lease_id": "<id>", "ttl_ms": 30000, "request_id": "acq-1" }
{ "type": "lease_denied",   "held_by": "hub-op2", "reason": "held", "request_id": "acq-1" }
{ "type": "lease_revoked",  "lease_id": "<id>", "reason": "expired" }
{ "type": "lease_released", "lease_id": "<id>", "request_id": "rel-2" }
{ "type": "command_result", "request_id": "cmd-3", "ok": true, "result": { } }
```

### 9.2 Rules

- **Acquire/renew.** The drone grants if the lease is free, expired, or already
  held by the same `hub_id` (renew); otherwise it `lease_denied`s with `held_by`.
  The grant carries a `ttl_ms`.
- **Heartbeat.** The holder sends `lease_heartbeat` every ~`ttl_ms/2`. If the drone
  receives none within `ttl_ms`, it expires the lease and `lease_revoked`s the
  (now former) holder. So a hub that crashes or disconnects loses control
  automatically — another hub can then acquire.
- **Release.** The holder sends `lease_release`; the drone frees it and
  `lease_released`s. The Hub also clears its local state immediately (best effort).
- **Commands.** The drone executes a `command` only if its `lease_id` matches the
  active lease **and** arrives on the holder's connection; otherwise it returns
  `command_result { ok:false, error:"no_control" }`. Results are correlated to the
  request by `request_id`; the Hub times commands out independently.
- **Hub id.** The lease holder is identified by the Hub's `HUB_ID`
  (env override, else `hub-<hostname>`). All browser operators on one Hub share
  that Hub's single lease.

### 9.3 Hub-side mapping

The Hub subscriber keeps per-drone control state (`none` / `requesting` / `held` /
`denied`) and surfaces it to browsers as `control_status` over Socket.IO
(`subscribe_control`). tRPC procedures `drones.acquireControl`,
`releaseControl`, `controlStatus`, and `sendCommand` drive it; the Drone
Configuration **Data Plane & Control** card is the UI. On reconnect the Hub resets
to `none` (the drone has expired the old lease) — control must be re-acquired.

> Two-layer safety unchanged: Tailscale ACLs gate *who can reach the port*, the
> per-drone API key gates *which drone a hub may pull/command*, and the lease gates
> *which one of those hubs may command at any instant*.

---

## 10. Capability manifest (per-payload typed commands)

Drones carry **heterogeneous payload loadouts**, so the set of valid commands is
per-drone. Rather than a fixed command list, a drone **advertises a capability
manifest** that the Hub uses to (a) render typed command forms and (b) reject
unknown actions before they hit the wire. The drone remains the final authority.

### 10.1 Frames

**Hub → Drone:** `{ "type": "get_manifest" }` — sent on connect; the drone may also
push a `manifest` frame unsolicited (e.g. after `hello`, or when a payload is
hot-swapped).

**Drone → Hub:**
```json
{
  "type": "manifest",
  "payloads": [
    {
      "id": "camera",
      "name": "Gimbal Camera",
      "commands": [
        { "action": "set_zoom", "label": "Set Zoom",
          "params": [ { "name": "level", "type": "number", "min": 1, "max": 10, "step": 1, "required": true } ] },
        { "action": "set_mode", "label": "Set Mode",
          "params": [ { "name": "mode", "type": "enum", "options": ["photo","video","night"], "required": true } ] },
        { "action": "start_recording", "label": "Start Recording", "params": [] }
      ]
    },
    { "id": "winch", "name": "Payload Winch", "commands": [ /* … */ ] }
  ]
}
```

### 10.2 Param types

`number` (`min`/`max`/`step`), `string`, `boolean`, `enum` (`options[]`). Each param
may carry `label`, `required`, and `default`. Unknown param types degrade to
`string`; malformed payloads/commands/params are dropped (lenient
`normalizeManifest`), so a partly-broken manifest still yields what is well-formed.

### 10.3 Hub-side mapping

- `server/droneStreamProtocol.ts` `normalizeManifest()` coerces the untrusted frame
  into a typed `CapabilityManifest`.
- The subscriber stores the latest manifest per connection, requests it on open,
  and surfaces changes as `capabilities` over Socket.IO (`subscribe_capabilities`);
  tRPC `drones.capabilities` returns it.
- `sendCommand` rejects actions absent from the manifest with `unknown_action`
  (only when a manifest is present — no manifest means anything is allowed, so the
  control path still works against a drone that advertises nothing).
- UI: `client/src/components/DronePayloadCommands.tsx` renders each payload's
  commands as typed inputs, gated on holding the lease.

Production builds the manifest from the actual detected loadout; the reference
`hublink_service.py` advertises a representative demo (camera + winch).
