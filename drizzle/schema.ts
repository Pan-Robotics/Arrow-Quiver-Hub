import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

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
