#!/usr/bin/env node
/**
 * Build a distributable Quiver Hub release tarball.
 *
 * Produces release/quiver-hub-<version>.tar.gz containing everything needed to
 * run the Hub from a download — the prebuilt app (dist/), the DB migrations
 * (drizzle/), the launcher scripts, package.json + lockfile, and an INSTALL.md.
 * It deliberately excludes node_modules and source: the recipient runs
 * `pnpm install --prod` once (which compiles the native better-sqlite3 for their
 * platform), then `pnpm app`. So the tarball is platform-agnostic.
 *
 * Run: pnpm package
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const name = `quiver-hub-${pkg.version}`;
const releaseDir = path.join(repoRoot, "release");
const stageDir = path.join(releaseDir, name);
const tarball = path.join(releaseDir, `${name}.tar.gz`);

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

// 1) Build (always, so the artifact is fresh).
console.log("[package] building…");
run("pnpm", ["build"]);
if (!fs.existsSync(path.join(repoRoot, "dist", "index.js"))) {
  throw new Error("build did not produce dist/index.js");
}

// 2) Stage the runtime files.
console.log("[package] staging…");
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

// companion_scripts ships too: the Hub serves the single-command Pi installer
// (/companion/install.sh + manifest) from that folder at runtime.
const include = ["dist", "drizzle", "scripts", "companion_scripts", "package.json", "pnpm-lock.yaml", ".env.example"];
for (const item of include) {
  const src = path.join(repoRoot, item);
  if (!fs.existsSync(src)) {
    console.warn(`[package] skipping missing ${item}`);
    continue;
  }
  fs.cpSync(src, path.join(stageDir, item), {
    recursive: true,
    // Never ship local companion secrets/caches, even if a developer has them.
    filter: (p) => !/(^|[\\/])(\.env|forwarder\.env|go2rtc\.yaml|firmware_puller\.param|companion-suite\.manifest\.json|__pycache__|.*\.pyc)$/.test(p),
  });
}

// 2b) Record provenance: the Hub's /companion/manifest.json reports this commit
//     to the Pi installer when the packaged tree has no .git directory.
const gitSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
const commit = gitSha.status === 0 ? gitSha.stdout.trim() : null;
fs.writeFileSync(
  path.join(stageDir, "release.json"),
  JSON.stringify({ name: "quiver-hub", version: pkg.version, commit, built_at: new Date().toISOString() }, null, 2) + "\n"
);

// 3) Generate an INSTALL.md for the recipient.
fs.writeFileSync(
  path.join(stageDir, "INSTALL.md"),
  `# Quiver Hub ${pkg.version} — Install

A self-contained local ground station for Project Quiver. No cloud account and
no database server — it uses an embedded SQLite DB and local file storage, both
created on first run.

## Requirements
- Node.js 22+
- pnpm  (\`npm install -g pnpm\`)

## Install
\`\`\`bash
tar xzf ${name}.tar.gz && cd ${name}
pnpm install --prod        # runtime deps only (compiles better-sqlite3 for this machine)
\`\`\`

## Run
\`\`\`bash
# Desktop app (Linux): adds a clickable "Quiver Hub" launcher, then click it
pnpm app:install

# Or, any platform — start the server and open the browser:
pnpm app
# Stop it:
pnpm app:stop
\`\`\`

First run creates \`./data\` (SQLite DB + uploaded files) and serves the Hub at
http://localhost:3000, listening on every interface so the drone's Raspberry Pi
can reach it. Set a fixed port for the launcher with \`QUIVER_PORT=<n> pnpm app:install\`.

## Companion computer (Raspberry Pi)
Open Drone Configuration -> "Install on the companion computer", enter the Hub's
address as the Pi reaches it (e.g. http://<hub-ip-on-drone-subnet>:3000) and run
the printed one-line \`curl ... | sudo bash\` command on the Pi. The installer is
served from this package's \`companion_scripts/\` folder.

See the project README for configuration and Tailscale remote access.
`
);

// 4) Tar it up.
console.log("[package] creating tarball…");
run("tar", ["czf", tarball, "-C", releaseDir, name]);
fs.rmSync(stageDir, { recursive: true, force: true });

const sizeMb = (fs.statSync(tarball).size / 1e6).toFixed(1);
console.log(`[package] done → ${path.relative(repoRoot, tarball)} (${sizeMb} MB)`);
