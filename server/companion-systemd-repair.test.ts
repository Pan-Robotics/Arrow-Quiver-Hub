import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("companion_scripts/repair_companion_services.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync("sudo", ["-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, root]);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quiver-systemd-repair-"));
  roots.push(root);
  const units = join(root, "units");
  const bin = join(root, "bin");
  const install = join(root, "companion 100% ready");
  mkdirSync(units); mkdirSync(bin); mkdirSync(install);
  const log = join(root, "systemctl.log");
  const config = join(install, ".env");
  writeFileSync(config, "# private config\nAPI_KEY=do-not-change\nFC_IP=10.20.0.51\n");
  writeFileSync(join(bin, "systemctl"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REPAIR_LOG"\n');
  chmodSync(join(bin, "systemctl"), 0o755);
  const unit = join(units, "quiver-hub-client.service");
  const escaped = install.replace(/%/g, "%%");
  const content = `[Unit]\nDescription=Quiver repair fixture\n[Service]\nType=simple\nWorkingDirectory="${escaped}"\nEnvironmentFile="${escaped}/.env"\nExecStart=/usr/bin/python3 -V\nReadWritePaths="${escaped}"\n`;
  writeFileSync(unit, content, { mode: 0o640 });
  function run(args: string[] = []) {
    return spawnSync("sudo", ["-n", "env", `PATH=${bin}:/usr/bin:/bin`, `REPAIR_LOG=${log}`, `QUIVER_SYSTEMD_DIR=${units}`, `SYSTEMD_UNIT_PATH=${units}:/usr/lib/systemd/system:/lib/systemd/system`, "bash", script, ...args], { encoding: "utf8", timeout: 15000 });
  }
  return { root, units, install, log, config, unit, content, escaped, run };
}

describe("Companion installed-unit repair", () => {
  it("checks corrected units through real systemd without writing in --check mode", () => {
    const f = fixture();
    const result = f.run(["--check"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 need repair");
    expect(readFileSync(f.unit, "utf8")).toBe(f.content);
    expect(existsSync(f.unit + ".pre-working-directory-fix")).toBe(false);
    expect(existsSync(f.log)).toBe(false);
  });
  it("removes only directory quotes, keeps percent escapes/word quoting, backs up, and reloads without starting services", () => {
    const f = fixture();
    const config = readFileSync(f.config, "utf8");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const expected = f.content.replace(`WorkingDirectory="${f.escaped}"`, `WorkingDirectory=${f.escaped}`);
    expect(readFileSync(f.unit, "utf8")).toBe(expected);
    expect(readFileSync(f.unit + ".pre-working-directory-fix", "utf8")).toBe(f.content);
    expect(readFileSync(f.config, "utf8")).toBe(config);
    expect(readFileSync(f.log, "utf8")).toBe("daemon-reload\n");
    const again = f.run();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("repaired 0");
    expect(readFileSync(f.unit + ".pre-working-directory-fix", "utf8")).toBe(f.content);
    expect(readFileSync(f.log, "utf8")).toBe("daemon-reload\n");
  });
  it("validates all candidates before replacing any unit if another unit is invalid", () => {
    const f = fixture();
    writeFileSync(join(f.units, "logs-ota.service"), "[Service]\nWorkingDirectory=relative/invalid\nExecStart=/usr/bin/python3 -V\n");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no installed units or configuration files were changed");
    expect(readFileSync(f.unit, "utf8")).toBe(f.content);
    expect(existsSync(f.unit + ".pre-working-directory-fix")).toBe(false);
    expect(existsSync(f.log)).toBe(false);
  });
  it("refuses unrendered source templates instead of pretending they are repaired units", () => {
    const f = fixture();
    writeFileSync(f.unit, "[Service]\nWorkingDirectory=WORKING_DIRECTORY_PLACEHOLDER\nExecStart=/usr/bin/python3 -V\n");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unrendered source template");
    expect(existsSync(f.log)).toBe(false);
  });
  it("the directory formatter passes a literal space/percent-containing path to the real systemd parser", () => {
    const f = fixture();
    const result = spawnSync("bash", ["-c", 'source "$1"; quiver_systemd_directory "$2"', "test", resolve("companion_scripts/installer_common.sh"), f.install], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(f.escaped);
    expect(result.stdout).not.toContain('"');
    for (const invalid of ["relative/path", "/tmp/bad\nInjected=setting"]) {
      const rejected = spawnSync("bash", ["-c", 'source "$1"; quiver_systemd_directory "$2"', "test", resolve("companion_scripts/installer_common.sh"), invalid], { encoding: "utf8" });
      expect(rejected.status).not.toBe(0);
    }
  });
});
