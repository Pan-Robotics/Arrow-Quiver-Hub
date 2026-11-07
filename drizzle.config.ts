import { defineConfig } from "drizzle-kit";
import path from "node:path";

/**
 * Local SQLite configuration. The database file defaults to <project>/data/quiver.db
 * (matching server/db.ts) and can be overridden with DATABASE_URL (a filesystem path
 * or a "file:" URL).
 */
const dbFile = (process.env.DATABASE_URL?.trim() || "data/quiver.db")
  .replace(/^file:/, "")
  .replace(/^sqlite:(\/\/)?/, "");

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: path.isAbsolute(dbFile) ? dbFile : path.resolve(process.cwd(), dbFile),
  },
});
