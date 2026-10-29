import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const suite = resolve("companion_scripts");
const temporary: string[] = [];

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "quiver-camera-install-"));
  temporary.push(path);
  return path;
}

afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function executable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function verifyCameraUnits(root: string, units: string, names: string[]) {
  // Isolate systemd's lookup from host /etc units. The local stub supplies the
  // funnel service's explicit tailscaled.service dependency without starting it.
  const verifierUnits = join(root, "verifier-units");
  mkdirSync(verifierUnits);
  writeFileSync(join(verifierUnits, "tailscaled.service"), `[Unit]
Description=Test-only tailscaled dependency stub
[Service]
Type=oneshot
ExecStart=/usr/bin/true
`);
  const unitPath = [units, verifierUnits, "/usr/lib/systemd/system", "/lib/systemd/system"].join(":");
  const result = spawnSync(
    "systemd-analyze",
    ["verify", ...names.map(name => join(units, name))],
    {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, SYSTEMD_UNIT_PATH: unitPath },
    },
  );
  expect(result.status, result.stderr + result.stdout).toBe(0);
}

function runMockedCameraInstallation() {
  const root = temp();
  const bin = join(root, "bin");
  const install = join(root, "my camera companion");
  const envFile = join(install, ".env");
  const units = join(root, "units");
  const log = join(root, "commands.log");
  mkdirSync(bin);
  mkdirSync(install);
  writeFileSync(envFile, [
    "# This comment must survive the installer.",
    "HUB_URL=\"https://hub.invalid\"",
    "API_KEY=\"test-secret\"",
    "DRONE_ID=\"camera-demo\"",
    `INSTALL_DIR=\"${install}\"`,
    "SERVICE_USER=\"ubuntu\"",
    "SIYI_CAMERA_IP=\"10.42.0.25\"",
    "SIYI_RTSP_PORT=\"9554\"",
    "STREAM_TYPE=\"sub\"",
    "GO2RTC_API_HOST=\"127.0.0.1\"",
    "GO2RTC_API_PORT=\"2984\"",
    "GO2RTC_WEBRTC_PORT=\"9555\"",
    "TAILSCALE_FUNNEL_PORT=\"8443\"",
    "UNRELATED=\"preserve-me\"",
    "",
  ].join("\n"));

  for (const command of ["apt-get", "systemctl"]) {
    executable(join(bin, command), `#!/usr/bin/env bash
printf '%s %s\\n' '${command}' "$*" >> "$MOCK_LOG"
exit 0
`);
  }
  executable(join(bin, "python3"), `#!/usr/bin/env bash
if [ "$1" = -m ] && [ "$2" = pip ]; then
  printf 'pip %s\\n' "$*" >> "$MOCK_LOG"
  exit 0
fi
exec /usr/bin/python3 "$@"
`);
  executable(join(bin, "curl"), `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$MOCK_LOG"
if [[ "$*" == *"api.github.com/repos/AlexxIT/go2rtc/releases/latest"* ]]; then
  printf '%s\\n' '{"assets":[{"name":"go2rtc_linux_amd64","browser_download_url":"https://downloads.invalid/go2rtc-amd64"},{"name":"go2rtc_linux_arm64","browser_download_url":"https://downloads.invalid/go2rtc-arm64"},{"name":"go2rtc_linux_arm","browser_download_url":"https://downloads.invalid/go2rtc-arm"}]}'
  exit 0
fi
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output="$2"; shift 2; continue; fi
  shift
done
[ -n "$output" ] && printf '#!/bin/sh\\nexit 0\\n' > "$output"
`);
  executable(join(bin, "tailscale"), `#!/usr/bin/env bash
printf 'tailscale %s\\n' "$*" >> "$MOCK_LOG"
case "$1 $2" in
  'status --json') printf '%s\\n' '{"Self":{"DNSName":"camera.test.ts.net."}}' ;;
  *) : ;;
esac
exit 0
`);

  // The actual common installer, literal config parser, copying and renderer run.
  // Package management, downloads, Tailscale and service-manager calls are stubs.
  // QUIVER_TEST_MODE only bypasses the installer root guard. `sudo` is mocked
  // to execute the otherwise-privileged temporary-directory operations as this
  // test user; no package manager or systemd command reaches the host.
  executable(join(bin, "sudo"), `#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do shift; done
exec "$@"
`);
  const result = spawnSync(
    "env",
    [
      `PATH=${bin}:/usr/bin:/bin`,
      `QUIVER_ENV_FILE=${envFile}`,
      `QUIVER_SYSTEMD_DIR=${units}`,
      `MOCK_LOG=${log}`,
      "QUIVER_TEST_MODE=1",
      "bash", join(suite, "install_camera_services.sh"),
    ],
    { input: "\n".repeat(9), encoding: "utf8", timeout: 30000 },
  );
  return { result, root, install, envFile, units, log };
}

describe("Camera services installer (mocked privileged integration)", () => {
  it("renders portable shared-environment units and regenerates go2rtc config without touching real services", () => {
    const run = runMockedCameraInstallation();
    expect(run.result.status, run.result.stderr + run.result.stdout).toBe(0);

    for (const name of ["go2rtc.service", "tailscale-funnel.service", "camera-stream.service", "siyi-camera.service"]) {
      expect(existsSync(join(run.units, name)), name).toBe(true);
    }
    expect(existsSync(join(run.install, "companion_config.py"))).toBe(true);
    expect(existsSync(join(run.install, "go2rtc.yaml"))).toBe(true);

    const go2rtc = readFileSync(join(run.units, "go2rtc.service"), "utf8");
    const funnel = readFileSync(join(run.units, "tailscale-funnel.service"), "utf8");
    const camera = readFileSync(join(run.units, "camera-stream.service"), "utf8");
    const siyi = readFileSync(join(run.units, "siyi-camera.service"), "utf8");
    const yaml = readFileSync(join(run.install, "go2rtc.yaml"), "utf8");
    const env = readFileSync(run.envFile, "utf8");
    const log = readFileSync(run.log, "utf8");

    expect(go2rtc).toContain(`WorkingDirectory=${run.install}`);
    expect(go2rtc).not.toContain(`WorkingDirectory="${run.install}"`);
    expect(go2rtc).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(go2rtc).toContain(`Environment="QUIVER_ENV_FILE=${run.envFile}"`);
    expect(go2rtc).toContain("render-go2rtc");
    expect(go2rtc).toContain(`"${join(run.install, "companion_config.py")}"`);
    expect(go2rtc).toContain(`ExecStart="${join(run.install, "bin/go2rtc")}" -config "${join(run.install, "go2rtc.yaml")}"`);
    expect(funnel).toContain("--https=${TAILSCALE_FUNNEL_PORT}");
    expect(funnel).toContain("http://${GO2RTC_API_HOST}:${GO2RTC_API_PORT}");
    expect(funnel).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(camera).toContain(`WorkingDirectory=${run.install}`);
    expect(camera).not.toContain(`WorkingDirectory="${run.install}"`);
    expect(camera).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(camera).toContain(`ExecStart=/usr/bin/python3 "${join(run.install, "camera_stream_service.py")}"`);
    expect(siyi).toContain(`WorkingDirectory=${run.install}`);
    expect(siyi).not.toContain(`WorkingDirectory="${run.install}"`);
    expect(siyi).toContain(`EnvironmentFile="${run.envFile}"`);
    expect(siyi).toContain(`ExecStart=/usr/bin/python3 "${join(run.install, "siyi_camera_controller.py")}"`);
    expect(camera).not.toContain("test-secret");
    expect(siyi).not.toContain("test-secret");
    expect(camera).not.toContain("10.42.0.25");
    expect(siyi).not.toContain("10.42.0.25");
    expect(yaml).toContain('camera: "rtsp://10.42.0.25:9554/sub.264"');
    expect(yaml).toContain('listen: "127.0.0.1:2984"');
    expect(env).toContain("UNRELATED=\"preserve-me\"");
    expect(env).toContain("# This comment must survive the installer.");
    expect(env).not.toMatch(/^RTSP_URL=/m);
    expect(log).toContain("--break-system-packages");
    expect(log).toContain("systemctl daemon-reload");
    expect(log).not.toContain("/etc/systemd/system");
    verifyCameraUnits(run.root, run.units, ["go2rtc.service", "tailscale-funnel.service", "camera-stream.service", "siyi-camera.service"]);

    // No derived RTSP_URL is frozen into .env. Re-rendering after a camera
    // endpoint edit must therefore use the new derived source immediately.
    writeFileSync(run.envFile, env.replace("SIYI_CAMERA_IP=\"10.42.0.25\"", "SIYI_CAMERA_IP=\"10.42.0.26\""));
    const rerender = spawnSync(
      "python3",
      [join(run.install, "companion_config.py"), "render-go2rtc", run.envFile, join(run.install, "go2rtc.yaml")],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(rerender.status, rerender.stderr).toBe(0);
    expect(readFileSync(join(run.install, "go2rtc.yaml"), "utf8"))
      .toContain('camera: "rtsp://10.42.0.26:9554/sub.264"');
  });

  it("contains no direct real systemd write path and has valid shell syntax", () => {
    const script = readFileSync(join(suite, "install_camera_services.sh"), "utf8");
    expect(script).toContain("SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}");
    expect(script).not.toMatch(/tee\s+\/etc\/systemd\/system/);
    const syntax = spawnSync("bash", ["-n", join(suite, "install_camera_services.sh")], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
