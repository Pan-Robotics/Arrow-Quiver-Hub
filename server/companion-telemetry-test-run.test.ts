import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const forwarderPath = path.resolve(import.meta.dirname, "../companion_scripts/telemetry_forwarder.py");
const roots: string[] = [];

// Everything imported by the runtime is replaced before import. No dependency
// installs, FC/Hub connections, sockets, CAN devices, apt or services are used.
const fixture = `import asyncio, importlib.util, json, os, signal, struct, subprocess, sys, threading, time, types
from types import SimpleNamespace as NS
stats = {'constructs': 0, 'connects': 0, 'closes': 0, 'posts': 0, 'sessions': 0,
         'can_binds': 0, 'can_sockets': 0, 'can_nodes': 0, 'can_closes': 0,
         'sample_posts': 0, 'wire_keys': [], 'owned_pids': []}

def flag(name): return os.environ.get(name) == '1'
config = types.ModuleType('companion_config')
config.load_environment = lambda: dict(os.environ)
sys.modules['companion_config'] = config

class Core:
    def __init__(self, attempt): self.attempt = attempt
    async def connection_state(self):
        yield NS(is_connected=not flag('NO_CONNECTION'))
        if flag('DISCONNECT') and self.attempt == 1:
            await asyncio.sleep(.15)
            yield NS(is_connected=False)
        while True: await asyncio.sleep(60)

class Telemetry:
    def __init__(self, attempt): self.attempt = attempt
    async def set_rate_battery(self, rate): pass
    async def set_rate_gps_info(self, rate): pass
    async def set_rate_position(self, rate): pass
    async def set_rate_attitude_euler(self, rate): pass
    async def stream(self, name):
        if flag('COLLECTOR_END') and name == 'attitude': return
        if flag('COLLECTOR_ERROR') and name == 'attitude':
            raise RuntimeError('https://bad.invalid/?api_key=super-secret-key remote body secret')
        no_data = flag('NO_DATA') or flag('AIR_ONLY') or (flag('FIRST_CONNECTION_ONLY') and self.attempt > 1)
        if name == 'attitude' and not no_data:
            yield NS(roll_deg=1, pitch_deg=2, yaw_deg=3)
            if flag('ONE_SAMPLE'): no_data = True
        if name == 'air' and flag('AIR_ONLY') and not flag('NO_DATA'):
            yield False  # A real false in-air sample, not the default false value.
        while True:
            await asyncio.sleep(60 if no_data or name != 'attitude' else .025)
            if not no_data and name == 'attitude': yield NS(roll_deg=1, pitch_deg=2, yaw_deg=3)
    def attitude_euler(self): return self.stream('attitude')
    def position(self): return self.stream('position')
    def gps_info(self): return self.stream('gps')
    def battery(self): return self.stream('battery')
    def in_air(self): return self.stream('air')

class System:
    def __init__(self):
        stats['constructs'] += 1
        self._server_process = None
        if flag('BAD_SDK'): raise RuntimeError('super-secret-key native System API mismatch')
        if flag('LEGACY_CHILD'): self.close = None
    async def connect(self, system_address=None):
        stats['connects'] += 1
        self.core = Core(stats['connects'])
        self.telemetry = Telemetry(stats['connects'])
        if flag('LEGACY_CHILD'):
            self._server_process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
            stats['owned_pids'].append(self._server_process.pid)
            if flag('HANG_CONNECT'): await asyncio.sleep(60)
    async def close(self):
        stats['closes'] += 1
        if flag('CLOSE_FAIL'): raise RuntimeError('super-secret-key cleanup error')
sdk = types.ModuleType('mavsdk'); sdk.System = System; sys.modules['mavsdk'] = sdk
support = types.ModuleType('installer_support')
def sdk_preflight():
    System()
    print('Legacy MAVSDK/FTP API preflight passed: 3.17.4')
support.sdk_preflight = sdk_preflight; sys.modules['installer_support'] = support

class Response:
    status = int(os.environ.get('HTTP_STATUS', '200'))
    headers = {'Retry-After': os.environ.get('RETRY_AFTER', '')}
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    async def json(self):
        if flag('BAD_JSON'): raise ValueError('super-secret-key untrusted body')
        if flag('SLOW_ACK'): await asyncio.sleep(.2)
        return {'success': not flag('BAD_ACK')}
    async def text(self): raise AssertionError('never read/log raw HTTP error bodies')
class Session:
    def __init__(self, **kwargs):
        stats['sessions'] += 1
        if flag('HTTP_WORKER_DEAD'): raise RuntimeError('super-secret-key sensitive URL')
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    def post(self, url, json=None):
        stats['posts'] += 1
        stats['wire_keys'] = sorted(json.keys())
        if json.get('telemetry', {}).get('attitude') is not None: stats['sample_posts'] += 1
        if flag('HTTP_EXCEPTION'): raise RuntimeError('super-secret-key https://bad.invalid/private')
        return Response()
http = types.ModuleType('aiohttp'); http.ClientSession = Session
http.ClientTimeout = lambda **kwargs: NS(**kwargs); sys.modules['aiohttp'] = http

class Driver:
    def __init__(self, interface): pass
    def close(self): stats['can_closes'] += 1
class Node:
    def __init__(self, driver, node_id):
        stats['can_nodes'] += 1
        if flag('CAN_NOT_READY'): raise OSError('NoDevice super-secret-key')
    def add_handler(self, kind, callback): self.callback = callback
    def spin(self, timeout):
        if flag('BATTERY_DATA'):
            self.callback(NS(message=NS(voltage=48, current=2, temperature=300,
                state_of_charge_pct=80, state_of_health_pct=90)))
        time.sleep(.01)
    def close(self): stats['can_closes'] += 1
can = types.ModuleType('dronecan'); can.node = NS(Node=Node)
can.uavcan = NS(protocol=NS(GetNodeInfo=NS(Response=lambda: NS(name='',software_version=NS(major=0,minor=0)))),
    equipment=NS(power=NS(BatteryInfo=object)))
sys.modules['dronecan'] = can; sys.modules['dronecan.driver'] = types.ModuleType('dronecan.driver')
socketcan = types.ModuleType('dronecan.driver.socketcan'); socketcan.SocketCAN = Driver
sys.modules['dronecan.driver.socketcan'] = socketcan
spec = importlib.util.spec_from_file_location('forwarder_under_test', os.environ['FORWARDER_PATH'])
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
f.INITIAL_BACKOFF_SECONDS = .02

class Probe:
    def __init__(self, *args): stats['can_sockets'] += 1
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def fileno(self): return 999
    def bind(self, address):
        stats['can_binds'] += 1
        if flag('CAN_DENIED'): raise PermissionError('super-secret-key')
def if_index(interface):
    if flag('CAN_MISSING'): raise OSError('super-secret-key')
    return 1
f.socket = NS(AF_CAN=29, SOCK_RAW=3, CAN_RAW=1, socket=Probe, if_nametoindex=if_index)
fcntl = types.ModuleType('fcntl')
fcntl.ioctl = lambda *args: b'x' * 16 + struct.pack('H', 0 if flag('CAN_DOWN') else 1) + b'x' * 238
sys.modules['fcntl'] = fcntl
`;

function run(args: string[] = [], env: Record<string, string> = {}, exercise?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "quiver-telemetry-live-"));
  roots.push(root);
  const script = path.join(root, "exercise.py");
  writeFileSync(script, fixture + "\n" + (exercise ?? `
sys.argv = ['telemetry_forwarder.py', *json.loads(os.environ['CLI_ARGS'])]
if flag('INTERRUPT'):
    threading.Thread(target=lambda: (time.sleep(.2), os.kill(os.getpid(), int(os.environ.get('SIGNAL', str(signal.SIGTERM))))), daemon=True).start()
try: code = f.main()
except SystemExit as error: code = error.code
print(json.dumps(stats))
sys.exit(code)
`));
  const started = Date.now();
  const result = spawnSync("python3", [script], {
    cwd: root, encoding: "utf8", timeout: 7000,
    env: { PATH: process.env.PATH ?? "", FORWARDER_PATH: forwarderPath,
      WEB_SERVER_URL: "https://hub.example", API_KEY: "super-secret-key", DRONE_ID: "drone",
      ENABLE_UAVCAN: "false", UPDATE_RATE_HZ: "10", UAVCAN_NODE_ID: "111",
      CLI_ARGS: JSON.stringify(args), ...env },
  });
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1);
  return { ...result, elapsed: Date.now() - started, observed: lastLine ? JSON.parse(lastLine) : undefined };
}
function safe(result: ReturnType<typeof run>) {
  expect(result.stderr).not.toContain("Traceback");
  expect(result.stderr + result.stdout).not.toContain("super-secret-key");
  expect(result.stderr).not.toContain("All workers started");
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("telemetry offline CLI preflight", () => {
  it("help works before dependency/config numeric validation", () => {
    const result = run(["--help"], { BAD_SDK: "1", UPDATE_RATE_HZ: "nan", UAVCAN_NODE_ID: "bad" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--test-run");
    expect(result.observed.constructs).toBe(0);
    safe(result);
  });
  it("valid numeric CLI overrides win over bad environment defaults", () => {
    const result = run(["--check", "--update-rate-hz", "10", "--uavcan-node-id", "23"],
      { UPDATE_RATE_HZ: "nan", UAVCAN_NODE_ID: "bad" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed).toMatchObject({ constructs: 1, connects: 0, posts: 0, can_sockets: 0 });
    safe(result);
  });
  it("offline CAN preflight checks up/bind without creating an active node", () => {
    const result = run(["--check"], { ENABLE_UAVCAN: "true" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed).toMatchObject({ connects: 0, posts: 0, can_sockets: 1, can_binds: 1, can_nodes: 0 });
    expect(result.stdout).toContain("without transmit");
    safe(result);
  });
  it.each(["CAN_MISSING", "CAN_DOWN", "CAN_DENIED"])("rejects enabled %s before workers", problem => {
    const result = run(["--check"], { ENABLE_UAVCAN: "true", [problem]: "1" });
    expect(result.status).toBe(2);
    expect(result.observed).toMatchObject({ connects: 0, posts: 0, can_nodes: 0 });
    safe(result);
  });
  it("explicit disable-uavcan skips the CAN socket entirely", () => {
    const result = run(["--check", "--disable-uavcan"], { ENABLE_UAVCAN: "true", CAN_MISSING: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed.can_sockets).toBe(0);
  });
  it("rejects malformed ENABLE_UAVCAN rather than silently disabling a required bus", () => {
    const result = run(["--check"], { ENABLE_UAVCAN: "tru" });
    expect(result.status).toBe(2);
    expect(result.observed.constructs).toBe(0);
    safe(result);
    const disabled = run(["--check", "--disable-uavcan"], { ENABLE_UAVCAN: "tru" });
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(disabled.observed.can_sockets).toBe(0);
  });
  it.each([{ args: [] }, { args: ["--check"] }, { args: ["--test-run", "--test-seconds", "1"] }])("controls incompatible System API before startup: $args", ({ args }) => {
    const result = run(args, { BAD_SDK: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("legacy MAVSDK 3.17.4 dependency/API preflight failed");
    expect(result.observed).toMatchObject({ connects: 0, posts: 0, can_nodes: 0 });
    safe(result);
  });
  it.each(["0", "-1", "301", "nan", "inf", "bad"])("rejects duration %s before dependency/hardware access", seconds => {
    const result = run(["--test-run", "--test-seconds", seconds]);
    expect(result.status).toBe(2);
    expect(result.observed.constructs).toBe(0);
    safe(result);
  });
  it("validates bounds and default 30 seconds without waiting 30 seconds", () => {
    const result = run([], {}, `
assert f.validate_test_seconds('1') == 1
assert f.validate_test_seconds('300') == 300
received = []
f.TelemetryForwarder.start = lambda self, duration_seconds=None: received.append(duration_seconds) or True
sys.argv = ['telemetry', '--test-run']; assert f.main() == 0
print(json.dumps(received))
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed).toEqual([30]);
  });
  it.each(["udpin://0.0.0.0:bad", "tcpout://host:70000", "unsupported://host:123"])("rejects malformed FC endpoint %s offline", url => {
    const result = run(["--check", "--mavlink-url", url]);
    expect(result.status).toBe(2);
    expect(result.observed.constructs).toBe(0);
    safe(result);
  });
});

describe("bounded telemetry live readiness", () => {
  it("passes only real FC samples and acknowledged Hub posts over a full window", () => {
    const result = run(["--test-run", "--test-seconds", "1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.elapsed).toBeGreaterThanOrEqual(950);
    expect(result.stderr).toContain("TEST PASS");
    expect(result.observed.sessions).toBe(1);
    expect(result.observed.sample_posts).toBeGreaterThanOrEqual(8);
    expect(result.observed.wire_keys).toEqual(["api_key", "drone_id", "telemetry", "timestamp"]);
    safe(result);
  });
  it("10Hz fast path has no extra per-message pacing or session creation", () => {
    const result = run(["--test-run", "--test-seconds", "1"]);
    expect(result.observed.posts).toBeGreaterThanOrEqual(8);
    expect(result.observed.posts).toBeLessThanOrEqual(11);
    expect(result.observed.sessions).toBe(1);
  });
  it("counts a real false in-air subscription sample but never its default false", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { AIR_ONLY: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed.posts).toBe(1);
    expect(result.observed.sample_posts).toBe(0);
    expect(result.stderr).toContain("FC_samples=1 Hub_ack=yes");
  });
  it("cleanup failure overrides healthy data/acks and never emits TEST PASS", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { CLOSE_FAIL: "1" });
    expect(result.status).toBe(2);
    expect(result.observed.posts).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("TEST PASS");
    expect(result.stderr).toContain("Shutdown incomplete; not PASS");
    safe(result);
  });
  it("enabled CAN ready passes without optional BatteryInfo", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { ENABLE_UAVCAN: "true" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("CAN=ready BatteryInfo=0 (optional)");
    expect(result.observed.can_nodes).toBe(1);
    expect(result.observed.can_closes).toBe(2);
  });
  it("reports actual optional CAN BatteryInfo", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { ENABLE_UAVCAN: "true", BATTERY_DATA: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/CAN=ready BatteryInfo=[1-9]\d* \(optional\)/);
  });
  it.each(["NO_CONNECTION", "NO_DATA", "BAD_ACK", "BAD_JSON", "HTTP_EXCEPTION", "COLLECTOR_END", "COLLECTOR_ERROR"])("never false-passes %s", problem => {
    const result = run(["--test-run", "--test-seconds", "1"], { [problem]: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("TEST PASS");
    if (["NO_CONNECTION", "NO_DATA", "COLLECTOR_END"].includes(problem)) expect(result.observed.posts).toBe(0);
    expect(result.elapsed).toBeLessThan(3000);
    safe(result);
  });
  it.each([401, 429, 503])("HTTP %s cannot count as Hub acknowledgement", status => {
    const result = run(["--test-run", "--test-seconds", "1"], { HTTP_STATUS: String(status), RETRY_AFTER: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("TEST PASS");
    if (status === 429) expect(result.observed.posts).toBe(1);
    safe(result);
  });
  it("CAN worker alive but never ready cannot pass", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { ENABLE_UAVCAN: "true", CAN_NOT_READY: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CAN=waiting");
    safe(result);
  });
  it("dead required HTTP worker ends the test promptly and without an unhandled traceback", () => {
    const result = run(["--test-run", "--test-seconds", "30"], { HTTP_WORKER_DEAD: "1" });
    expect(result.status).toBe(2);
    expect(result.elapsed).toBeLessThan(1500);
    expect(result.stderr).toContain("Required worker exited: http");
    safe(result);
  });
  it("normal service supervision also fails a dead required worker", () => {
    const result = run([], { HTTP_WORKER_DEAD: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Required worker exited: http");
    safe(result);
  });
  it.each(["2", "15"])("signal %s interrupts gracefully even after successful samples/acks", signal => {
    const result = run(["--test-run", "--test-seconds", "30"], { INTERRUPT: "1", SIGNAL: signal });
    expect(result.status).toBe(2);
    expect(result.observed.posts).toBeGreaterThan(0);
    expect(result.stderr).toContain("TEST interrupted; not PASS");
    expect(result.stderr).toContain("Shutdown complete");
    safe(result);
  });
  it("connection loss invalidates samples and acknowledgements instead of stale success after reconnect", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { DISCONNECT: "1", FIRST_CONNECTION_ONLY: "1" });
    expect(result.status).toBe(2);
    expect(result.observed.connects).toBeGreaterThanOrEqual(2);
    expect(result.observed.posts).toBeLessThanOrEqual(2);
    expect(result.stderr).toContain("FC_samples=0 Hub_ack=waiting");
    safe(result);
  });
  it("cannot reuse an in-flight acknowledgement from a disconnected generation", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { DISCONNECT: "1", FIRST_CONNECTION_ONLY: "1", SLOW_ACK: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Hub_ack=waiting");
    safe(result);
  });
  it("does not repeatedly enqueue a cached FC sample without fresh subscription data", () => {
    const result = run(["--test-run", "--test-seconds", "1"], { ONE_SAMPLE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed.posts).toBe(1);
  });
  it("reaps only the legacy System-owned child even when connect awaits forever", () => {
    const result = run([], { LEGACY_CHILD: "1", HANG_CONNECT: "1" }, `
unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
try:
    instance = f.TelemetryForwarder(web_server_url='https://hub.example', api_key='super-secret-key', enable_uavcan=False)
    assert not instance.start(duration_seconds=1)
    assert stats['owned_pids']
    owned_dead = []
    for pid in stats['owned_pids']:
        try: os.kill(pid, 0); owned_dead.append(False)
        except ProcessLookupError: owned_dead.append(True)
    print(json.dumps({'owned_dead': owned_dead, 'unrelated_alive': unrelated.poll() is None}))
finally:
    unrelated.terminate(); unrelated.wait(timeout=2)
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.observed).toEqual({ owned_dead: [true], unrelated_alive: true });
    safe(result);
  });
});
