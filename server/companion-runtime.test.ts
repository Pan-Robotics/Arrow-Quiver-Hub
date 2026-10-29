import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const helper = path.join(root, "companion_scripts", "companion_config.py");
const helperDir = path.dirname(helper);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-companion-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runPython(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync("python3", [helper, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  return result;
}

function runRuntime(directory: string, processValues: Record<string, string> = {}) {
  const script = [
    "import json, os, sys",
    `sys.path.insert(0, ${JSON.stringify(helperDir)})`,
    "import companion_config as config",
    `config._SCRIPT_DIR = __import__('pathlib').Path(${JSON.stringify(directory)})`,
    "print(json.dumps(config.load_environment(), sort_keys=True))",
  ].join("; ");
  const result = spawnSync("python3", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...processValues },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const baselineExample = `# A documented comment survives init\nNETWORK_SUBNET=192.168.144.0/24\nFC_IP=.51\nFC_WEBSERVER_PORT=8080\nFC_MAVLINK_TCP_PORT=5760\nMAVLINK_BIND_IP=0.0.0.0\nMAVLINK_UDP_PORT=14540\nSIYI_CAMERA_IP=.25\nSIYI_RTSP_PORT=8554\nSTREAM_TYPE=sub\nGO2RTC_API_HOST=localhost\nGO2RTC_API_PORT=1984\nGO2RTC_WEBRTC_PORT=8555\nCOMPANION_IP=.49\nFIRMWARE_SERVER_PORT=8070\nHUB_URL=\nWEB_SERVER_URL=\nINSTALL_DIR=\nCONFIG_DIR=\nPARSERS_DIR=\n`;

describe("companion configuration helper", () => {
  it("initializes missing defaults without overwriting comments, unknown keys, or a legacy Web URL", () => {
    const directory = temporaryDirectory();
    const envFile = path.join(directory, ".env");
    fs.writeFileSync(path.join(directory, "companion-config.example"), baselineExample);
    fs.writeFileSync(envFile, "# operator comment\nWEB_SERVER_URL=https://legacy.example\nUNKNOWN_KEEP=still-here\n");

    const init = runPython(["init", envFile]);
    expect(init.status, init.stderr).toBe(0);
    const content = fs.readFileSync(envFile, "utf8");
    expect(content).toContain("# operator comment");
    expect(content).toContain("UNKNOWN_KEEP=still-here");
    expect(runPython(["get", envFile, "HUB_URL"]).stdout.trim()).toBe("https://legacy.example");
    expect(runPython(["get", envFile, "WEB_SERVER_URL"]).stdout.trim()).toBe("https://legacy.example");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("sets quoted literal values atomically without executing or interpolating them", () => {
    const directory = temporaryDirectory();
    const envFile = path.join(directory, "companion.env");
    const marker = path.join(directory, "should-not-exist");
    fs.writeFileSync(envFile, "# preserve this comment\nUNKNOWN=kept\n");
    const hostile = `$(touch ${marker}) # $HOME \\\\ path \"quoted\"`;

    const set = runPython(["set", envFile, "API_KEY", hostile, "HUB_URL", "https://hub.example/a path"]);
    expect(set.status, set.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(runPython(["get", envFile, "API_KEY"]).stdout.trim()).toBe(hostile);
    expect(runPython(["get", envFile, "WEB_SERVER_URL"]).stdout.trim()).toBe("https://hub.example/a path");
    const content = fs.readFileSync(envFile, "utf8");
    expect(content).toContain("# preserve this comment");
    expect(content).toContain("UNKNOWN=kept");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("applies runtime precedence and derives endpoints only when they are not explicit", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "companion-config.example"), baselineExample);
    fs.writeFileSync(path.join(directory, "forwarder.env"), "WEB_SERVER_URL=https://legacy.example\nFC_IP=10.1.1.10\n");
    fs.writeFileSync(path.join(directory, ".env"), "HUB_URL=https://local.example\nFC_IP=10.2.2.20\nFC_CONNECTION=tcp\n");
    const override = path.join(directory, "override.env");
    fs.writeFileSync(override, "WEB_SERVER_URL=https://override.example\nFC_IP=10.3.3.30\nSIYI_CAMERA_IP=10.3.3.25\n");

    const resolved = runRuntime(directory, {
      QUIVER_ENV_FILE: override,
      HUB_URL: "https://process.example",
      MAVLINK_UDP_PORT: "14600",
    });
    expect(resolved.HUB_URL).toBe("https://process.example");
    expect(resolved.WEB_SERVER_URL).toBe("https://process.example");
    expect(resolved.FC_WEBSERVER_URL).toBe("http://10.3.3.30:8080");
    expect(resolved.FC_TCP_URL).toBe("tcp://10.3.3.30:5760");
    expect(resolved.FC_CONNECTION).toBe("tcp://10.3.3.30:5760");
    expect(resolved.MAVLINK_URL).toBe("udpin://0.0.0.0:14600");
    expect(resolved.RTSP_URL).toBe("rtsp://10.3.3.25:8554/sub.264");
    expect(resolved.GO2RTC_API_URL).toBe("http://localhost:1984");
    expect(resolved.INSTALL_DIR).toBe(directory);

    fs.writeFileSync(path.join(directory, ".env"), "FC_WEBSERVER_URL=http://explicit.invalid:9999\nFC_CONNECTION=udp\n");
    const explicit = runRuntime(directory);
    expect(explicit.FC_WEBSERVER_URL).toBe("http://explicit.invalid:9999");
    expect(explicit.FC_CONNECTION).toBe("udp://:14540");
  });

  it("fails closed when QUIVER_ENV_FILE is explicitly missing", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "companion-config.example"), baselineExample);
    const script = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(helperDir)})`,
      "import companion_config as config",
      `config._SCRIPT_DIR = __import__('pathlib').Path(${JSON.stringify(directory)})`,
      "config.load_environment()",
    ].join("; ");
    const result = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", QUIVER_ENV_FILE: path.join(directory, "missing.env") },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("QUIVER_ENV_FILE was specified but does not exist");
  });

  it("renders non-secret go2rtc and firmware-puller files from the resolved environment", () => {
    const directory = temporaryDirectory();
    const envFile = path.join(directory, "companion.env");
    const go2rtc = path.join(directory, "go2rtc.yaml");
    const params = path.join(directory, "firmware_puller.param");
    fs.writeFileSync(path.join(directory, "companion-config.example"), baselineExample);
    fs.writeFileSync(envFile, "COMPANION_IP=10.42.0.49\nFIRMWARE_SERVER_PORT=8070\nSIYI_CAMERA_IP=10.42.0.25\nAPI_KEY=must-not-appear\n");

    expect(runPython(["render-go2rtc", envFile, go2rtc]).status).toBe(0);
    const go2rtcContent = fs.readFileSync(go2rtc, "utf8");
    expect(go2rtcContent).toContain('camera: "rtsp://10.42.0.25:8554/sub.264"');
    expect(go2rtcContent).toContain('listen: "localhost:1984"');
    expect(go2rtcContent).not.toContain("must-not-appear");

    expect(runPython(["render-fc-params", envFile, params]).status).toBe(0);
    expect(fs.readFileSync(params, "utf8")).toBe("FWPULL_PI_IP0 10\nFWPULL_PI_IP1 42\nFWPULL_PI_IP2 0\nFWPULL_PI_IP3 49\nFWPULL_PORT 8070\n");
    fs.writeFileSync(envFile, "COMPANION_IP=224.0.0.1\nFIRMWARE_SERVER_PORT=8070\n");
    const rejected = runPython(["render-fc-params", envFile, params]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("unicast IPv4");
  });
});

describe("companion service consumers", () => {
  it("loads shared configuration before runtime defaults and supports go2rtc API override", () => {
    for (const filename of [
      "raspberry_pi_client.py",
      "telemetry_forwarder.py",
      "logs_ota_service.py",
      "siyi_camera_controller.py",
      "camera_stream_service.py",
    ]) {
      const source = fs.readFileSync(path.join(helperDir, filename), "utf8");
      expect(source).toContain("load_environment");
    }
    const cameraStream = fs.readFileSync(path.join(helperDir, "camera_stream_service.py"), "utf8");
    expect(cameraStream).toContain("--go2rtc-api");
    expect(cameraStream).toContain("GO2RTC_API_URL");
    const forwarder = fs.readFileSync(path.join(helperDir, "telemetry_forwarder.py"), "utf8");
    expect(forwarder).toContain("ENABLE_UAVCAN");
    expect(forwarder).toContain("[UAVCAN] Disabled by ENABLE_UAVCAN");
  });
});

function cameraRuntime(settings: string, args: string[]) {
  const directory = temporaryDirectory();
  const envFile = path.join(directory, "companion.env");
  fs.writeFileSync(envFile, settings);
  const script = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(helperDir)})
import camera_stream_service as camera
class Capture(camera.WebRTCStreamingService):
    async def run(self):
        print(json.dumps({'rtsp':self.rtsp_url, 'api':self.go2rtc_api, 'stream':self.stream_type, 'skip':self.skip_funnel_setup}))
camera.WebRTCStreamingService = Capture
sys.argv = ['camera', *json.loads(${JSON.stringify(JSON.stringify(args))})]
asyncio.run(camera.main())
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", QUIVER_ENV_FILE: envFile }, timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { rtsp: string; api: string; stream: string; skip: boolean };
}

describe("camera runtime configuration behavior", () => {
  it("an explicit API port and stream selection override derived endpoints", () => {
    const result = cameraRuntime("SIYI_CAMERA_IP=10.50.0.25\nGO2RTC_API_PORT=1984\n", ["--api-port", "2999", "--stream", "main"]);
    expect(result.api).toBe("http://localhost:2999");
    expect(result.rtsp).toBe("rtsp://10.50.0.25:8554/main.264");
  });
  it("explicit whole-URL CLI settings override file settings", () => {
    const result = cameraRuntime("RTSP_URL=rtsp://configured.invalid/source\nGO2RTC_API_URL=http://configured.invalid:1984\n", ["--api-port", "2999", "--go2rtc-api", "http://override.invalid:4000", "--rtsp-url", "rtsp://override.invalid/source"]);
    expect(result.api).toBe("http://override.invalid:4000");
    expect(result.rtsp).toBe("rtsp://override.invalid/source");
  });
  it("an explicit file RTSP override remains intentional and managed Funnel setup is skipped", () => {
    const result = cameraRuntime("RTSP_URL=rtsp://custom.invalid/stream\nSKIP_FUNNEL_SETUP=true\n", ["--stream", "main"]);
    expect(result.rtsp).toBe("rtsp://custom.invalid/stream");
    expect(result.skip).toBe(true);
  });
  it("external go2rtc monitoring never spawns or stops another server process", () => {
    const result = spawnSync("python3", ["-c", `
import json, sys, types
sys.path.insert(0, ${JSON.stringify(helperDir)})
import camera_stream_service as camera
camera.GO2RTC_EXTERNAL = True
def forbidden(*args, **kwargs): raise AssertionError('must not create another listener')
camera.subprocess.Popen = forbidden
camera.requests = types.SimpleNamespace(get=lambda *a, **kw: types.SimpleNamespace(status_code=200, json=lambda:{'camera':{'producers':[{}]}}))
service = camera.WebRTCStreamingService()
assert service._start_go2rtc()
assert service._check_stream_health()
service._stop_go2rtc()
assert service.go2rtc_process is None
print('external monitoring OK')
`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("external monitoring OK");
  });
});
