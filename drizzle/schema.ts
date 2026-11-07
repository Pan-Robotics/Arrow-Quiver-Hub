import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema for the local Quiver Hub app.
 * Timestamps use mode "timestamp" (epoch seconds <-> JS Date). Defaults and
 * onUpdate are applied at the application layer via Drizzle ($defaultFn / $onUpdate)
 * so they hold regardless of how rows are written (all writes go through Drizzle).
 * JSON columns use mode "json" (object <-> TEXT). Booleans use mode "boolean" (0/1).
 */

/**
 * Core user table backing auth flow.
 */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("openId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  loginMethod: text("loginMethod"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Custom apps created by developers via the app builder.
 * Stores payload parser code and app metadata.
 */
export const customApps = sqliteTable("customApps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Unique app identifier (slug) */
  appId: text("appId").notNull().unique(),
  /** Display name */
  name: text("name").notNull(),
  /** App description */
  description: text("description"),
  /** App icon URL */
  icon: text("icon"),
  /** Data source type: how this app receives data */
  dataSource: text("dataSource", { enum: ["custom_endpoint", "stream_subscription", "passthrough"] }).default("custom_endpoint").notNull(),
  /** Data source configuration (JSON) - stream name, field mappings, etc. */
  dataSourceConfig: text("dataSourceConfig"),
  /** Python payload parser code (optional for stream_subscription and passthrough) */
  parserCode: text("parserCode").notNull(),
  /** JSON schema defining data structure */
  dataSchema: text("dataSchema").notNull(),
  /** UI layout configuration (JSON) */
  uiSchema: text("uiSchema"),
  /** App version */
  version: text("version").default("1.0.0").notNull(),
  /** Published to app store */
  published: text("published", { enum: ["draft", "published"] }).default("draft").notNull(),
  /** Creator user ID */
  creatorId: integer("creatorId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export type CustomApp = typeof customApps.$inferSelect;
export type InsertCustomApp = typeof customApps.$inferInsert;

/**
 * User-installed apps - tracks which apps each user has installed
 */
export const userApps = sqliteTable("userApps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** User ID who installed the app */
  userId: integer("userId").notNull(),
  /** App ID that was installed */
  appId: text("appId").notNull(),
  /** Installation timestamp */
  installedAt: integer("installedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type UserApp = typeof userApps.$inferSelect;
export type InsertUserApp = typeof userApps.$inferInsert;

/**
 * App version history - tracks all versions of custom apps for rollback capability
 */
export const appVersions = sqliteTable("appVersions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** App ID this version belongs to */
  appId: text("appId").notNull(),
  /** Version number (e.g., 1.0.0, 1.0.1, 2.0.0) */
  version: text("version").notNull(),
  /** Python payload parser code for this version */
  parserCode: text("parserCode").notNull(),
  /** JSON schema defining data structure for this version */
  dataSchema: text("dataSchema").notNull(),
  /** UI layout configuration (JSON) for this version */
  uiSchema: text("uiSchema"),
  /** App name at this version */
  name: text("name").notNull(),
  /** App description at this version */
  description: text("description"),
  /** User ID who created this version */
  creatorId: integer("creatorId").notNull(),
  /** When this version was created */
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type AppVersion = typeof appVersions.$inferSelect;
export type InsertAppVersion = typeof appVersions.$inferInsert;

/**
 * App data storage - stores parsed payload data for custom apps
 */
export const appData = sqliteTable("appData", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** App ID that received the data */
  appId: text("appId").notNull(),
  /** Parsed data (JSON) */
  data: text("data", { mode: "json" }).notNull(),
  /** Original raw payload (JSON) */
  rawPayload: text("rawPayload", { mode: "json" }),
  /** Timestamp when data was received */
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type AppData = typeof appData.$inferSelect;
export type InsertAppData = typeof appData.$inferInsert;

/**
 * Drones table - stores information about connected drones
 */
export const drones = sqliteTable("drones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: text("droneId").notNull().unique(),
  name: text("name"),
  lastSeen: integer("lastSeen", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  // Data-plane mode (Tailscale Phase B). "push" = companion POSTs to the Hub's
  // REST ingest (legacy/benchtop default). "pull" = the Hub opens an outbound
  // WebSocket to this drone's tailnet stream service and re-broadcasts. See
  // docs/architecture/Quiver_Drone_Stream_Protocol.md.
  ingestMode: text("ingestMode", { enum: ["push", "pull"] }).default("push").notNull(),
  // How the Hub reaches this drone's stream service in pull mode: its MagicDNS
  // name (e.g. quiver-001.<tailnet>.ts.net) or IP, and the stream port.
  tailnetHost: text("tailnetHost"),
  streamPort: integer("streamPort").default(8765).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type Drone = typeof drones.$inferSelect;
export type InsertDrone = typeof drones.$inferInsert;

/**
 * Point cloud scans table - stores metadata about each scan
 */
export const scans = sqliteTable("scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: text("droneId").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  pointCount: integer("pointCount").notNull(),
  minDistance: integer("minDistance"),
  maxDistance: integer("maxDistance"),
  avgQuality: integer("avgQuality"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type Scan = typeof scans.$inferSelect;
export type InsertScan = typeof scans.$inferInsert;

/**
 * API keys table - for authenticating incoming point cloud data
 */
export const apiKeys = sqliteTable("apiKeys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  droneId: text("droneId").notNull(),
  description: text("description"),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

/**
 * Telemetry table - stores flight controller and battery telemetry
 */
export const telemetry = sqliteTable("telemetry", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  droneId: text("droneId").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  telemetryData: text("telemetryData", { mode: "json" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type Telemetry = typeof telemetry.$inferSelect;
export type InsertTelemetry = typeof telemetry.$inferInsert;

/**
 * Drone jobs table - stores pending tasks for drones to execute
 * Used for two-way communication: Hub → Pi
 */
export const droneJobs = sqliteTable("droneJobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Drone ID this job is for */
  droneId: text("droneId").notNull(),
  /** Job type: upload_file, update_config, restart_service, etc. */
  type: text("type").notNull(),
  /** Job payload (JSON) - contains type-specific data */
  payload: text("payload", { mode: "json" }).notNull(),
  /** Job status: pending, in_progress, completed, failed, expired */
  status: text("status", { enum: ["pending", "in_progress", "completed", "failed", "expired"] }).default("pending").notNull(),
  /** Error message if job failed */
  errorMessage: text("errorMessage"),
  /** When job was created */
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  /** When job was acknowledged by drone */
  acknowledgedAt: integer("acknowledgedAt", { mode: "timestamp" }),
  /** When job was completed */
  completedAt: integer("completedAt", { mode: "timestamp" }),
  /** User ID who created this job */
  createdBy: integer("createdBy").notNull(),

  // ─── Job Reliability Fields ───────────────────────────────────────────
  /** Number of times this job has been retried after timeout/failure */
  retryCount: integer("retryCount").default(0).notNull(),
  /** Maximum number of retries before marking as permanently failed */
  maxRetries: integer("maxRetries").default(3).notNull(),
  /** Timeout in seconds — if acknowledged but not completed within this window, reaper resets it */
  timeoutSeconds: integer("timeoutSeconds").default(300).notNull(),
  /** When this job expires and should no longer be executed (stale guard) */
  expiresAt: integer("expiresAt", { mode: "timestamp" }),
  /** Companion identifier that locked this job (mutex — prevents double-execution) */
  lockedBy: text("lockedBy"),
});

export type DroneJob = typeof droneJobs.$inferSelect;
export type InsertDroneJob = typeof droneJobs.$inferInsert;

/**
 * Drone files table - stores uploaded files for drones to download
 */
export const droneFiles = sqliteTable("droneFiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Unique file identifier */
  fileId: text("fileId").notNull().unique(),
  /** Original filename */
  filename: text("filename").notNull(),
  /** File MIME type */
  mimeType: text("mimeType"),
  /** File size in bytes */
  fileSize: integer("fileSize").notNull(),
  /** Local/object storage key */
  storageKey: text("storageKey").notNull(),
  /** Public URL for download */
  url: text("url").notNull(),
  /** Drone ID this file is for (null = available to all) */
  droneId: text("droneId"),
  /** File description */
  description: text("description"),
  /** User ID who uploaded this file */
  uploadedBy: integer("uploadedBy").notNull(),
  /** When file was uploaded */
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type DroneFile = typeof droneFiles.$inferSelect;
export type InsertDroneFile = typeof droneFiles.$inferInsert;

/**
 * Flight logs table - stores ArduPilot .BIN/.log file metadata for the Flight Analytics app.
 * Actual file bytes live in object/local storage; this table holds only references and summary info.
 */
export const flightLogs = sqliteTable("flightLogs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Drone this log belongs to */
  droneId: text("droneId").notNull(),
  /** Original filename as uploaded */
  filename: text("filename").notNull(),
  /** File size in bytes */
  fileSize: integer("fileSize").notNull(),
  /** Storage key */
  storageKey: text("storageKey").notNull(),
  /** Public URL for download / client-side parsing */
  url: text("url").notNull(),
  /** File format: bin or log */
  format: text("format", { enum: ["bin", "log"] }).notNull(),
  /** Optional user-provided description or notes */
  description: text("description"),
  /** Optional associated markdown notes file URL */
  notesUrl: text("notesUrl"),
  /** Optional associated media URLs (JSON array of URLs) */
  mediaUrls: text("mediaUrls", { mode: "json" }),
  /** Upload source: manual (UI) or api (REST endpoint from Pi) */
  uploadSource: text("uploadSource", { enum: ["manual", "api"] }).default("manual").notNull(),
  /** User ID who uploaded (null if uploaded via API) */
  uploadedBy: integer("uploadedBy"),
  /** When the log was uploaded */
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type FlightLog = typeof flightLogs.$inferSelect;
export type InsertFlightLog = typeof flightLogs.$inferInsert;

/**
 * FC logs table - tracks flight controller log files discovered and downloaded via MAVFTP.
 * The companion script lists logs on the FC SD card, downloads them, and uploads to storage.
 */
export const fcLogs = sqliteTable("fcLogs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Drone this log belongs to */
  droneId: text("droneId").notNull(),
  /** Remote file path on FC SD card (e.g. /APM/LOGS/00000042.BIN) */
  remotePath: text("remotePath").notNull(),
  /** Original filename */
  filename: text("filename").notNull(),
  /** File size in bytes on the FC */
  fileSize: integer("fileSize"),
  /** Download status */
  status: text("status", { enum: ["discovered", "downloading", "uploading", "completed", "failed"] }).default("discovered").notNull(),
  /** Download progress percentage (0-100) */
  progress: integer("progress").default(0),
  /** Storage key once uploaded */
  storageKey: text("storageKey"),
  /** Public URL once uploaded */
  url: text("url"),
  /** Error message if download failed */
  errorMessage: text("errorMessage"),
  /** When the log was discovered on the FC */
  discoveredAt: integer("discoveredAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  /** When download completed */
  downloadedAt: integer("downloadedAt", { mode: "timestamp" }),
  /** SHA-256 hash of the downloaded file (computed after upload to storage) */
  sha256Hash: text("sha256Hash"),
});

export type FcLog = typeof fcLogs.$inferSelect;
export type InsertFcLog = typeof fcLogs.$inferInsert;

/**
 * Firmware updates table - tracks OTA firmware upload and flash operations.
 * Firmware .abin files are uploaded to storage, then pushed to the FC via MAVFTP.
 */
export const firmwareUpdates = sqliteTable("firmwareUpdates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Drone this update targets */
  droneId: text("droneId").notNull(),
  /** Firmware filename (e.g. arducopter.abin) */
  filename: text("filename").notNull(),
  /** File size in bytes */
  fileSize: integer("fileSize").notNull(),
  /** Storage key */
  storageKey: text("storageKey").notNull(),
  /** Public URL for download */
  url: text("url").notNull(),
  /** Overall status */
  status: text("status", { enum: ["uploaded", "queued", "transferring", "flashing", "verifying", "completed", "failed"] }).default("uploaded").notNull(),
  /** ArduPilot flash stage based on file rename (ardupilot.abin → ardupilot-verify.abin → etc.) */
  flashStage: text("flashStage"),
  /** Transfer/flash progress percentage (0-100) */
  progress: integer("progress").default(0),
  /** Error message if update failed */
  errorMessage: text("errorMessage"),
  /** User who initiated the update */
  initiatedBy: integer("initiatedBy"),
  /** When the firmware was uploaded */
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  /** When the flash started */
  startedAt: integer("startedAt", { mode: "timestamp" }),
  /** When the flash completed */
  completedAt: integer("completedAt", { mode: "timestamp" }),
  /** SHA-256 hash of the firmware binary (computed at upload, verified before flash) */
  sha256Hash: text("sha256Hash"),
  /** Confirmed firmware version after flash (e.g. "4.5.7 (d940850a)") — set by post-reboot AUTOPILOT_VERSION readback */
  firmwareVersion: text("firmwareVersion"),
});

export type FirmwareUpdate = typeof firmwareUpdates.$inferSelect;
export type InsertFirmwareUpdate = typeof firmwareUpdates.$inferInsert;

/**
 * System diagnostics table - stores periodic health snapshots from companion computers.
 * Pi reports CPU, memory, disk, temperature, and service status.
 */
export const systemDiagnostics = sqliteTable("systemDiagnostics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Drone/companion this diagnostic belongs to */
  droneId: text("droneId").notNull(),
  /** CPU usage percentage */
  cpuPercent: integer("cpuPercent"),
  /** Memory usage percentage */
  memoryPercent: integer("memoryPercent"),
  /** Disk usage percentage */
  diskPercent: integer("diskPercent"),
  /** CPU temperature in Celsius */
  cpuTempC: integer("cpuTempC"),
  /** Uptime in seconds */
  uptimeSeconds: integer("uptimeSeconds"),
  /** Service statuses (JSON: {serviceName: "active"|"inactive"|"failed"}) */
  services: text("services", { mode: "json" }),
  /** Network info (JSON: {interface: {ip, rx_bytes, tx_bytes}}) */
  network: text("network", { mode: "json" }),
  /** When this snapshot was taken */
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type SystemDiagnostic = typeof systemDiagnostics.$inferSelect;
export type InsertSystemDiagnostic = typeof systemDiagnostics.$inferInsert;
