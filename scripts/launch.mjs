#!/usr/bin/env node
/**
 * Quiver Hub desktop launcher.
 *
 * One action → boots the production server (building it first if needed) and
 * opens the app in your browser. Designed to be wired to a clickable `.desktop`
 * entry (see scripts/install-desktop.mjs) so the Hub launches like a desktop app.
 *
 * Idempotent: if the Hub is already running, it just opens the browser.
 * The server is started detached and keeps running after this launcher exits;
 * stop it with `pnpm app:stop` (scripts/stop.mjs).
 *
 * Config (env):
 *   QUIVER_PORT (or PORT)  preferred port (default 3000; the server auto-bumps
 *                           if busy and the launcher follows the real port).
 *   QUIVER_NO_BROWSER=1    start the server but don't open a browser.
 *   QUIVER_NO_BUILD=1      never (re)build; start whatever is in dist/.
 *
 * A build is redone automatically when any source input is newer than
 * dist/index.js (e.g. after `git pull`), so the icon always runs current code.
 */

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = String(process.env.QUIVER_PORT || process.env.PORT || "3000");
const dataDir = path.join(repoRoot, "data");
const logFile = path.join(dataDir, "hub.log");
const pidFile = path.join(dataDir, "hub.pid");
const serverEntry = path.join(repoRoot, "dist", "index.js");

function log(msg) {
  console.log(`[launch] ${msg}`);
}

/** Logo path — works from source (client/public) or a built/released tree (dist/public). */
function iconPath() {
  for (const p of ["client/public/quiver-logo.png", "dist/public/quiver-logo.png"]) {
    const abs = path.join(repoRoot, p);
    if (fs.existsSync(abs)) return abs;
  }
  return "";
}

/** Best-effort desktop notification (no-op if notify-send is absent). */
function notify(title, body = "") {
  if (process.platform !== "linux") return;
  try {
    const icon = iconPath();
    spawnSync("notify-send", ["-a", "Quiver Hub", ...(icon ? ["-i", icon] : []), title, body], {
      stdio: "ignore",
    });
  } catch {
    /* notify-send not installed */
  }
}

function has(bin) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [bin], { stdio: "ignore" }).status === 0;
}

/** Is something already serving HTTP on this port? */
function httpUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1200 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Open a URL — prefer a Chromium/Chrome "app window" for a desktop-app feel. */
function openBrowser(url) {
  if (process.env.QUIVER_NO_BROWSER === "1") {
    log(`browser disabled; open ${url} manually`);
    return;
  }
  const detached = { detached: true, stdio: "ignore" };
  if (process.platform === "darwin") {
    spawn("open", [url], detached).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], detached).unref();
    return;
  }
  // Linux: a chromium-family browser in --app mode looks like a native window.
  const appBrowsers = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"];
  const appBrowser = appBrowsers.find(has);
  if (appBrowser) {
    spawn(appBrowser, [`--app=${url}`, "--new-window"], detached).unref();
  } else {
    spawn("xdg-open", [url], detached).unref();
  }
}

/**
 * Read the server's actual listening port from its log (handles auto-bump).
 * Only lines written after `marker` (this launch's header) count: the log is
 * appended across runs, and a stale "Server running" line from a previous run
 * must never satisfy this launch's readiness check.
 */
function portFromLog(marker) {
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const start = marker ? text.lastIndexOf(marker) : -1;
    const scope = start >= 0 ? text.slice(start) : text;
    const matches = [...scope.matchAll(/Server running on http:\/\/localhost:(\d+)\//g)];
    if (matches.length) return Number(matches[matches.length - 1][1]);
  } catch {
    /* no log yet */
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Hub this checkout already runs, if any: { pid, port } or null. */
function runningInstance() {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim()) || null;
    if (pid) process.kill(pid, 0); // throws when the pid is gone
  } catch {
    pid = null;
  }
  if (pid === null && process.platform !== "win32") {
    // pnpm start / a previous launcher whose pidfile is gone: a server running
    // dist/index.js with this repo as its cwd.
    const found = spawnSync("pgrep", ["-f", "[d]ist/index.js"], { encoding: "utf8" }).stdout || "";
    for (const line of found.split("\n")) {
      const candidate = Number(line.trim());
      if (!candidate) continue;
      try {
        if (fs.readlinkSync(`/proc/${candidate}/cwd`) === repoRoot) { pid = candidate; break; }
      } catch { /* not linux or not ours */ }
    }
  }
  if (!pid) return null;
  // Which port? The listening socket of that pid (Linux), else the last port it logged.
  let port = null;
  if (process.platform === "linux") {
    const ss = spawnSync("ss", ["-ltnp"], { encoding: "utf8" }).stdout || "";
    const m = ss.split("\n").find((l) => l.includes(`pid=${pid},`));
    const pm = m && m.match(/:(\d+)\s+\S+\s+users:/);
    if (pm) port = Number(pm[1]);
  }
  if (!port) port = portFromLog(null);
  return port ? { pid, port } : null;
}

/** pnpm, even when the desktop session has no pnpm on PATH: the repo's own copy first. */
function pnpmCommand() {
  const local = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  if (fs.existsSync(local)) return [local, []];
  if (has("pnpm")) return ["pnpm", []];
  if (has("corepack")) return ["corepack", ["pnpm"]];
  return null;
}

/** Newest mtime under a path (files only), or 0 when it does not exist. */
function newestMtime(p) {
  let newest = 0;
  const visit = (entry) => {
    let st;
    try { st = fs.statSync(entry); } catch { return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        visit(path.join(entry, name));
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  visit(p);
  return newest;
}

/**
 * The build is stale when any source input is newer than dist/index.js. A
 * packaged release has no source tree, so it is never considered stale.
 */
function buildIsStale() {
  if (!fs.existsSync(serverEntry)) return true;
  if (!fs.existsSync(path.join(repoRoot, "server")) || !fs.existsSync(path.join(repoRoot, "client", "src"))) return false;
  const built = fs.statSync(serverEntry).mtimeMs;
  const inputs = ["server", "shared", "client/src", "client/index.html", "client/public", "drizzle/schema.ts", "package.json", "vite.config.ts", "tsconfig.json"];
  return inputs.some((p) => newestMtime(path.join(repoRoot, p)) > built);
}

async function ensureBuilt() {
  const firstRun = !fs.existsSync(serverEntry);
  if (!firstRun && !buildIsStale()) return;
  if (process.env.QUIVER_NO_BUILD === "1") {
    if (firstRun) throw new Error("no build and QUIVER_NO_BUILD=1");
    log("sources changed since the last build, but QUIVER_NO_BUILD=1 — starting the existing build");
    return;
  }
  const pnpm = pnpmCommand();
  if (!pnpm) {
    notify("Quiver Hub", "Build needed but pnpm was not found");
    throw new Error("pnpm not found (install pnpm, or run `pnpm install` once in the repo)");
  }
  log(firstRun ? "first run — building the app (one-time, ~30s)…" : "sources changed since the last build — rebuilding…");
  notify("Quiver Hub", firstRun ? "Building (first run)…" : "Rebuilding (sources changed)…");
  const res = spawnSync(pnpm[0], [...pnpm[1], "build"], { cwd: repoRoot, stdio: "inherit" });
  if (res.status !== 0 || !fs.existsSync(serverEntry)) {
    notify("Quiver Hub", "Build failed — see terminal/log");
    throw new Error("build failed");
  }
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  // Already running? Just open it.
  if (await httpUp(PORT)) {
    log(`already running on :${PORT} — opening browser`);
    if (buildIsStale()) {
      log("note: sources changed since the running build — use Stop, then Start, to run the new code");
      notify("Quiver Hub", "Running an older build — Stop, then Start, to update");
    }
    openBrowser(`http://localhost:${PORT}/`);
    return;
  }
  // Running on a different port (pidfile from an earlier launch, or `pnpm start`)?
  // One checkout is one Hub with one ./data directory: never start a second
  // server over the same SQLite file and the same drones. Open the live one.
  const live = runningInstance();
  if (live) {
    log(`already running on :${live.port} (pid ${live.pid}) — opening browser (asked for :${PORT}; stop it first to change port)`);
    openBrowser(`http://localhost:${live.port}/`);
    return;
  }

  await ensureBuilt();

  log(`starting server on :${PORT}…`);
  const out = fs.openSync(logFile, "a");
  const marker = `=== launch ${new Date().toISOString()} (PORT=${PORT}) ===`;
  fs.writeSync(out, `\n${marker}\n`);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: "production", PORT },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  // Wait for the server to announce its (possibly auto-bumped) port, then verify.
  const deadline = Date.now() + 60_000;
  let actualPort = null;
  while (Date.now() < deadline) {
    await sleep(500);
    const p = portFromLog(marker);
    if (p && (await httpUp(p))) {
      actualPort = p;
      break;
    }
  }

  if (!actualPort) {
    notify("Quiver Hub", "Server didn't come up — see data/hub.log");
    throw new Error(`server did not become ready; check ${logFile}`);
  }

  const url = `http://localhost:${actualPort}/`;
  log(`ready at ${url} (pid ${child.pid})`);
  notify("Quiver Hub", `Ready at ${url}`);
  openBrowser(url);
}

main().catch((err) => {
  console.error(`[launch] ${err.message}`);
  process.exit(1);
});
