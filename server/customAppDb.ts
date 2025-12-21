import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { customApps, InsertCustomApp, CustomApp } from "../drizzle/schema";

/**
 * Create a new custom app
 */
export async function createCustomApp(app: InsertCustomApp): Promise<CustomApp> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const result = await db.insert(customApps).values(app);
  const insertedId = Number(result[0].insertId);

  // Fetch and return the created app
  const created = await db
    .select()
    .from(customApps)
    .where(eq(customApps.id, insertedId))
    .limit(1);

  if (created.length === 0) {
    throw new Error("Failed to fetch created app");
  }

  return created[0];
}

/**
 * Get all custom apps (optionally filter by published status)
 */
export async function getAllCustomApps(publishedOnly = false): Promise<CustomApp[]> {
  const db = await getDb();
  if (!db) {
    return [];
  }

  if (publishedOnly) {
    return db
      .select()
      .from(customApps)
      .where(eq(customApps.published, "published"));
  }

  return db.select().from(customApps);
}

/**
 * Get a custom app by appId
 */
export async function getCustomAppByAppId(appId: string): Promise<CustomApp | undefined> {
  const db = await getDb();
  if (!db) {
    return undefined;
  }

  const result = await db
    .select()
    .from(customApps)
    .where(eq(customApps.appId, appId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Get a custom app by ID
 */
export async function getCustomAppById(id: number): Promise<CustomApp | undefined> {
  const db = await getDb();
  if (!db) {
    return undefined;
  }

  const result = await db
    .select()
    .from(customApps)
    .where(eq(customApps.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Update a custom app
 */
export async function updateCustomApp(
  id: number,
  updates: Partial<InsertCustomApp>
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db.update(customApps).set(updates).where(eq(customApps.id, id));
}

/**
 * Delete a custom app
 */
export async function deleteCustomApp(id: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db.delete(customApps).where(eq(customApps.id, id));
}

/**
 * Publish a custom app
 */
export async function publishCustomApp(id: number): Promise<void> {
  await updateCustomApp(id, { published: "published" });
}

/**
 * Unpublish a custom app
 */
export async function unpublishCustomApp(id: number): Promise<void> {
  await updateCustomApp(id, { published: "draft" });
}

/**
 * Get apps created by a specific user
 */
export async function getCustomAppsByCreator(creatorId: number): Promise<CustomApp[]> {
  const db = await getDb();
  if (!db) {
    return [];
  }

  return db
    .select()
    .from(customApps)
    .where(eq(customApps.creatorId, creatorId));
}
