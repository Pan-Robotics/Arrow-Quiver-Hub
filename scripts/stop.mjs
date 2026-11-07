#!/usr/bin/env node
/**
 * Stop a running Quiver Hub for this project.
 *
 * Finds the Hub however it was started — the desktop launcher, `pnpm app`,
 * `pnpm start`, or `pnpm dev` — and on whatever port, then SIGTERMs it. Scoped to
 * THIS repo (by process working directory) so it never touches unrelated Node
 * processes. Safe to run when nothing is running.
 *
 * Wired to the "Quiver Hub (Stop)" desktop entry and `pnpm app:stop`.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = String(process.env.QUIVER_PORT || process.env.PORT || "3000");
const pidFile = path.join(repoRoot, "data", "hub.pid");

function notify(body) {
  if (process.platform !== "linux") return;
  try {
    spawnSync("notify-send", ["-a", "Quiver Hub", "Quiver Hub", body], { stdio: "ignore" });
  } catch {
    /* notify-send not installed */
  }
}

function sh(cmd) {
  const res = spawnSync("bash", ["-lc", cmd], { encoding: "utf8" });
  return (res.stdout || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does this pid belong to a process running out of this repo? */
function cwdIsRepo(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`) === repoRoot; // Linux
  } catch {
    // No /proc (macOS) or no permission — fall back to lsof if available.
    const dirs = sh(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'`);
    return dirs.includes(repoRoot);
  }
}

const targets = new Set();

// 1) pid file written by the launcher.
try {
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (pid) targets.add(pid);
} catch {
  /* no pid file */
}
try {
  fs.rmSync(pidFile, { force: true });
} catch {
  /* ignore */
}

if (process.platform !== "win32") {
  // 2) Any Node/tsx process running THIS repo's server entry — covers prod
  //    (dist/index.js) and dev (tsx … server/_core/index.ts), on any port,
  //    however it was started. Scope to this repo via the process cwd. The
  //    [d]/[s] bracket trick keeps pgrep's own command line from self-matching.
  for (const p of sh("pgrep -f '[d]ist/index.js|[s]erver/_core/index.ts' 2>/dev/null || true")) {
    const pid = Number(p);
    if (pid && pid !== process.pid && cwdIsRepo(pid)) targets.add(pid);
  }

  // 3) Belt-and-braces: whatever is bound to the configured port.
  for (const p of sh(
    `lsof -ti tcp:${PORT} 2>/dev/null || ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\\K[0-9]+'`
  )) {
    const pid = Number(p);
    if (pid && pid !== process.pid) targets.add(pid);
  }
}

let stopped = 0;
for (const pid of targets) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[stop] SIGTERM ${pid}`);
    stopped++;
  } catch {
    /* already gone */
  }
}

console.log(stopped ? `[stop] Quiver Hub stopped (${stopped} process${stopped > 1 ? "es" : ""}).` : "[stop] nothing to stop.");
notify(stopped ? "Stopped." : "Was not running.");
