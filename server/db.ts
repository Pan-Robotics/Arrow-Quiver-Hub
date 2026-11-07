import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { User, users, drones, InsertDrone, scans, InsertScan, apiKeys, InsertApiKey, telemetry, InsertTelemetry, flightLogs, InsertFlightLog } from "../drizzle/schema";
import { nanoid } from "nanoid";

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Local single-user mode. The Hub has no login; every request is treated as this fixed admin "operator" account.
 */
export const LOCAL_USER_OPEN_ID = "local-admin";
let _localUser: User | null = null;

/**
 * Resolve the local SQLite database file path.
 * Defaults to <project>/data/quiver.db so the local app works with zero config.
 * Override with DATABASE_URL (a plain filesystem path, or a "file:" / "sqlite:" URL).
 */
export function getDbPath(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw) {
    // Accept file:./data/quiver.db, sqlite:quiver.db, or a bare path.
    return raw.replace(/^file:/, "").replace(/^sqlite:(\/\/)?/, "");
  }
  return path.resolve(process.cwd(), "data", "quiver.db");
}

/**
 * Lazily open the local SQLite database. Unlike the previous cloud setup, the
 * database is always available locally — there is no "degraded, no DB" mode in
 * normal operation, but callers still tolerate a null return for safety.
 *
 * Under Vitest we keep the legacy "no DB unless explicitly configured" behavior
 * so pure-logic unit tests never touch the filesystem.
 */
export async function getDb() {
  if (!_db) {
    if (process.env.VITEST && !process.env.DATABASE_URL) {
      return null;
    }
    try {
      const dbPath = getDbPath();
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      _db = drizzle(sqlite);
    } catch (error) {
      console.warn("[Database] Failed to open local SQLite database:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * Open the local database and apply any pending migrations. Idempotent — safe to
 * call once at server startup. Creates the DB file and all tables on first run,
 * making the local app work with zero manual setup.
 */
export async function migrateDb(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Skipping migrations: database not available");
    return;
  }
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  migrate(db, { migrationsFolder });
  await ensureLocalUser();
  console.log(`[Database] SQLite ready at ${getDbPath()} (migrations applied)`);
}

/**
 * Ensure the single local admin operator exists, returning it. Idempotent.
 * Called at startup (after migrations) and lazily by getLocalUser().
 */
export async function ensureLocalUser(): Promise<User | null> {
  const db = await getDb();
  if (!db) return null;

  await db
    .insert(users)
    .values({
      openId: LOCAL_USER_OPEN_ID,
      name: "Local Operator",
      role: "admin",
      lastSignedIn: new Date(),
    })
    .onConflictDoUpdate({
      target: users.openId,
      set: { role: "admin", lastSignedIn: new Date() },
    });

  _localUser = (await getUserByOpenId(LOCAL_USER_OPEN_ID)) ?? null;
  return _localUser;
}

/**
 * Return the single local admin operator (cached after first lookup).
 */
export async function getLocalUser(): Promise<User | null> {
  if (_localUser) return _localUser;
  return ensureLocalUser();
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Drone management
export async function upsertDrone(drone: InsertDrone) {
  const db = await getDb();
  if (!db) return null;

  await db.insert(drones).values(drone).onConflictDoUpdate({
    target: drones.droneId,
    set: {
      lastSeen: drone.lastSeen || new Date(),
      isActive: true,
    },
  });

  const result = await db.select().from(drones).where(eq(drones.droneId, drone.droneId)).limit(1);
  return result[0];
}

export async function getDroneByDroneId(droneId: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(drones).where(eq(drones.droneId, droneId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getAllDrones() {
  const db = await getDb();
  if (!db) return [];

  return await db.select().from(drones).orderBy(desc(drones.lastSeen));
}

// Scan management
export async function insertScan(scan: InsertScan) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.insert(scans).values(scan);
  return result;
}

export async function getRecentScans(droneId: string, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(scans)
    .where(eq(scans.droneId, droneId))
    .orderBy(desc(scans.timestamp))
    .limit(limit);
}

export async function getScanStats(droneId: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(scans)
    .where(eq(scans.droneId, droneId))
    .orderBy(desc(scans.timestamp))
    .limit(1);

  if (result.length === 0) return null;

  return result[0];
}

// API key validation
export async function validateApiKey(key: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.key, key))
    .limit(1);

  if (result.length === 0 || !result[0].isActive) {
    return null;
  }

  return result[0];
}

// API key management
export async function createApiKey(droneId: string, description?: string): Promise<{ id: number; key: string; droneId: string; description: string | null; isActive: boolean; createdAt: Date } | null> {
  const db = await getDb();
  if (!db) return null;

  // Generate a secure random API key
  const key = nanoid(43); // ~256 bits of entropy

  await db.insert(apiKeys).values({
    key,
    droneId,
    description: description || null,
    isActive: true,
  });

  // Fetch the newly created key
  const result = await db.select().from(apiKeys).where(eq(apiKeys.key, key)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getApiKeysForDrone(droneId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.droneId, droneId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(keyId: number) {
  const db = await getDb();
  if (!db) return false;

  await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, keyId));
  return true;
}

export async function deleteApiKey(keyId: number) {
  const db = await getDb();
  if (!db) return false;

  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return true;
}

export async function reactivateApiKey(keyId: number) {
  const db = await getDb();
  if (!db) return false;

  await db.update(apiKeys).set({ isActive: true }).where(eq(apiKeys.id, keyId));
  return true;
}

// Update drone info (name, droneId)
export async function updateDrone(id: number, updates: { name?: string | null; droneId?: string }) {
  const db = await getDb();
  if (!db) return null;

  const updateSet: Record<string, unknown> = {};
  if (updates.name !== undefined) updateSet.name = updates.name;
  if (updates.droneId !== undefined) updateSet.droneId = updates.droneId;

  if (Object.keys(updateSet).length === 0) return null;

  await db.update(drones).set(updateSet).where(eq(drones.id, id));

  // If droneId changed, also update all API keys referencing the old droneId
  if (updates.droneId) {
    // Fetch the old drone to get old droneId
    const result = await db.select().from(drones).where(eq(drones.id, id)).limit(1);
    return result.length > 0 ? result[0] : null;
  }

  const result = await db.select().from(drones).where(eq(drones.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

// Update drone by droneId (name and optionally new droneId)
export async function updateDroneByDroneId(currentDroneId: string, updates: { name?: string | null; droneId?: string }) {
  const db = await getDb();
  if (!db) return null;

  const updateSet: Record<string, unknown> = {};
  if (updates.name !== undefined) updateSet.name = updates.name;
  if (updates.droneId !== undefined) updateSet.droneId = updates.droneId;

  if (Object.keys(updateSet).length === 0) return null;

  await db.update(drones).set(updateSet).where(eq(drones.droneId, currentDroneId));

  // If droneId changed, also update all API keys referencing the old droneId
  const newDroneId = updates.droneId || currentDroneId;
  if (updates.droneId && updates.droneId !== currentDroneId) {
    await db.update(apiKeys).set({ droneId: updates.droneId }).where(eq(apiKeys.droneId, currentDroneId));
  }

  const result = await db.select().from(drones).where(eq(drones.droneId, newDroneId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

// Update API key description
export async function updateApiKeyDescription(keyId: number, description: string | null) {
  const db = await getDb();
  if (!db) return false;

  await db.update(apiKeys).set({ description }).where(eq(apiKeys.id, keyId));
  return true;
}

// Delete drone with cascading deletes (API keys, scans, telemetry, jobs, files)
export async function deleteDrone(droneId: string): Promise<{ deleted: boolean; counts: { apiKeys: number; scans: number; telemetry: number; jobs: number; files: number; flightLogs: number } }> {
  const db = await getDb();
  if (!db) return { deleted: false, counts: { apiKeys: 0, scans: 0, telemetry: 0, jobs: 0, files: 0, flightLogs: 0 } };

  // Count records before deletion for reporting
  const apiKeyCount = (await db.select().from(apiKeys).where(eq(apiKeys.droneId, droneId))).length;
  const scanCount = (await db.select().from(scans).where(eq(scans.droneId, droneId))).length;
  const telemetryCount = (await db.select().from(telemetry).where(eq(telemetry.droneId, droneId))).length;

  // Import droneJobs and droneFiles from schema for deletion
  const { droneJobs, droneFiles } = await import("../drizzle/schema");
  const jobCount = (await db.select().from(droneJobs).where(eq(droneJobs.droneId, droneId))).length;
  const fileCount = (await db.select().from(droneFiles).where(eq(droneFiles.droneId, droneId))).length;
  const flightLogCount = (await db.select().from(flightLogs).where(eq(flightLogs.droneId, droneId))).length;

  // Cascade delete in order (children first)
  await db.delete(apiKeys).where(eq(apiKeys.droneId, droneId));
  await db.delete(scans).where(eq(scans.droneId, droneId));
  await db.delete(telemetry).where(eq(telemetry.droneId, droneId));
  await db.delete(droneJobs).where(eq(droneJobs.droneId, droneId));
  await db.delete(droneFiles).where(eq(droneFiles.droneId, droneId));
  await db.delete(flightLogs).where(eq(flightLogs.droneId, droneId));

  // Finally delete the drone itself
  await db.delete(drones).where(eq(drones.droneId, droneId));

  return {
    deleted: true,
    counts: {
      apiKeys: apiKeyCount,
      scans: scanCount,
      telemetry: telemetryCount,
      jobs: jobCount,
      files: fileCount,
      flightLogs: flightLogCount,
    },
  };
}

// Telemetry management
export async function insertTelemetry(telem: InsertTelemetry) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.insert(telemetry).values(telem);
  return result;
}

export async function getRecentTelemetry(droneId: string, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(telemetry)
    .where(eq(telemetry.droneId, droneId))
    .orderBy(desc(telemetry.timestamp))
    .limit(limit);
}

// ─── Flight Log Management ───────────────────────────────────────────

export async function createFlightLog(log: InsertFlightLog) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.insert(flightLogs).values(log);
  return result;
}

export async function getFlightLogsForDrone(droneId: string) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(flightLogs)
    .where(eq(flightLogs.droneId, droneId))
    .orderBy(desc(flightLogs.createdAt));
}

export async function getAllFlightLogs() {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(flightLogs)
    .orderBy(desc(flightLogs.createdAt));
}

export async function getFlightLogById(id: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(flightLogs)
    .where(eq(flightLogs.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

export async function updateFlightLog(id: number, updates: { description?: string | null; notesUrl?: string | null; mediaUrls?: string[] | null }) {
  const db = await getDb();
  if (!db) return false;

  await db.update(flightLogs).set(updates).where(eq(flightLogs.id, id));
  return true;
}

export async function deleteFlightLog(id: number) {
  const db = await getDb();
  if (!db) return false;

  await db.delete(flightLogs).where(eq(flightLogs.id, id));
  return true;
}

export async function deleteFlightLogsForDrone(droneId: string) {
  const db = await getDb();
  if (!db) return 0;

  const logs = await db.select().from(flightLogs).where(eq(flightLogs.droneId, droneId));
  await db.delete(flightLogs).where(eq(flightLogs.droneId, droneId));
  return logs.length;
}
