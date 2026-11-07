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

/** Read the server's actual listening port from its log (handles auto-bump). */
function portFromLog() {
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const matches = [...text.matchAll(/Server running on http:\/\/localhost:(\d+)\//g)];
    if (matches.length) return Number(matches[matches.length - 1][1]);
  } catch {
    /* no log yet */
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBuilt() {
  if (fs.existsSync(serverEntry)) return;
  log("first run — building the app (one-time, ~30s)…");
  notify("Quiver Hub", "Building (first run)…");
  const res = spawnSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
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
    openBrowser(`http://localhost:${PORT}/`);
    return;
  }

  await ensureBuilt();

  log(`starting server on :${PORT}…`);
  const out = fs.openSync(logFile, "a");
  fs.writeSync(out, `\n=== launch ${new Date().toISOString()} (PORT=${PORT}) ===\n`);
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
    const p = portFromLog();
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
