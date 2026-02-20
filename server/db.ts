import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, drones, InsertDrone, scans, InsertScan, apiKeys, InsertApiKey, telemetry, InsertTelemetry } from "../drizzle/schema";
import { nanoid } from "nanoid";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
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

  await db.insert(drones).values(drone).onDuplicateKeyUpdate({
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
