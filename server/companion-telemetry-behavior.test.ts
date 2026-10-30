import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const companionDirectory = path.join(repositoryRoot, "companion_scripts");
const forwarderPath = path.join(companionDirectory, "telemetry_forwarder.py");
const temporaryDirectories: string[] = [];

function writeStub(root: string, relativePath: string, content: string) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

/**
 * Provide importable, behaviorally useful Python replacements for the exact
 * runtime dependencies.  They make no sockets, CAN interfaces, or HTTP calls.
 */
function createPythonStubs() {
  const root = mkdtempSync(path.join(tmpdir(), "quiver-telemetry-stubs-"));
  temporaryDirectories.push(root);

  writeStub(
    root,
    "companion_config.py",
    `import os

def load_environment():
    return dict(os.environ)
`,
  );

  writeStub(
    root,
    "mavsdk/__init__.py",
    `import asyncio
import os

connect_calls = 0
close_calls = 0
subscription_attempts = 0

class _State:
    is_connected = True

class _Core:
    async def connection_state(self):
        yield _State()
        while True:
            await asyncio.sleep(60)

class _Telemetry:
    async def set_rate_battery(self, _rate): pass
    async def set_rate_gps_info(self, _rate): pass
    async def set_rate_position(self, _rate): pass
    async def set_rate_attitude_euler(self, _rate): pass

    async def _stream(self, name):
        global subscription_attempts
        if name == 'attitude' and os.environ.get('STUB_SUBSCRIPTION_FAIL_ONCE') == '1':
            subscription_attempts += 1
            if subscription_attempts == 1:
                raise RuntimeError('stub subscription failed')
        while True:
            await asyncio.sleep(60)
            yield None

    def attitude_euler(self): return self._stream('attitude')
    def position(self): return self._stream('position')
    def gps_info(self): return self._stream('gps')
    def battery(self): return self._stream('battery')
    def in_air(self): return self._stream('in_air')

class System:
    def __init__(self):
        self.core = _Core()
        self.telemetry = _Telemetry()

    async def connect(self, system_address=None):
        global connect_calls
        connect_calls += 1
        if os.environ.get('STUB_CONNECT_FAIL_ONCE') == '1' and connect_calls == 1:
            raise RuntimeError('stub connect failed')

    async def close(self):
        global close_calls
        close_calls += 1
`,
  );

  writeStub(
    root,
    "aiohttp.py",
    `class ClientTimeout:
    def __init__(self, total=None):
        self.total = total

class _Response:
    def __init__(self, status):
        self.status = status
    async def __aenter__(self): return self
    async def __aexit__(self, exc_type, exc, traceback): return False
    async def text(self): return 'stub response'

class ClientSession:
    posts = 0
    def __init__(self, timeout=None):
        self.timeout = timeout
    async def __aenter__(self): return self
    async def __aexit__(self, exc_type, exc, traceback): return False
    def post(self, url, json=None):
        type(self).posts += 1
        return _Response(503)
`,
  );

  writeStub(root, "dronecan/__init__.py", "from . import node, uavcan\n");
  writeStub(
    root,
    "dronecan/node.py",
    `import time

NODE_IDS = []
CLOSE_CALLS = 0

class Node:
    def __init__(self, driver, node_id):
        self.driver = driver
        self.node_id = node_id
        NODE_IDS.append(node_id)
    def add_handler(self, _message_type, _callback): pass
    def spin(self, timeout=0.1): time.sleep(min(timeout, 0.01))
    def close(self):
        global CLOSE_CALLS
        CLOSE_CALLS += 1
`,
  );
  writeStub(
    root,
    "dronecan/uavcan.py",
    `class _Response:
    def __init__(self):
        self.name = ''
        self.software_version = type('Version', (), {'major': 0, 'minor': 0})()

class _GetNodeInfo:
    Response = _Response

class _Protocol:
    GetNodeInfo = _GetNodeInfo

class _BatteryInfo: pass
class _Power:
    BatteryInfo = _BatteryInfo
class _Equipment:
    power = _Power

protocol = _Protocol

equipment = _Equipment
`,
  );
  writeStub(root, "dronecan/driver/__init__.py", "");
  writeStub(
    root,
    "dronecan/driver/socketcan.py",
    `CLOSE_CALLS = 0

class SocketCAN:
    def __init__(self, interface):
        self.interface = interface
    def close(self):
        global CLOSE_CALLS
        CLOSE_CALLS += 1
`,
  );

  return root;
}

function runPython(stubDirectory: string, code: string, environment: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", code], {
    cwd: stubDirectory,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1_000_000,
    env: {
      ...process.env,
      ...environment,
      FORWARDER_PATH: forwarderPath,
      PYTHONPATH: `${stubDirectory}${path.delimiter}${companionDirectory}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
    },
  });
}

function importForwarderScript() {
  return `import importlib.util
import os
spec = importlib.util.spec_from_file_location('forwarder_under_test', os.environ['FORWARDER_PATH'])
forwarder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forwarder)
`;
}

function parseLastJsonLine(stdout: string) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) {
    throw new Error(`Expected JSON output, received: ${stdout}`);
  }
  return JSON.parse(line);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("companion telemetry forwarder behavior", () => {
  it("validates direct configuration and normalizes only the exact legacy ingest URL", () => {
    const stubs = createPythonStubs();
    const result = runPython(
      stubs,
      `${importForwarderScript()}
import json
errors = []
for value in ('nan', 'inf', '0', '-1', '101', 'not-a-number'):
    try:
        forwarder.validate_update_rate(value)
    except ValueError as error:
        errors.append(str(error))
node_errors = []
for value in ('0', '128', '3.5', 'node'):
    try:
        forwarder.validate_uavcan_node_id(value)
    except ValueError as error:
        node_errors.append(str(error))
instance = forwarder.TelemetryForwarder(
    web_server_url='https://hub.example/api/rest/telemetry/ingest',
    api_key='key', drone_id='drone', update_rate_hz='10',
    enable_uavcan=False, uavcan_node_id='23')
print(json.dumps({
    'errors': errors,
    'node_errors': node_errors,
    'base_url': instance.web_server_url,
    'ingest_url': instance.ingest_url,
    'node_id': instance.uavcan_node_id,
    'keeps_other_path': forwarder.normalize_hub_url('https://hub.example/custom/path'),
}))
`,
    );

    expect(result.status, result.stderr).toBe(0);
    const observed = parseLastJsonLine(result.stdout);
    expect(observed.errors).toHaveLength(6);
    expect(observed.errors.every((message: string) => message.includes("update rate"))).toBe(true);
    expect(observed.node_errors).toHaveLength(4);
    expect(observed.node_errors.every((message: string) => message.includes("1 to 127"))).toBe(true);
    expect(observed.base_url).toBe("https://hub.example");
    expect(observed.ingest_url).toBe("https://hub.example/api/rest/telemetry/ingest");
    expect(observed.node_id).toBe(23);
    expect(observed.keeps_other_path).toBe("https://hub.example/custom/path");
  });

  it("reports malformed environment rate as a concise argparse startup error", () => {
    const stubs = createPythonStubs();
    const result = runPython(stubs, `import runpy; runpy.run_path('${forwarderPath}', run_name='__main__')`, {
      WEB_SERVER_URL: "https://hub.example",
      API_KEY: "key",
      DRONE_ID: "drone",
      ENABLE_UAVCAN: "false",
      UPDATE_RATE_HZ: "not-a-number",
      UAVCAN_NODE_ID: "111",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid UPDATE_RATE_HZ/--update-rate-hz: update rate must be a number");
    expect(result.stderr).not.toContain("Traceback");
  });

  it("reconnects after a legacy MAVSDK connect failure and closes attempted systems on shutdown", () => {
    const stubs = createPythonStubs();
    const result = runPython(
      stubs,
      `${importForwarderScript()}
import asyncio
import json
import mavsdk

async def exercise():
    forwarder.INITIAL_BACKOFF_SECONDS = 0.01
    instance = forwarder.TelemetryForwarder(
        web_server_url='https://hub.example', api_key='key', drone_id='drone',
        update_rate_hz=10, enable_uavcan=False)
    task = asyncio.create_task(instance.mavlink_worker_async())
    for _ in range(300):
        if mavsdk.connect_calls >= 2:
            break
        await asyncio.sleep(0.01)
    instance.stop_event.set()
    await asyncio.wait_for(task, timeout=2)
    print(json.dumps({'connect_calls': mavsdk.connect_calls, 'close_calls': mavsdk.close_calls}))

asyncio.run(exercise())
`,
      { STUB_CONNECT_FAIL_ONCE: "1" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toEqual({ connect_calls: 2, close_calls: 2 });
  });

  it("reconnects after a collector subscription failure rather than leaving a live but inert worker", () => {
    const stubs = createPythonStubs();
    const result = runPython(
      stubs,
      `${importForwarderScript()}
import asyncio
import json
import mavsdk

async def exercise():
    forwarder.INITIAL_BACKOFF_SECONDS = 0.01
    instance = forwarder.TelemetryForwarder(
        web_server_url='https://hub.example', api_key='key', drone_id='drone',
        update_rate_hz=10, enable_uavcan=False)
    task = asyncio.create_task(instance.mavlink_worker_async())
    for _ in range(300):
        if mavsdk.connect_calls >= 2:
            break
        await asyncio.sleep(0.01)
    instance.stop_event.set()
    await asyncio.wait_for(task, timeout=2)
    print(json.dumps({
        'connect_calls': mavsdk.connect_calls,
        'subscription_attempts': mavsdk.subscription_attempts,
        'close_calls': mavsdk.close_calls,
    }))

asyncio.run(exercise())
`,
      { STUB_SUBSCRIPTION_FAIL_ONCE: "1" },
    );

    expect(result.status, result.stderr).toBe(0);
    const observed = parseLastJsonLine(result.stdout);
    expect(observed.connect_calls).toBeGreaterThanOrEqual(2);
    expect(observed.subscription_attempts).toBe(2);
    expect(observed.close_calls).toBeGreaterThanOrEqual(2);
  });

  it("uses the configured UAVCAN node ID and closes the active node and SocketCAN driver", () => {
    const stubs = createPythonStubs();
    const result = runPython(
      stubs,
      `${importForwarderScript()}
import json
import threading
import time
import dronecan.node
from dronecan.driver import socketcan

instance = forwarder.TelemetryForwarder(
    web_server_url='https://hub.example', api_key='key', drone_id='drone',
    update_rate_hz=10, enable_uavcan=True, uavcan_node_id='23')
thread = threading.Thread(target=instance.uavcan_worker)
thread.start()
time.sleep(0.05)
instance.stop_event.set()
thread.join(timeout=2)
print(json.dumps({
    'alive': thread.is_alive(),
    'node_ids': dronecan.node.NODE_IDS,
    'node_closes': dronecan.node.CLOSE_CALLS,
    'driver_closes': socketcan.CLOSE_CALLS,
}))
`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toEqual({
      alive: false,
      node_ids: [23],
      node_closes: 1,
      driver_closes: 1,
    });
    expect(result.stderr).toContain("Active bus participant");
    expect(result.stderr).toContain("does not reconfigure the CAN interface");
  });

  it("bounds transient HTTP failure handling, reports a dropped live sample, and exits cleanly", () => {
    const stubs = createPythonStubs();
    const result = runPython(
      stubs,
      `${importForwarderScript()}
import json
import threading
import time
import aiohttp

forwarder.INITIAL_BACKOFF_SECONDS = 1
instance = forwarder.TelemetryForwarder(
    web_server_url='https://hub.example', api_key='key', drone_id='drone',
    update_rate_hz=10, enable_uavcan=False)
instance.http_queue.put({'sample': True})
thread = threading.Thread(target=instance.http_worker)
instance.http_thread = thread
thread.start()
for _ in range(100):
    if aiohttp.ClientSession.posts:
        break
    time.sleep(0.01)
instance.stop()
print(json.dumps({
    'alive': thread.is_alive(),
    'posts': aiohttp.ClientSession.posts,
    'sent': instance.send_count,
    'failed': instance.failed_send_count,
    'dropped': instance.dropped_count,
}))
`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toEqual({
      alive: false,
      posts: 1,
      sent: 0,
      failed: 1,
      dropped: 1,
    });
    expect(result.stderr).toContain("Transient delivery failure");
    expect(result.stderr).toContain("sample dropped");
  });

  it("translates SIGTERM into graceful task cancellation and thread shutdown", () => {
    const stubs = createPythonStubs();
    const result = runPython(
      stubs,
      `${importForwarderScript()}
import os
import signal
import threading
import time

def terminate_self():
    time.sleep(0.10)
    os.kill(os.getpid(), signal.SIGTERM)

threading.Thread(target=terminate_self, daemon=True).start()
forwarder.main()
`,
      {
        WEB_SERVER_URL: "https://hub.example",
        API_KEY: "key",
        DRONE_ID: "drone",
        ENABLE_UAVCAN: "false",
        UPDATE_RATE_HZ: "10",
        UAVCAN_NODE_ID: "111",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("SIGTERM received; shutting down gracefully");
    expect(result.stderr).toContain("Final stats:");
    expect(result.stderr).toContain("Shutdown complete");
  });
});
