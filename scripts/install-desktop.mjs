#!/usr/bin/env node
/**
 * Install clickable desktop launchers for Quiver Hub (Linux / freedesktop).
 *
 * Builds the app once, then writes "Quiver Hub" (start) and "Quiver Hub (Stop)"
 * entries into ~/.local/share/applications so they appear in your app grid /
 * launcher search. Exec paths are absolute (this node binary + the scripts), so
 * clicking works regardless of nvm/PATH.
 *
 * Run: pnpm app:install
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

if (process.platform !== "linux") {
  console.error("[install] This installer targets Linux (.desktop). On macOS/Windows, use `pnpm app` or create a shortcut to it.");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const appsDir = path.join(os.homedir(), ".local", "share", "applications");
const serverEntry = path.join(repoRoot, "dist", "index.js");
// Logo from source (client/public) or a built/released tree (dist/public).
const icon =
  [path.join(repoRoot, "client/public/quiver-logo.png"), path.join(repoRoot, "dist/public/quiver-logo.png")].find(
    (p) => fs.existsSync(p)
  ) || "";

// Build once so clicking the launcher never has to (and never needs pnpm on PATH).
if (!fs.existsSync(serverEntry)) {
  console.log("[install] building the app (one-time)…");
  const res = spawnSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
  if (res.status !== 0 || !fs.existsSync(serverEntry)) {
    console.error("[install] build failed — fix the build, then re-run `pnpm app:install`.");
    process.exit(1);
  }
}

fs.mkdirSync(appsDir, { recursive: true });

// Desktop Entry Exec args containing reserved chars (e.g. spaces — this repo path
// has them) must be double-quoted, with " $ ` \ escaped. Without this the path
// splits into separate args and the launcher never starts.
const execArg = (s) => `"${s.replace(/(["$`\\])/g, "\\$1")}"`;
const execLine = (...args) => args.map(execArg).join(" ");

// Optionally bake a fixed port into the launcher entries, e.g.:
//   QUIVER_PORT=3005 pnpm app:install
// (matches a drone configured to reach the Hub on that port). Numeric only.
const bakedPort = (process.env.QUIVER_PORT || "").trim();
const envPrefix = /^\d+$/.test(bakedPort) ? `env QUIVER_PORT=${bakedPort} ` : "";

function writeDesktop(filename, fields) {
  const body =
    "[Desktop Entry]\n" +
    Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  const dest = path.join(appsDir, filename);
  fs.writeFileSync(dest, body, { mode: 0o755 });
  return dest;
}

const start = writeDesktop("quiver-hub.desktop", {
  Type: "Application",
  Name: "Quiver Hub",
  Comment: "Quiver UAV ground station — boots the local server and opens it in your browser",
  Exec: envPrefix + execLine(node, path.join(repoRoot, "scripts", "launch.mjs")),
  Icon: icon,
  Terminal: "false",
  Categories: "Utility;",
  Keywords: "quiver;drone;uav;ground station;telemetry;",
  StartupNotify: "true",
});

const stop = writeDesktop("quiver-hub-stop.desktop", {
  Type: "Application",
  Name: "Quiver Hub (Stop)",
  Comment: "Stop the running Quiver Hub server",
  Exec: envPrefix + execLine(node, path.join(repoRoot, "scripts", "stop.mjs")),
  Icon: icon,
  Terminal: "false",
  Categories: "Utility;",
  StartupNotify: "false",
});

// Refresh the launcher cache (best-effort).
spawnSync("update-desktop-database", [appsDir], { stdio: "ignore" });

console.log("[install] Installed desktop launchers:");
console.log(`  • ${start}`);
console.log(`  • ${stop}`);
console.log(`  • port: ${bakedPort && /^\d+$/.test(bakedPort) ? bakedPort : "3000 (launcher default)"}`);
console.log("");
console.log('Open your app launcher and search "Quiver Hub" — click it to start + open in the browser.');
console.log("Tip: to also drop it on your Desktop:");
console.log(`  cp "${start}" ~/Desktop/ && gio set ~/Desktop/quiver-hub.desktop metadata::trusted true`);
