import { eq, and, desc, sql } from "drizzle-orm";
import {
  fcLogs,
  firmwareUpdates,
  systemDiagnostics,
  InsertFcLog,
  InsertFirmwareUpdate,
  InsertSystemDiagnostic,
} from "../drizzle/schema";
import { getDb } from "./db";

// ─── FC Logs ────────────────────────────────────────────────────────────────

/**
 * Create or update an FC log entry (upsert by droneId + remotePath)
 */
export async function upsertFcLog(log: InsertFcLog) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check if log already exists for this drone + remote path
  const existing = await db
    .select()
    .from(fcLogs)
    .where(
      and(
        eq(fcLogs.droneId, log.droneId),
        eq(fcLogs.remotePath, log.remotePath)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    // Update existing entry
    const updates: Record<string, unknown> = {};
    if (log.fileSize !== undefined) updates.fileSize = log.fileSize;
    if (log.status !== undefined) updates.status = log.status;
    if (log.progress !== undefined) updates.progress = log.progress;
    if (log.storageKey !== undefined) updates.storageKey = log.storageKey;
    if (log.url !== undefined) updates.url = log.url;
    if (log.errorMessage !== undefined) updates.errorMessage = log.errorMessage;
    if (log.downloadedAt !== undefined) updates.downloadedAt = log.downloadedAt;

    if (Object.keys(updates).length > 0) {
      await db
        .update(fcLogs)
        .set(updates)
        .where(eq(fcLogs.id, existing[0].id));
    }
    return existing[0].id;
  } else {
    const result = await db.insert(fcLogs).values(log);
    return result[0].insertId;
  }
}

/**
 * Update an FC log entry by ID
 */
export async function updateFcLog(
  id: number,
  updates: Partial<Pick<InsertFcLog, "status" | "progress" | "storageKey" | "url" | "errorMessage" | "downloadedAt" | "fileSize">>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(fcLogs)
    .set(updates)
    .where(eq(fcLogs.id, id));
}

/**
 * Get all FC logs for a drone
 */
export async function getFcLogsForDrone(droneId: string, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(fcLogs)
    .where(eq(fcLogs.droneId, droneId))
    .orderBy(desc(fcLogs.discoveredAt))
    .limit(limit);
}

/**
 * Get a single FC log by ID
 */
export async function getFcLogById(id: number) {
  const db = await getDb();
  if (!db) return undefined;

  const results = await db
    .select()
    .from(fcLogs)
    .where(eq(fcLogs.id, id))
    .limit(1);

  return results.length > 0 ? results[0] : undefined;
}

/**
 * Delete an FC log entry
 */
export async function deleteFcLog(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(fcLogs).where(eq(fcLogs.id, id));
}

// ─── Firmware Updates ───────────────────────────────────────────────────────

/**
 * Create a firmware update record
 */
export async function createFirmwareUpdate(update: InsertFirmwareUpdate) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(firmwareUpdates).values(update);
  return result[0].insertId;
}

/**
 * Update firmware update status
 */
export async function updateFirmwareStatus(
  id: number,
  updates: Partial<Pick<InsertFirmwareUpdate, "status" | "flashStage" | "progress" | "errorMessage" | "startedAt" | "completedAt">>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(firmwareUpdates)
    .set(updates)
    .where(eq(firmwareUpdates.id, id));
}

/**
 * Get all firmware updates for a drone
 */
export async function getFirmwareUpdatesForDrone(droneId: string, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(firmwareUpdates)
    .where(eq(firmwareUpdates.droneId, droneId))
    .orderBy(desc(firmwareUpdates.createdAt))
    .limit(limit);
}

/**
 * Get a single firmware update by ID
 */
export async function getFirmwareUpdateById(id: number) {
  const db = await getDb();
  if (!db) return undefined;

  const results = await db
    .select()
    .from(firmwareUpdates)
    .where(eq(firmwareUpdates.id, id))
    .limit(1);

  return results.length > 0 ? results[0] : undefined;
}

// ─── System Diagnostics ─────────────────────────────────────────────────────

/**
 * Insert a system diagnostics snapshot
 */
export async function insertDiagnostics(diag: InsertSystemDiagnostic) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(systemDiagnostics).values(diag);
  return result[0].insertId;
}

/**
 * Get the latest diagnostics for a drone
 */
export async function getLatestDiagnostics(droneId: string) {
  const db = await getDb();
  if (!db) return undefined;

  const results = await db
    .select()
    .from(systemDiagnostics)
    .where(eq(systemDiagnostics.droneId, droneId))
    .orderBy(desc(systemDiagnostics.timestamp))
    .limit(1);

  return results.length > 0 ? results[0] : undefined;
}

/**
 * Get diagnostics history for a drone
 */
export async function getDiagnosticsHistory(droneId: string, limit: number = 60) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(systemDiagnostics)
    .where(eq(systemDiagnostics.droneId, droneId))
    .orderBy(desc(systemDiagnostics.timestamp))
    .limit(limit);
}

/**
 * Clean up old diagnostics (keep last N entries per drone)
 */
export async function cleanupOldDiagnostics(droneId: string, keepCount: number = 1440) {
  const db = await getDb();
  if (!db) return;

  // Get the ID of the Nth most recent entry
  const cutoff = await db
    .select({ id: systemDiagnostics.id })
    .from(systemDiagnostics)
    .where(eq(systemDiagnostics.droneId, droneId))
    .orderBy(desc(systemDiagnostics.timestamp))
    .limit(1)
    .offset(keepCount);

  if (cutoff.length > 0) {
    await db
      .delete(systemDiagnostics)
      .where(
        and(
          eq(systemDiagnostics.droneId, droneId),
          sql`${systemDiagnostics.id} < ${cutoff[0].id}`
        )
      );
  }
}
