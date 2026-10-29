import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const suite = resolve("companion_scripts");
const temporary: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(), "quiver-install-")); temporary.push(path); return path; }
afterEach(() => temporary.splice(0).forEach(path => {
  // Mock installers run as root but only write within this test-owned tree.
  spawnSync("sudo", ["-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, path]);
  rmSync(path, { recursive: true, force: true });
}));
function python(code: string, args: string[] = []) {
  return spawnSync("python3", ["-c", code, ...args], { encoding: "utf8", timeout: 15000 });
}

function download(source: string, variant = "normal") {
  const destination = temp();
  const shell = readFileSync(join(suite, "install_hub_client.sh"), "utf8");
  const code = shell.match(/python3 - "\$SOURCE_URL" "\$STAGING_DIR" <<'PY'\n([\s\S]*?)\nPY/)![1];
  const result = python(`
import io, json, pathlib, sys, urllib.request
source, destination, variant, suite, code = sys.argv[1:]
sha = 'c' * 40
files = {p.relative_to(suite).as_posix(): p.read_bytes() for p in pathlib.Path(suite).rglob('*') if p.is_file() and '__pycache__' not in p.parts}
files.update({'nested/extra.md': b'nested documentation', '.env': b'API_KEY=remote-secret', 'forwarder.env': b'API_KEY=remote-secret'})
if variant == 'missing': files.pop('companion_config.py', None)
if variant == 'traversal': files['../../outside'] = b'bad'
if variant == 'symlink': files['shortcut.py'] = b'bad'
requests = []
def opened(request, timeout=0):
    address = request.full_url
    requests.append(address)
    if variant == 'network-error': raise OSError('network unavailable')
    if '/commits/' in address: return io.BytesIO(json.dumps({'sha':sha}).encode())
    if '/git/trees/' in address:
        return io.BytesIO(json.dumps({'truncated':variant == 'truncated', 'tree':[{'path':'companion_scripts/' + name, 'type':'blob', 'mode':'120000' if name == 'shortcut.py' else '100644'} for name in files]}).encode())
    marker = '/' + sha + '/companion_scripts/'
    if marker not in address: raise RuntimeError('download was not pinned to commit')
    from urllib.parse import unquote
    return io.BytesIO(files[unquote(address.split(marker, 1)[1])])
urllib.request.urlopen = opened
sys.argv = ['bootstrap', source, destination]
exec(compile(code, 'bootstrap', 'exec'))
print(json.dumps(requests))
`, [source, destination, variant, suite, code]);
  return { result, destination };
}

describe("Companion bootstrap downloads", () => {
  const source = "https://github.com/Pan-Robotics/Arrow-Quiver-Hub/tree/main/companion_scripts";
  it("uses blank-to-default source prompt", () => {
    const text = readFileSync(join(suite, "install_hub_client.sh"), "utf8");
    expect(text).toContain(`DEFAULT_SOURCE="${source}"`);
    expect(text).toContain("SOURCE_URL=${SOURCE_URL:-$DEFAULT_SOURCE}");
  });
  it("downloads all file types and nested files from a single pinned commit", () => {
    const { result, destination } = download(source);
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["install_logs_ota.sh", "logs_ota_service.py", "firmware_puller.lua", "COMPANION_SERVICES.md", "logs-ota.service", "companion-config.example", "nested/extra.md"]) {
      expect(existsSync(join(destination, name)), name).toBe(true);
    }
    expect(result.stdout).toContain("cccccccccccc");
    expect(existsSync(join(destination, ".env"))).toBe(false);
    expect(existsSync(join(destination, "forwarder.env"))).toBe(false);
  });
  it("accepts another repository and branch", () => {
    const { result } = download("https://github.com/Other-Team/Other-Hub/tree/testing/companion_scripts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("repos/Other-Team/Other-Hub/commits/testing");
  });
  it("accepts raw GitHub folder URLs", () => {
    expect(download("https://raw.githubusercontent.com/Other-Team/Other-Hub/main/companion_scripts").result.status).toBe(0);
  });
  it.each(["https://evil.example/team/repo/tree/main/companion_scripts", "http://github.com/team/repo/tree/main/companion_scripts", source + "?bad=true"])("rejects unsupported source %s", bad => {
    const { result } = download(bad);
    expect(result.status).not.toBe(0);
  });
  it.each(["missing", "traversal", "symlink", "truncated", "network-error"])("fails safely for %s before installation begins", variant => {
    const { result } = download(source, variant);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installed suite was not changed");
  });
});

function mockInstallation(script: string, choices: string, options: { local?: boolean; pipExit?: number } = {}) {
  const root = temp(), bin = join(root, "bin"), install = join(root, "my companion"), envFile = join(install, ".env"), units = join(root, "units"), log = join(root, "commands.log");
  mkdirSync(bin); mkdirSync(install);
  writeFileSync(envFile, `# retained comment\nWEB_SERVER_URL=https://hub.invalid\nAPI_KEY=test-secret\nDRONE_ID=demo-drone\nINSTALL_DIR="${install}"\nSERVICE_USER=ubuntu\nFC_IP=10.42.0.51\nCOMPANION_IP=10.42.0.49\nLOG_STORE_DIR="${root}/fc logs"\nUNRELATED=preserve-me\n`);
  for (const command of ["apt-get", "systemctl", "usermod"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!/bin/bash\nprintf '%s %s\\n' '${command}' "$*" >> "$MOCK_LOG"\nexit 0\n`); chmodSync(path, 0o755);
  }
  const dispatcher = join(bin, "python3");
  writeFileSync(dispatcher, `#!/bin/bash\nif [ "$1" = -m ] && [ "$2" = pip ]; then\n  printf 'pip %s\\n' "$*" >> "$MOCK_LOG"\n  exit "\${MOCK_PIP_EXIT:-0}"\nfi\nexec /usr/bin/python3 "$@"\n`); chmodSync(dispatcher, 0o755);
  // Only package/service commands are stubbed; real Python/.env/filesystem behavior
  // is exercised. All generated units and service-write paths are temporary.
  const result = spawnSync("sudo", ["-n", "env", `PATH=${bin}:/usr/bin:/bin`, `QUIVER_ENV_FILE=${envFile}`, `QUIVER_SYSTEMD_DIR=${units}`, `MOCK_LOG=${log}`, `MOCK_PIP_EXIT=${options.pipExit ?? 0}`, "bash", join(suite, script), ...(options.local ? ["--local"] : [])], { input: choices, encoding: "utf8", timeout: 30000 });
  return { result, install, envFile, units, log };
}

describe("Portable installer integration (mocked privileged operations)", () => {
  it("bootstraps the complete delivered local suite and generates FC parameters without starting hardware services", () => {
    const run = mockInstallation("install_hub_client.sh", "\n".repeat(30), { local: true });
    expect(run.result.status, run.result.stderr + run.result.stdout).toBe(0);
    for (const file of ["install_camera_services.sh", "logs_ota_service.py", "firmware_puller.lua", "companion-config.example", "COMPANION_SERVICES.md", "firmware_puller.param"]) {
      expect(existsSync(join(run.install, file)), file).toBe(true);
    }
    const params = readFileSync(join(run.install, "firmware_puller.param"), "utf8");
    expect(params).toContain("FWPULL_PI_IP0 10");
    expect(params).toContain("FWPULL_PI_IP3 49");
    expect(params).not.toContain("FWPULL_ENABLE");
    const unit = readFileSync(join(run.units, "quiver-hub-client.service"), "utf8");
    expect(unit).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(unit).not.toContain("test-secret");
    expect(readFileSync(run.log, "utf8")).not.toMatch(/systemctl (start|restart|enable)/);
  });
  it("stops on a dependency failure before creating or enabling the OTA unit", () => {
    const run = mockInstallation("install_logs_ota.sh", "\n".repeat(30), { pipExit: 7 });
    expect(run.result.status).toBe(7);
    expect(existsSync(join(run.units, "logs-ota.service"))).toBe(false);
    expect(readFileSync(run.log, "utf8")).not.toContain("systemctl");
  });
  it("installs telemetry in a space-containing folder and preserves configuration", () => {
    const run = mockInstallation("install_telemetry_forwarder.sh", "\n".repeat(30));
    expect(run.result.status, run.result.stderr + run.result.stdout).toBe(0);
    const unit = readFileSync(join(run.units, "telemetry-forwarder.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory="${run.install}"`);
    expect(unit).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(unit).not.toContain("test-secret");
    expect(unit).not.toContain("Environment=MAVLINK_URL");
    const env = readFileSync(run.envFile, "utf8");
    expect(env).toContain("retained comment");
    expect(env).toContain("UNRELATED=preserve-me");
    expect(env).toContain("FC_IP=10.42.0.51");
    expect(readFileSync(run.log, "utf8")).toContain("--break-system-packages");
    expect(existsSync(join(run.install, "companion_config.py"))).toBe(true);
  });
  it("installs OTA using .env without embedding network addresses or API keys into the unit", () => {
    const run = mockInstallation("install_logs_ota.sh", "\n".repeat(30));
    expect(run.result.status, run.result.stderr + run.result.stdout).toBe(0);
    const unit = readFileSync(join(run.units, "logs-ota.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory="${run.install}"`);
    expect(unit).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(unit).not.toContain("--api-key");
    expect(unit).not.toContain("10.42.0.51");
    expect(existsSync(join(run.install, "firmware_puller.lua"))).toBe(true);
  });
  it("supports rerunning a secondary installer directly from its installed directory", () => {
    const run = mockInstallation("install_telemetry_forwarder.sh", "\n".repeat(30));
    expect(run.result.status, run.result.stderr).toBe(0);
    const result = spawnSync("bash", ["-c", `set -euo pipefail; SCRIPT_DIR="$1"; INSTALL_DIR="$1"; SERVICE_USER=ubuntu; SERVICE_GROUP=ubuntu; source "$1/installer_common.sh"; quiver_copy telemetry_forwarder.py; quiver_install_helpers`, "test", run.install], { encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
  });
  it("has valid Bash syntax for every installer", () => {
    for (const name of readdirSync(suite).filter(name => name.endsWith(".sh"))) {
      const result = spawnSync("bash", ["-n", join(suite, name)], { encoding: "utf8" });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
  it("every Python installation includes the Raspberry Pi override", () => {
    for (const name of readdirSync(suite).filter(name => name.endsWith(".sh"))) {
      const text = readFileSync(join(suite, name), "utf8");
      for (const match of text.matchAll(/(?:pip3?\s+install|python3\s+-m\s+pip\s+install)([^\n]*)/g)) {
        expect(match[1], name).toContain("--break-system-packages");
      }
    }
  });
  it("no companion executable or service template uses developer-specific paths or LAN literals", () => {
    for (const name of readdirSync(suite).filter(name => /\.(sh|py|service)$/.test(name))) {
      const text = readFileSync(join(suite, name), "utf8");
      expect(text, name).not.toMatch(/\/home\/(alexd|julius|pi)\b|User=(alexd|julius|pi)\b/);
      expect(text, name).not.toMatch(/192\.168\.144\./);
    }
  });
});
