import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSuiteManifest, registerCompanionSuiteRoutes, resolveSuiteFile } from "./companionSuite";
import { buildCompanionInstallCommand, hubAddressWarning, shellQuote } from "../client/src/lib/companionEnvironment";

const suite = resolve("companion_scripts");
const bootstrap = join(suite, "bootstrap_companion.sh");

// Async so the in-process Hub (same event loop) can answer the script's requests.
function bash(args: string[], options: { env?: Record<string, string> } = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveRun => {
    const child = spawn("bash", [bootstrap, ...args], { env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", status => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
  });
}

// ─── Hub-side suite routes ─────────────────────────────────────────────────

describe("Hub-served companion suite", () => {
  it("hashes every servable suite file and never the local secrets", () => {
    const manifest = buildSuiteManifest(suite);
    expect(manifest.files["bootstrap_companion.sh"].sha256).toBe(
      createHash("sha256").update(readFileSync(bootstrap)).digest("hex"),
    );
    for (const required of ["installer_common.sh", "companion_config.py", "raspberry_pi_client.py", "quiver-hub-client.service", "requirements-companion.txt"]) {
      expect(manifest.files[required], required).toBeDefined();
    }
    for (const secret of [".env", "forwarder.env", "go2rtc.yaml", "firmware_puller.param", "companion-suite.manifest.json"]) {
      expect(manifest.files[secret], secret).toBeUndefined();
    }
    expect(Object.keys(manifest.files).some(name => name.includes("__pycache__") || name.endsWith(".pyc"))).toBe(false);
  });

  it("resolves only files inside the suite and refuses traversal/secrets", () => {
    expect(resolveSuiteFile(suite, "bootstrap_companion.sh")).toBe(bootstrap);
    expect(resolveSuiteFile(suite, "../package.json")).toBeNull();
    expect(resolveSuiteFile(suite, "..%2Fpackage.json")).toBeNull();
    expect(resolveSuiteFile(suite, ".env")).toBeNull();
    expect(resolveSuiteFile(suite, "forwarder.env")).toBeNull();
    expect(resolveSuiteFile(suite, "does-not-exist.sh")).toBeNull();
  });
});

// ─── Bootstrap against a live in-process Hub ───────────────────────────────

describe("bootstrap_companion.sh", () => {
  let server: Server;
  let hub = "";
  let tampered = false;
  const temporary: string[] = [];

  beforeAll(async () => {
    const app = express();
    app.get("/api/rest/health", (_req, res) => res.json({ success: true, status: "healthy" }));
    app.use((req, res, next) => {
      // Simulate a corrupted/tampered download of one file when requested.
      if (tampered && req.path === "/companion/files/raspberry_pi_client.py") {
        res.type("text/x-python").send("print('not the real client')\n");
        return;
      }
      next();
    });
    registerCompanionSuiteRoutes(app);
    await new Promise<void>(resolveListen => {
      server = app.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    hub = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>(done => server.close(() => done()));
    temporary.forEach(path => rmSync(path, { recursive: true, force: true }));
  });

  it("has valid syntax and prints usage", async () => {
    expect(spawnSync("bash", ["-n", bootstrap], { encoding: "utf8" }).status).toBe(0);
    const help = await bash(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--hub-url URL");
    expect(help.stdout).toContain("never configures network interfaces");
  });

  it("rejects missing identity and unknown services before touching anything", async () => {
    const noHub = await bash(["--dry-run", "--drone-id", "quiver_001"]);
    expect(noHub.status).toBe(2);
    expect(noHub.stderr).toContain("--hub-url is required");
    const noDrone = await bash(["--dry-run", "--hub-url", "http://192.168.144.200:3000"]);
    expect(noDrone.status).toBe(2);
    expect(noDrone.stderr).toContain("--drone-id is required");
    const badService = await bash(["--dry-run", "--hub-url", "http://192.168.144.200:3000", "--drone-id", "d", "--services", "hub,lidar"]);
    expect(badService.status).toBe(2);
    expect(badService.stderr).toContain("Unknown service 'lidar'");
  });

  it("allows plain HTTP only to a private-network Hub address", async () => {
    const publicIp = await bash(["--dry-run", "--hub-url", "http://8.8.8.8:3000", "--drone-id", "d"]);
    expect(publicIp.status).toBe(1);
    expect(publicIp.stderr).toContain("Plain HTTP to a public host");
    const publicName = await bash(["--dry-run", "--hub-url", "http://hub.example", "--drone-id", "d"]);
    expect(publicName.status).toBe(1);
    expect(publicName.stderr).toContain("Plain HTTP to a public host");
    const ftp = await bash(["--dry-run", "--hub-url", "ftp://192.168.144.200", "--drone-id", "d"]);
    expect(ftp.status).toBe(2);
  });

  it("refuses to continue when the Hub is unreachable and the suite comes from the Hub", async () => {
    const result = await bash(["--dry-run", "--hub-url", "http://127.0.0.1:9", "--drone-id", "d"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Hub http:\/\/127\.0\.0\.1:9 is unreachable/);
  });

  it("fetches and verifies the complete suite from the Hub in --dry-run without installing", async () => {
    tampered = false;
    const result = await bash(["--dry-run", "--hub-url", hub, "--drone-id", "quiver_001"], {
      env: { QUIVER_NONINTERACTIVE: "1" },
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("plain HTTP to a private-network/tailnet address: ALLOW_INSECURE_HUB=true will be set");
    expect(result.stdout).toContain("Hub health:    reachable.");
    expect(result.stdout).toMatch(/Fetched and verified \d+ files from http:\/\/127\.0\.0\.1:\d+\/companion/);
    expect(result.stdout).toContain("== Plan ==");
    expect(result.stdout).toContain("install_hub_client.sh --local");
    expect(result.stdout).toContain("install_telemetry_forwarder.sh");
    expect(result.stdout).toContain("install_logs_ota.sh");
    expect(result.stdout).not.toContain("install_camera_services.sh");
    expect(result.stdout).toContain("--dry-run: suite verified, nothing changed");
    // Preflight is read-only: no apt/systemctl/pip side effects are mentioned as done.
    expect(result.stdout).not.toMatch(/Installed the complete companion suite/);
  });

  it("aborts on a SHA-256 mismatch with nothing installed", async () => {
    tampered = true;
    try {
      const result = await bash(["--dry-run", "--hub-url", hub, "--drone-id", "quiver_001"], {
        env: { QUIVER_NONINTERACTIVE: "1" },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SHA-256 mismatch for raspberry_pi_client.py");
      expect(result.stderr).toContain("nothing was installed");
    } finally {
      tampered = false;
    }
  });

  it("reuses an existing .env on a non-virgin Pi and only overrides passed keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "quiver-bootstrap-"));
    temporary.push(root);
    const install = join(root, "quiver");
    spawnSync("mkdir", ["-p", install]);
    writeFileSync(join(install, ".env"), `HUB_URL=${hub}\nWEB_SERVER_URL=${hub}\nDRONE_ID=existing_drone\nAPI_KEY="keep me"\nCOMPANION_IP=192.168.144.49\n`);
    const result = await bash(["--dry-run", "--install-dir", install, "--services", "telemetry,camera"], {
      env: { QUIVER_NONINTERACTIVE: "1" },
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("Existing companion configuration found");
    expect(result.stdout).toContain("drone: existing_drone");
    expect(result.stdout).toContain("(existing installation)");
    expect(result.stdout).toContain("The Hub client suite is always installed first; services: hub,telemetry,camera");
    expect(result.stdout).toContain("install_camera_services.sh");
    expect(result.stdout).not.toContain("keep me");
    const pull = await bash(["--dry-run", "--install-dir", install, "--services", "hublink", "--no-start"], {
      env: { QUIVER_NONINTERACTIVE: "1" },
    });
    expect(pull.status, pull.stderr + pull.stdout).toBe(0);
    expect(pull.stdout).toContain("install_hublink.sh");
    expect(pull.stdout).toContain("--no-start: quiver-hub-client will not be enabled/started");
    // Dry run must not modify the existing configuration.
    expect(readFileSync(join(install, ".env"), "utf8")).toContain('API_KEY="keep me"');
  });
});

// ─── Non-interactive installer helpers ─────────────────────────────────────

describe("installer_common.sh non-interactive mode", () => {
  function run(script: string, env: Record<string, string> = {}, input = "") {
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      timeout: 15000,
      input,
      env: { ...process.env, ...env, SCRIPT_DIR: suite },
    });
  }
  const prelude = `set -euo pipefail; source "$SCRIPT_DIR/installer_common.sh";`;

  it("takes defaults for reads and confirmations without consuming stdin", () => {
    const result = run(`${prelude} quiver_read ANSWER "Serial device" /dev/ttyAMA1; echo "answer=$ANSWER"; quiver_confirm "Proceed with installation?" Y && echo yes-default; quiver_confirm "Remove?" N || echo no-default; cat`, { QUIVER_NONINTERACTIVE: "1" }, "SHOULD-NOT-BE-READ-AS-ANSWER\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("answer=/dev/ttyAMA1");
    expect(result.stdout).toContain("yes-default");
    expect(result.stdout).toContain("no-default");
    // The piped stream was left for the final `cat`, i.e. not eaten by prompts.
    expect(result.stdout).toContain("SHOULD-NOT-BE-READ-AS-ANSWER");
  });

  it("is non-interactive automatically when stdin is not a terminal", () => {
    const result = run(`${prelude} quiver_interactive && echo interactive || echo piped`);
    expect(result.stdout.trim()).toBe("piped");
  });

  it("keeps configured values for prompts and never echoes secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "quiver-prompt-"));
    try {
      const envFile = join(root, ".env");
      writeFileSync(envFile, "WEB_SERVER_URL=https://hub.invalid\nAPI_KEY=super-secret\n");
      const result = run(
        `${prelude} quiver_privileged() { "$@"; }; ENV_FILE="$1"; SERVICE_USER=$(id -un); SERVICE_GROUP=$(id -gn); quiver_prompt WEB_SERVER_URL "Quiver Hub URL"; quiver_prompt API_KEY "API key" secret; echo "url=$(quiver_get WEB_SERVER_URL)"`,
        { QUIVER_NONINTERACTIVE: "1" },
      );
      // bash -c script args: pass the env file as $1
      const direct = spawnSync("bash", ["-c", `${prelude} quiver_privileged() { "$@"; }; ENV_FILE="$1"; SERVICE_USER=$(id -un); SERVICE_GROUP=$(id -gn); quiver_prompt WEB_SERVER_URL "Quiver Hub URL"; quiver_prompt API_KEY "API key" secret; echo "url=$(quiver_get WEB_SERVER_URL)"`, "x", envFile], {
        encoding: "utf8", timeout: 15000, env: { ...process.env, QUIVER_NONINTERACTIVE: "1", SCRIPT_DIR: suite },
      });
      expect(direct.status, direct.stderr + result.stderr).toBe(0);
      expect(direct.stdout).toContain("Quiver Hub URL [https://hub.invalid]: (non-interactive, keeping configured value)");
      expect(direct.stdout).toContain("API key: (non-interactive, keeping configured value)");
      expect(direct.stdout).not.toContain("super-secret");
      expect(direct.stdout).toContain("url=https://hub.invalid");
      expect(readFileSync(envFile, "utf8")).toMatch(/API_KEY="?super-secret"?/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Drone Configuration command builder ───────────────────────────────────

describe("Drone Configuration install command", () => {
  it("builds the curl | sudo bash one-liner with quoted arguments", () => {
    const command = buildCompanionInstallCommand({ hubUrl: "http://192.168.144.200:3000/", droneId: "quiver_001", apiKey: "k3y with space'q" });
    expect(command.startsWith("curl -fsSL http://192.168.144.200:3000/companion/install.sh | sudo bash -s --")).toBe(true);
    expect(command).toContain("--hub-url http://192.168.144.200:3000");
    expect(command).toContain("--drone-id quiver_001");
    expect(command).toContain(`--api-key 'k3y with space'\\''q'`);
    expect(command).not.toContain("3000//");
  });
  it("prompts for the key on the Pi when it is not embedded", () => {
    const command = buildCompanionInstallCommand({ hubUrl: "http://192.168.144.200:3000", droneId: "quiver_001" });
    expect(command).toContain("--api-key-prompt");
    expect(command).not.toContain("--api-key ");
  });
  it("quotes only what the shell needs", () => {
    expect(shellQuote("plain-value_1.0:3000/path")).toBe("plain-value_1.0:3000/path");
    expect(shellQuote("has space")).toBe("'has space'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
  it("warns when the browser address is not reachable from the Pi", () => {
    expect(hubAddressWarning("http://localhost:3000")).toMatch(/cannot reach it/);
    expect(hubAddressWarning("http://127.0.0.1:3000")).toMatch(/cannot reach it/);
    expect(hubAddressWarning("http://0.0.0.0:3000")).toMatch(/bind address/);
    expect(hubAddressWarning("not a url")).toMatch(/full address/);
    expect(hubAddressWarning("http://192.168.144.200:3000")).toBeNull();
    expect(hubAddressWarning("https://hub-laptop.tailnet.ts.net")).toBeNull();
  });
});
