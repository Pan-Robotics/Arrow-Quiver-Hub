import type { Express, Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { storageResolvePath } from "../storage";

/** Content-Type lookup by file extension for locally served storage objects. */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
};

/**
 * Serve objects written by server/storage.ts from the local storage root.
 */
export function registerStorageProxy(app: Express) {
  app.get("/files/*", (req: Request, res: Response) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    let full: string;
    try {
      full = storageResolvePath(key);
    } catch {
      res.status(400).send("Invalid storage key");
      return;
    }

    if (!existsSync(full) || !statSync(full).isFile()) {
      res.status(404).send("Not found");
      return;
    }

    const ext = path.extname(full).toLowerCase();
    res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Content-Length", statSync(full).size);
    res.setHeader("Cache-Control", "no-store");

    const stream = createReadStream(full);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).send("Read error");
      else res.end();
    });
    stream.pipe(res);
  });
}
