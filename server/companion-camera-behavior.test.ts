import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const suite = resolve("companion_scripts");

function runPython(source: string) {
  const result = spawnSync("python3", ["-c", source], {
    cwd: suite,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("companion camera runtime behavior", () => {
  it("normalizes endpoint and Hub URLs and builds current direct Funnel argv", () => {
    const output = runPython(`
import json
import camera_stream_service as stream

calls = []
class Result:
    returncode = 0
    stderr = ""
def fake_run(argv, **kwargs):
    calls.append(argv)
    return Result()
stream.subprocess.run = fake_run

url, host, port = stream.normalize_go2rtc_api_url("http://[::1]:2999")
print(json.dumps({
    "endpoint": [url, host, port],
    "hub": [
        stream.normalize_hub_rest_url("wss://hub.example/ws"),
        stream.normalize_hub_rest_url("https://hub.example/news"),
        stream.normalize_hub_rest_url("https://hub.example/socket.io/"),
    ],
    "funnel_ok": stream.setup_tailscale_funnel(2999, 8443),
    "funnel_bad": stream.setup_tailscale_funnel(2999, 22),
    "argv": calls,
}))
`);

    expect(output.endpoint).toEqual(["http://[::1]:2999", "::1", 2999]);
    expect(output.hub).toEqual([
      "https://hub.example",
      "https://hub.example/news",
      "https://hub.example/socket.io",
    ]);
    expect(output.funnel_ok).toBe(true);
    expect(output.funnel_bad).toBe(false);
    expect(output.argv).toEqual([[
      "tailscale",
      "funnel",
      "--bg",
      "--https=8443",
      "http://127.0.0.1:2999",
    ]]);
  });

  it("derives a URL-only go2rtc override and does not restart an external service", () => {
    const output = runPython(`
import asyncio
import json
import camera_stream_service as stream

service = stream.WebRTCStreamingService(
    go2rtc_api="http://127.0.0.1:2999",
    skip_funnel_setup=True,
)
service.go2rtc_external = True
starts = []
checks = []
def unexpected_start():
    starts.append("start")
    return True
def health():
    checks.append("health")
    if len(checks) >= 3:
        service.stop()
    return True
service._start_go2rtc = unexpected_start
service._check_stream_health = health
service._detect_webrtc_url = lambda: "http://public.invalid/api/webrtc?src=camera"
service._register_stream_with_hub = lambda url: None
service._unregister_stream_from_hub = lambda: None
service._stop_go2rtc = lambda: starts.append("stop")
asyncio.run(service.run())
print(json.dumps({
    "api": service.go2rtc_api,
    "host": service.api_host,
    "port": service.api_port,
    "starts": starts,
    "checks": len(checks),
    "status": service.get_status(),
}))
`);

    expect(output.api).toBe("http://127.0.0.1:2999");
    expect(output.host).toBe("127.0.0.1");
    expect(output.port).toBe(2999);
    // No local start/restart attempt is made. Cleanup invokes the service's
    // no-op external stop seam exactly once in this stubbed test.
    expect(output.starts).toEqual(["stop"]);
    expect(output.checks).toBe(3);
    expect((output.status as Record<string, unknown>).go2rtc_external).toBe(true);
    expect((output.status as Record<string, unknown>).go2rtc_running).toBe(true);
  });

  it("adapts the current UI command envelope and rejects malformed params before control", () => {
    const output = runPython(`
import asyncio
import json
from siyi_camera_controller import CameraWebSocketBridge, CameraStatus, GimbalAttitude

class Camera:
    def __init__(self):
        self.calls = []
    async def rotate_gimbal(self, yaw, pitch): self.calls.append(("rotate", yaw, pitch)); return True
    async def set_gimbal_angles(self, yaw, pitch): self.calls.append(("angles", yaw, pitch)); return GimbalAttitude(yaw, pitch, 0, 0, 0, 0)
    async def center_gimbal(self): self.calls.append(("center",)); return True
    async def nadir_gimbal(self): self.calls.append(("nadir",)); return True
    async def zoom(self, direction): self.calls.append(("zoom", direction)); return 2.0
    async def set_zoom(self, level): self.calls.append(("set_zoom", level)); return True
    async def capture_photo(self): self.calls.append(("photo",)); return True
    async def start_recording(self): self.calls.append(("record",)); return True
    async def stop_recording(self): self.calls.append(("stop_record",)); return True
    async def auto_focus(self, x, y): self.calls.append(("focus", x, y)); return True
    async def get_gimbal_attitude(self): return None
    async def get_camera_status(self): return CameraStatus(False, False, True)

async def main():
    bridge = CameraWebSocketBridge("https://hub.invalid", "drone-1", "key")
    bridge.camera = Camera()
    commands = [
        {"droneId": "drone-1", "command": {"type": "rotate", "yawSpeed": 50, "pitchSpeed": -20}},
        {"droneId": "drone-1", "command": {"type": "setAngles", "yaw": 1.5, "pitch": -2}},
        {"droneId": "drone-1", "command": {"type": "center"}},
        {"droneId": "drone-1", "command": {"type": "nadir"}},
        {"droneId": "drone-1", "command": {"type": "zoom", "level": 4.1}},
        {"droneId": "drone-1", "command": {"type": "photo"}},
        {"droneId": "drone-1", "command": {"type": "recordToggle"}},
    ]
    results = [await bridge.handle_command(command) for command in commands]
    invalid = await bridge.handle_command({"command": {"type": "rotate", "yawSpeed": "fast", "pitchSpeed": 0}})
    print(json.dumps({"results": results, "invalid": invalid, "calls": bridge.camera.calls}))
asyncio.run(main())
`);

    expect((output.results as Array<Record<string, unknown>>).every(result => result.success === true)).toBe(true);
    expect(output.calls).toEqual([
      ["rotate", 50, -20],
      ["angles", 1.5, -2],
      ["center"],
      ["nadir"],
      ["set_zoom", 4.1],
      ["photo"],
      ["record"],
    ]);
    expect(output.invalid).toMatchObject({ success: false, error: "invalid_params" });
  });

  it("uses documented status offsets, decimal tenths, transmission failure, framed CRC validation, and zero-velocity cleanup", () => {
    const output = runPython(`
import asyncio
import json
from siyi_camera_controller import SIYICameraController, CmdId

class Probe(SIYICameraController):
    def __init__(self):
        super().__init__()
        self.sent = []
    async def _send_command(self, cmd_id, data=b"", expect_response=True, timeout=2.0):
        self.sent.append((int(cmd_id), list(data), expect_response))
        if cmd_id == CmdId.CAMERA_INFO:
            return bytes([0, 1, 0, 2])
        if cmd_id == CmdId.ABSOLUTE_ZOOM:
            return b"ok"
        return None

class StopProbe(SIYICameraController):
    def __init__(self):
        super().__init__()
        self.connected = True
        self.calls = []
    async def rotate_gimbal(self, yaw, pitch):
        self.calls.append((yaw, pitch))
        return True

async def main():
    probe = Probe()
    status = await probe.get_camera_status()
    zoom = await probe.set_zoom(4.1)
    photo = await probe.capture_photo()
    record = await probe.start_recording()

    frame_source = SIYICameraController()
    valid = frame_source._build_frame(CmdId.GIMBAL_ROTATION, b"\\x01")
    broken = valid[:-1] + bytes([valid[-1] ^ 0xFF])
    parser = SIYICameraController()
    parser._receive_buffer.extend(valid[:4])
    partial = parser._take_next_frame()
    parser._receive_buffer.extend(valid[4:] + broken)
    extracted = parser._take_next_frame()
    parsed = parser._parse_response(extracted)
    broken_frame = parser._take_next_frame()
    try:
        parser._parse_response(broken_frame)
        crc_rejected = False
    except ValueError:
        crc_rejected = True

    stopper = StopProbe()
    await stopper.disconnect(stop_motion=True)
    print(json.dumps({
        "status": status.__dict__ if status else None,
        "zoom": zoom,
        "photo": photo,
        "record": record,
        "sent": probe.sent,
        "partial": partial is None,
        "parsed": [int(parsed[0]), list(parsed[1])],
        "crc_rejected": crc_rejected,
        "stop_calls": stopper.calls,
        "disconnected": not stopper.connected and stopper.socket is None,
    }))
asyncio.run(main())
`);

    expect(output.status).toEqual({ hdr_enabled: true, recording: false, tf_card_present: false });
    expect(output.zoom).toBe(true);
    expect(output.photo).toBe(false);
    expect(output.record).toBe(false);
    expect(output.sent).toContainEqual([15, [4, 1], true]);
    expect(output.partial).toBe(true);
    expect(output.parsed).toEqual([7, [1]]);
    expect(output.crc_rejected).toBe(true);
    expect(output.stop_calls).toEqual([[0, 0]]);
    expect(output.disconnected).toBe(true);
  });
});
