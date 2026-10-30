import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const script = resolve("companion_scripts/diagnose_companion.sh");
describe("Read-only companion diagnostics", () => {
  it("reports installed version/directives but never reads or prints credentials or mutates services", () => {
    const root = mkdtempSync(join(tmpdir(), "quiver-doctor-"));
    try {
      const units = join(root, "units"), bin = join(root, "bin");
      mkdirSync(units); mkdirSync(bin);
      const config = "API_KEY=never-print-this\nPRIVATE_SETTING=never-print-that\n";
      writeFileSync(join(root, ".env"), config, { mode: 0o600 });
      const source = "#!/bin/bash\n# source fixture\n";
      writeFileSync(join(root, "installer_common.sh"), source);
      writeFileSync(join(root, "companion-suite.manifest.json"), JSON.stringify({ source_commit: "a".repeat(40), files: { "installer_common.sh": createHash("sha256").update(source).digest("hex") } }));
      const unit = `[Service]\nWorkingDirectory="${root}"\nEnvironmentFile="${root}/.env"\nExecStart=/usr/bin/true\n`;
      writeFileSync(join(units, "quiver-hub-client.service"), unit);
      const log = join(root, "calls.log");
      for (const [name, content] of Object.entries({
        "systemd-analyze": '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "$1" = --version ]; then echo "systemd 257"; else echo "failed --api-key hidden-secret API_KEY=another-secret https://user:secret@hub.invalid" >&2; exit 1; fi\n',
        "systemctl": '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\necho "LoadState=bad-setting"\n',
      })) {
        writeFileSync(join(bin, name), content); chmodSync(join(bin, name), 0o755);
      }
      const result = spawnSync("bash", [script, "--install-dir", root], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, QUIVER_SYSTEMD_DIR: units, CALL_LOG: log } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Installed source commit: " + "a".repeat(40));
      expect(result.stdout).toContain("MATCH");
      expect(result.stdout).toContain('WorkingDirectory="');
      expect(result.stdout).toContain("Unit verification exit: 1");
      for (const secret of ["never-print-this", "never-print-that", "hidden-secret", "another-secret", "user:secret"]) expect(result.stdout).not.toContain(secret);
      expect(result.stdout).toContain("[REDACTED]");
      expect(readFileSync(join(root, ".env"), "utf8")).toBe(config);
      expect(readFileSync(join(units, "quiver-hub-client.service"), "utf8")).toBe(unit);
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain("--recursive-errors=no");
      expect(calls).toContain("show --no-pager");
      expect(calls).not.toMatch(/start|restart|enable|daemon-reload/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects a nonexistent or relative install path rather than guessing", () => {
    const result = spawnSync("bash", [script, "--install-dir", "relative-folder"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing absolute companion installation directory");
  });
});
