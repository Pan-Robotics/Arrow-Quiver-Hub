// Local filesystem storage for the Quiver Hub local app.
//
// Files are written under a local storage root (default: <cwd>/data/storage,
// override with STORAGE_DIR) and served back by the /files/* route registered in
// server/_core/storageProxy.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { droneFacingBaseUrl } from "./hubAddress";

/** Absolute path of the local storage root. */
export function storageRoot(): string {
  const override = process.env.STORAGE_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.resolve(process.cwd(), "data", "storage");
}

/** Strip leading slashes so keys are always relative to the storage root. */
function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * Resolve a storage key to an absolute on-disk path, guarding against path
 * traversal (keys must stay inside the storage root).
 */
export function storageResolvePath(relKey: string): string {
  const key = normalizeKey(relKey);
  const root = storageRoot();
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Invalid storage key: ${relKey}`);
  }
  return full;
}

/** Public URL (relative to the hub origin) that serves a stored object. */
export function storagePublicPath(relKey: string): string {
  return `/files/${normalizeKey(relKey)}`;
}

/**
 * Turn a relative storage path (e.g. "/files/...") into an absolute URL that a
 * companion computer can fetch over the network. Already-absolute URLs are
 * returned unchanged. The base is the drone-facing Hub address: PUBLIC_BASE_URL,
 * else the request host unless it is localhost, else the Hub's tailnet address
 * (see server/hubAddress.ts) — a drone is normally not on the operator's LAN.
 */
export function toPublicUrl(
  relOrAbsUrl: string,
  req?: { protocol?: string; get?: (header: string) => string | undefined }
): string {
  if (/^https?:\/\//i.test(relOrAbsUrl)) return relOrAbsUrl;
  const base = droneFacingBaseUrl(req);
  const sep = relOrAbsUrl.startsWith("/") ? "" : "/";
  return `${base.replace(/\/+$/, "")}${sep}${relOrAbsUrl}`;
}

/**
 * Write an object to local storage and return its key and public (relative) URL.
 * `contentType` is accepted for signature compatibility; the served Content-Type
 * is inferred from the file extension at serve time.
 */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const full = storageResolvePath(key);
  await mkdir(path.dirname(full), { recursive: true });
  const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  await writeFile(full, buffer);
  return { key, url: storagePublicPath(key) };
}

/** Return the key and public (relative) URL for an existing object. */
export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: storagePublicPath(key) };
}

/**
 * Read a stored object straight from disk. Server-side code must use this rather
 * than fetch()ing the object's URL: stored URLs are relative ("/files/...") and
 * are only resolvable by a browser or, once made absolute, a companion computer.
 */
export async function storageRead(relKey: string): Promise<Buffer> {
  return readFile(storageResolvePath(relKey));
}
