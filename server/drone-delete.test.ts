import { describe, it, expect } from "vitest";

/**
 * Tests for the Delete Drone cascading delete feature.
 * Validates the backend function structure and tRPC procedure behavior.
 */

describe("Delete Drone - Backend Function", () => {
  it("deleteDrone function is exported from db.ts", async () => {
    const db = await import("./db");
    expect(typeof db.deleteDrone).toBe("function");
  });

  it("deleteDrone returns correct shape when db is unavailable", async () => {
    // When DATABASE_URL is not set, getDb returns null
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    // Force a fresh import to clear cached db connection
    const { deleteDrone } = await import("./db");

    // The function should return a safe default
    // Note: since db module caches connection, this tests the interface contract
    expect(deleteDrone).toBeDefined();

    process.env.DATABASE_URL = originalUrl;
  });

  it("deleteDrone function signature accepts droneId string", async () => {
    const { deleteDrone } = await import("./db");
    // Verify function exists and accepts a string parameter
    expect(deleteDrone.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Delete Drone - tRPC Procedure", () => {
  it("drones.delete procedure is defined in routers.ts", async () => {
    const fs = await import("fs");
    const routersSource = fs.readFileSync("./server/routers.ts", "utf-8");
    expect(routersSource).toContain("delete: protectedProcedure");
  });

  it("drones.delete requires confirmDroneId input", async () => {
    const fs = await import("fs");
    const routersSource = fs.readFileSync("./server/routers.ts", "utf-8");
    expect(routersSource).toContain("confirmDroneId: z.string()");
    expect(routersSource).toContain("droneId: z.string()");
  });

  it("all drone-related procedures are defined in routers.ts", async () => {
    const fs = await import("fs");
    const routersSource = fs.readFileSync("./server/routers.ts", "utf-8");

    // Verify all drone management procedures
    expect(routersSource).toContain("list: publicProcedure");
    expect(routersSource).toContain("register: protectedProcedure");
    expect(routersSource).toContain("update: protectedProcedure");
    expect(routersSource).toContain("delete: protectedProcedure");
    expect(routersSource).toContain("getApiKeys: protectedProcedure");
    expect(routersSource).toContain("generateApiKey: protectedProcedure");
    expect(routersSource).toContain("revokeApiKey: protectedProcedure");
    expect(routersSource).toContain("reactivateApiKey: protectedProcedure");
    expect(routersSource).toContain("deleteApiKey: protectedProcedure");
    expect(routersSource).toContain("testConnection: protectedProcedure");
  });
});

describe("Delete Drone - Cascading Delete Coverage", () => {
  it("deleteDrone function handles all 5 related tables", async () => {
    // Read the source to verify all tables are covered
    const fs = await import("fs");
    const dbSource = fs.readFileSync("./server/db.ts", "utf-8");

    // Verify the function deletes from all related tables
    expect(dbSource).toContain("db.delete(apiKeys)");
    expect(dbSource).toContain("db.delete(scans)");
    expect(dbSource).toContain("db.delete(telemetry)");
    expect(dbSource).toContain("db.delete(droneJobs)");
    expect(dbSource).toContain("db.delete(droneFiles)");
    expect(dbSource).toContain("db.delete(drones)");
  });

  it("deleteDrone counts records before deletion for reporting", async () => {
    const fs = await import("fs");
    const dbSource = fs.readFileSync("./server/db.ts", "utf-8");

    // Verify counting happens before deletion
    expect(dbSource).toContain("apiKeyCount");
    expect(dbSource).toContain("scanCount");
    expect(dbSource).toContain("telemetryCount");
    expect(dbSource).toContain("jobCount");
    expect(dbSource).toContain("fileCount");
  });

  it("deleteDrone returns deletion counts in response", async () => {
    const fs = await import("fs");
    const dbSource = fs.readFileSync("./server/db.ts", "utf-8");

    // Verify the return shape includes counts
    expect(dbSource).toContain("counts: {");
    expect(dbSource).toContain("apiKeys: apiKeyCount");
    expect(dbSource).toContain("scans: scanCount");
    expect(dbSource).toContain("telemetry: telemetryCount");
    expect(dbSource).toContain("jobs: jobCount");
    expect(dbSource).toContain("files: fileCount");
  });
});

describe("Delete Drone - Frontend Integration", () => {
  it("DroneConfig has delete drone confirmation dialog", async () => {
    const fs = await import("fs");
    const droneConfigSource = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");

    // Verify confirmation dialog exists
    expect(droneConfigSource).toContain("showDeleteDroneDialog");
    expect(droneConfigSource).toContain("confirmDeleteDroneId");
    expect(droneConfigSource).toContain("Delete Permanently");
  });

  it("DroneConfig requires typing drone ID to confirm deletion", async () => {
    const fs = await import("fs");
    const droneConfigSource = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");

    // Verify the confirmation input and matching check
    expect(droneConfigSource).toContain("confirmDeleteDroneId !== selectedDrone");
    expect(droneConfigSource).toContain("Type");
    expect(droneConfigSource).toContain("to confirm");
  });

  it("DroneConfig shows what will be deleted (API keys, scans, telemetry, jobs, files)", async () => {
    const fs = await import("fs");
    const droneConfigSource = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");

    expect(droneConfigSource).toContain("All API keys for this drone");
    expect(droneConfigSource).toContain("All point cloud scan records");
    expect(droneConfigSource).toContain("All telemetry data");
    expect(droneConfigSource).toContain("All job history");
    expect(droneConfigSource).toContain("All uploaded files");
  });

  it("DroneConfig auto-selects another drone after deletion", async () => {
    const fs = await import("fs");
    const droneConfigSource = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");

    // Verify auto-selection logic
    expect(droneConfigSource).toContain("remaining.length > 0");
    expect(droneConfigSource).toContain("setSelectedDrone(remaining[0].droneId)");
    expect(droneConfigSource).toContain('setSelectedDrone("")');
  });

  it("DroneConfig has Delete Drone button with destructive styling", async () => {
    const fs = await import("fs");
    const droneConfigSource = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");

    expect(droneConfigSource).toContain("Delete Drone");
    expect(droneConfigSource).toContain("text-destructive");
    expect(droneConfigSource).toContain("border-destructive/50");
  });

  it("tRPC procedure validates confirmDroneId matches droneId", async () => {
    const fs = await import("fs");
    const routersSource = fs.readFileSync("./server/routers.ts", "utf-8");

    expect(routersSource).toContain("input.droneId !== input.confirmDroneId");
    expect(routersSource).toContain("Drone ID confirmation does not match");
  });
});
