/**
 * Serve the companion suite from the Hub itself.
 *
 * A Raspberry Pi on the drone subnet usually has no route to GitHub, but it
 * can always reach the Hub. These routes let one command on the Pi install the
 * complete, verified companion suite without copying files over SSH:
 *
 *   GET /companion/install.sh     the single-command bootstrap script
 *   GET /companion/manifest.json  { files: { name: { sha256, size } }, ... }
 *   GET /companion/files/<name>   one suite file (must be listed in the manifest)
 *
 * The suite is read from the repository's companion_scripts folder next to
 * the running server. Local/generated secrets (.env, forwarder.env,
 * go2rtc.yaml, firmware_puller.param, caches) are never served.
 */
import type { Express, Request, Response } from "express";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_NAMES = new Set([
  ".env",
  "forwarder.env",
  "go2rtc.yaml",
  "firmware_puller.param",
  "companion-suite.manifest.json",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".sh": "text/x-shellscript; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".lua": "text/x-lua; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".service": "text/plain; charset=utf-8",
  ".example": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Locate companion_scripts: next to the working directory, or next to the built server. */
export function companionSuiteDir(): string | null {
  const candidates = [
    process.env.COMPANION_SUITE_DIR?.trim(),
    path.resolve(process.cwd(), "companion_scripts"),
  ];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "..", "companion_scripts"), path.resolve(here, "..", "..", "companion_scripts"));
  } catch {
    // import.meta.url is unavailable in some bundling setups; cwd fallback is enough.
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, "installer_common.sh"))) return candidate;
  }
  return null;
}

function isServable(relative: string): boolean {
  const parts = relative.split("/");
  if (parts.some(p => p === "" || p === "." || p === ".." || p === "__pycache__")) return false;
  const name = parts[parts.length - 1];
  if (EXCLUDED_NAMES.has(name)) return false;
  if (name.endsWith(".pyc") || name.endsWith(".bak") || name.startsWith(".source-backup")) return false;
  return true;
}

export type SuiteManifest = {
  generated_at: string;
  hub_version: string;
  source_commit: string | null;
  files: Record<string, { sha256: string; size: number }>;
};

function readHubVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readGitCommit(): string | null {
  try {
    const head = readFileSync(path.resolve(process.cwd(), ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, "");
    const sha = readFileSync(path.resolve(process.cwd(), ".git", ref), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    // not a git checkout: fall through to the packaged release record
  }
  try {
    const info = JSON.parse(readFileSync(path.resolve(process.cwd(), "release.json"), "utf8"));
    return typeof info.commit === "string" && /^[0-9a-f]{40}$/.test(info.commit) ? info.commit : null;
  } catch {
    return null;
  }
}

/** Build the manifest by hashing every servable file under the suite directory. */
export function buildSuiteManifest(dir: string): SuiteManifest {
  const files: SuiteManifest["files"] = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
        walk(path.join(current, entry.name), relative);
        continue;
      }
      if (!entry.isFile() || !isServable(relative)) continue;
      const payload = readFileSync(path.join(current, entry.name));
      files[relative] = { sha256: createHash("sha256").update(payload).digest("hex"), size: payload.length };
    }
  };
  walk(dir, "");
  return {
    generated_at: new Date().toISOString(),
    hub_version: readHubVersion(),
    source_commit: readGitCommit(),
    files,
  };
}

/** Resolve a requested suite path to a file inside the suite dir, or null. */
export function resolveSuiteFile(dir: string, requested: string): string | null {
  const relative = requested.replace(/^\/+/, "");
  if (!isServable(relative)) return null;
  const full = path.resolve(dir, relative);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

export function registerCompanionSuiteRoutes(app: Express) {
  app.get("/companion/install.sh", (_req: Request, res: Response) => {
    const dir = companionSuiteDir();
    const file = dir && resolveSuiteFile(dir, "bootstrap_companion.sh");
    if (!file) {
      res.status(404).type("text/plain").send("Companion suite not available on this Hub");
      return;
    }
    res.setHeader("Content-Type", CONTENT_TYPES[".sh"]);
    res.setHeader("Cache-Control", "no-store");
    res.send(readFileSync(file));
  });

  app.get("/companion/manifest.json", (_req: Request, res: Response) => {
    const dir = companionSuiteDir();
    if (!dir) {
      res.status(404).json({ error: "Companion suite not available on this Hub" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(buildSuiteManifest(dir));
  });

  app.get("/companion/files/*", (req: Request, res: Response) => {
    const dir = companionSuiteDir();
    const requested = (req.params as Record<string, string>)[0] ?? "";
    const file = dir && resolveSuiteFile(dir, requested);
    if (!file) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.send(readFileSync(file));
  });
}
