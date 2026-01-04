import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, json } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Custom apps created by developers via the app builder.
 * Stores payload parser code and app metadata.
 */
export const customApps = mysqlTable("customApps", {
  id: int("id").autoincrement().primaryKey(),
  /** Unique app identifier (slug) */
  appId: varchar("appId", { length: 64 }).notNull().unique(),
  /** Display name */
  name: varchar("name", { length: 255 }).notNull(),
  /** App description */
  description: text("description"),
  /** App icon URL */
  icon: varchar("icon", { length: 512 }),
  /** Python payload parser code */
  parserCode: text("parserCode").notNull(),
  /** JSON schema defining data structure */
  dataSchema: text("dataSchema").notNull(),
  /** UI layout configuration (JSON) */
  uiSchema: text("uiSchema"),
  /** App version */
  version: varchar("version", { length: 32 }).default("1.0.0").notNull(),
  /** Published to app store */
  published: mysqlEnum("published", ["draft", "published"]).default("draft").notNull(),
  /** Creator user ID */
  creatorId: int("creatorId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type CustomApp = typeof customApps.$inferSelect;
export type InsertCustomApp = typeof customApps.$inferInsert;

/**
 * User-installed apps - tracks which apps each user has installed
 */
export const userApps = mysqlTable("userApps", {
  id: int("id").autoincrement().primaryKey(),
  /** User ID who installed the app */
  userId: int("userId").notNull(),
  /** App ID that was installed */
  appId: varchar("appId", { length: 64 }).notNull(),
  /** Installation timestamp */
  installedAt: timestamp("installedAt").defaultNow().notNull(),
});

export type UserApp = typeof userApps.$inferSelect;
export type InsertUserApp = typeof userApps.$inferInsert;

/**
 * App version history - tracks all versions of custom apps for rollback capability
 */
export const appVersions = mysqlTable("appVersions", {
  id: int("id").autoincrement().primaryKey(),
  /** App ID this version belongs to */
  appId: varchar("appId", { length: 64 }).notNull(),
  /** Version number (e.g., 1.0.0, 1.0.1, 2.0.0) */
  version: varchar("version", { length: 32 }).notNull(),
  /** Python payload parser code for this version */
  parserCode: text("parserCode").notNull(),
  /** JSON schema defining data structure for this version */
  dataSchema: text("dataSchema").notNull(),
  /** UI layout configuration (JSON) for this version */
  uiSchema: text("uiSchema"),
  /** App name at this version */
  name: varchar("name", { length: 255 }).notNull(),
  /** App description at this version */
  description: text("description"),
  /** User ID who created this version */
  creatorId: int("creatorId").notNull(),
  /** When this version was created */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AppVersion = typeof appVersions.$inferSelect;
export type InsertAppVersion = typeof appVersions.$inferInsert;

/**
 * App data storage - stores parsed payload data for custom apps
 */
export const appData = mysqlTable("appData", {
  id: int("id").autoincrement().primaryKey(),
  /** App ID that received the data */
  appId: varchar("appId", { length: 64 }).notNull(),
  /** Parsed data (JSON) */
  data: json("data").notNull(),
  /** Original raw payload (JSON) */
  rawPayload: json("rawPayload"),
  /** Timestamp when data was received */
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export type AppData = typeof appData.$inferSelect;
export type InsertAppData = typeof appData.$inferInsert;

/**
 * Drones table - stores information about connected drones
 */
export const drones = mysqlTable("drones", {
  id: int("id").autoincrement().primaryKey(),
  droneId: varchar("droneId", { length: 64 }).notNull().unique(),
  name: text("name"),
  lastSeen: timestamp("lastSeen").defaultNow().notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Drone = typeof drones.$inferSelect;
export type InsertDrone = typeof drones.$inferInsert;

/**
 * Point cloud scans table - stores metadata about each scan
 */
export const scans = mysqlTable("scans", {
  id: int("id").autoincrement().primaryKey(),
  droneId: varchar("droneId", { length: 64 }).notNull(),
  timestamp: timestamp("timestamp").notNull(),
  pointCount: int("pointCount").notNull(),
  minDistance: int("minDistance"),
  maxDistance: int("maxDistance"),
  avgQuality: int("avgQuality"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Scan = typeof scans.$inferSelect;
export type InsertScan = typeof scans.$inferInsert;

/**
 * API keys table - for authenticating incoming point cloud data
 */
export const apiKeys = mysqlTable("apiKeys", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  droneId: varchar("droneId", { length: 64 }).notNull(),
  description: text("description"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

/**
 * Telemetry table - stores flight controller and battery telemetry
 */
export const telemetry = mysqlTable("telemetry", {
  id: int("id").autoincrement().primaryKey(),
  droneId: varchar("droneId", { length: 64 }).notNull(),
  timestamp: timestamp("timestamp").notNull(),
  telemetryData: json("telemetryData").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Telemetry = typeof telemetry.$inferSelect;
export type InsertTelemetry = typeof telemetry.$inferInsert;

/**
 * Drone jobs table - stores pending tasks for drones to execute
 * Used for two-way communication: Hub → Pi
 */
export const droneJobs = mysqlTable("droneJobs", {
  id: int("id").autoincrement().primaryKey(),
  /** Drone ID this job is for */
  droneId: varchar("droneId", { length: 64 }).notNull(),
  /** Job type: upload_file, update_config, restart_service, etc. */
  type: varchar("type", { length: 64 }).notNull(),
  /** Job payload (JSON) - contains type-specific data */
  payload: json("payload").notNull(),
  /** Job status: pending, in_progress, completed, failed */
  status: mysqlEnum("status", ["pending", "in_progress", "completed", "failed"]).default("pending").notNull(),
  /** Error message if job failed */
  errorMessage: text("errorMessage"),
  /** When job was created */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** When job was acknowledged by drone */
  acknowledgedAt: timestamp("acknowledgedAt"),
  /** When job was completed */
  completedAt: timestamp("completedAt"),
  /** User ID who created this job */
  createdBy: int("createdBy").notNull(),
});

export type DroneJob = typeof droneJobs.$inferSelect;
export type InsertDroneJob = typeof droneJobs.$inferInsert;

/**
 * Drone files table - stores uploaded files for drones to download
 */
export const droneFiles = mysqlTable("droneFiles", {
  id: int("id").autoincrement().primaryKey(),
  /** Unique file identifier */
  fileId: varchar("fileId", { length: 64 }).notNull().unique(),
  /** Original filename */
  filename: varchar("filename", { length: 255 }).notNull(),
  /** File MIME type */
  mimeType: varchar("mimeType", { length: 128 }),
  /** File size in bytes */
  fileSize: int("fileSize").notNull(),
  /** S3 storage key */
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  /** Public URL for download */
  url: varchar("url", { length: 1024 }).notNull(),
  /** Drone ID this file is for (null = available to all) */
  droneId: varchar("droneId", { length: 64 }),
  /** File description */
  description: text("description"),
  /** User ID who uploaded this file */
  uploadedBy: int("uploadedBy").notNull(),
  /** When file was uploaded */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DroneFile = typeof droneFiles.$inferSelect;
export type InsertDroneFile = typeof droneFiles.$inferInsert;
