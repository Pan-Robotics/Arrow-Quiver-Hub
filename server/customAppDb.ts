import { eq, and, desc } from "drizzle-orm";
import { getDb } from "./db";
import { customApps, userApps, appData, appVersions, type InsertCustomApp, type CustomApp, type InsertUserApp, type InsertAppData, type InsertAppVersion } from "../drizzle/schema";

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

/**
 * Install an app for a user
 */
export async function installAppForUser(userId: number, appId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check if already installed
  const existing = await db
    .select()
    .from(userApps)
    .where(and(eq(userApps.userId, userId), eq(userApps.appId, appId)))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  // Install the app
  await db.insert(userApps).values({
    userId,
    appId,
  });

  const result = await db
    .select()
    .from(userApps)
    .where(and(eq(userApps.userId, userId), eq(userApps.appId, appId)))
    .limit(1);

  return result[0];
}

/**
 * Uninstall an app for a user
 */
export async function uninstallAppForUser(userId: number, appId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .delete(userApps)
    .where(and(eq(userApps.userId, userId), eq(userApps.appId, appId)));

  return { success: true };
}

/**
 * Get all apps installed by a user
 */
export async function getUserInstalledApps(userId: number) {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select({
      app: customApps,
      installedAt: userApps.installedAt,
    })
    .from(userApps)
    .innerJoin(customApps, eq(userApps.appId, customApps.appId))
    .where(eq(userApps.userId, userId));

  return result;
}

/**
 * Store parsed app data
 */
export async function storeAppData(data: InsertAppData) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.insert(appData).values(data);

  const result = await db
    .select()
    .from(appData)
    .where(eq(appData.appId, data.appId))
    .orderBy(desc(appData.timestamp))
    .limit(1);

  return result[0];
}

/**
 * Get latest app data
 */
export async function getLatestAppData(appId: string, limit: number = 1) {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select()
    .from(appData)
    .where(eq(appData.appId, appId))
    .orderBy(desc(appData.timestamp))
    .limit(limit);

  return result;
}

/**
 * Create a new version snapshot of an app
 */
export async function createAppVersion(appId: string, creatorId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get current app state
  const app = await getCustomAppByAppId(appId);
  if (!app) throw new Error("App not found");



  // Create version snapshot
  const versionData: InsertAppVersion = {
    appId: app.appId,
    version: app.version,
    parserCode: app.parserCode,
    dataSchema: app.dataSchema,
    uiSchema: app.uiSchema || null,
    name: app.name,
    description: app.description || null,
    creatorId,
  };

  await db.insert(appVersions).values(versionData);

  const result = await db
    .select()
    .from(appVersions)
    .where(eq(appVersions.appId, appId))
    .orderBy(desc(appVersions.createdAt))
    .limit(1);

  return result[0];
}

/**
 * Get all versions of an app
 */
export async function getAppVersions(appId: string) {
  const db = await getDb();
  if (!db) return [];



  const result = await db
    .select()
    .from(appVersions)
    .where(eq(appVersions.appId, appId))
    .orderBy(desc(appVersions.createdAt));

  return result;
}

/**
 * Get a specific version of an app
 */
export async function getAppVersion(versionId: number) {
  const db = await getDb();
  if (!db) return undefined;



  const result = await db
    .select()
    .from(appVersions)
    .where(eq(appVersions.id, versionId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Rollback app to a specific version
 */
export async function rollbackAppToVersion(appId: string, versionId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get the version to rollback to
  const version = await getAppVersion(versionId);
  if (!version || version.appId !== appId) {
    throw new Error("Version not found or does not belong to this app");
  }

  // Get current app
  const app = await getCustomAppByAppId(appId);
  if (!app) throw new Error("App not found");

  // Update app with version data
  await db.update(customApps).set({
    parserCode: version.parserCode,
    dataSchema: version.dataSchema,
    uiSchema: version.uiSchema,
    name: version.name,
    description: version.description,
    version: version.version,
  }).where(eq(customApps.appId, appId));

  return { success: true };
}
