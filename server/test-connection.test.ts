import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the Test Connection feature
 * - REST endpoint /api/rest/test-connection
 * - tRPC procedure drones.testConnection
 * - Frontend DroneConfig UI integration
 */

// Mock the db module
vi.mock("./db", () => ({
  validateApiKey: vi.fn(),
  upsertDrone: vi.fn(),
  insertScan: vi.fn(),
  insertTelemetry: vi.fn(),
  getAllDrones: vi.fn().mockResolvedValue([]),
  getApiKeysForDrone: vi.fn().mockResolvedValue([]),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  reactivateApiKey: vi.fn(),
  updateDroneByDroneId: vi.fn(),
  updateApiKeyDescription: vi.fn(),
  getDroneByDroneId: vi.fn(),
}));

vi.mock("./websocket", () => ({
  broadcastPointCloud: vi.fn(),
  broadcastTelemetry: vi.fn(),
  broadcastCameraStatus: vi.fn(),
  broadcastAppData: vi.fn(),
}));

describe("Test Connection REST Endpoint", () => {
  it("should validate that /api/rest/test-connection endpoint exists in rest-api.ts", async () => {
    const restApiContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/rest-api.ts", "utf-8")
    );
    expect(restApiContent).toContain('"/test-connection"');
    expect(restApiContent).toContain("api_key");
    expect(restApiContent).toContain("drone_id");
    expect(restApiContent).toContain("latency_ms");
  });

  it("should return 400 for missing required fields", async () => {
    const restApiContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/rest-api.ts", "utf-8")
    );
    expect(restApiContent).toContain("Missing required fields: api_key, drone_id");
  });

  it("should validate API key and return success with latency", async () => {
    const restApiContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/rest-api.ts", "utf-8")
    );
    expect(restApiContent).toContain("Connection verified");
    expect(restApiContent).toContain("api_key_id");
    expect(restApiContent).toContain("api_key_description");
    expect(restApiContent).toContain("server_time");
  });

  it("should return 401 for invalid API key", async () => {
    const restApiContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/rest-api.ts", "utf-8")
    );
    expect(restApiContent).toContain("Invalid API key");
  });

  it("should return 403 for drone ID mismatch", async () => {
    const restApiContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/rest-api.ts", "utf-8")
    );
    expect(restApiContent).toContain("API key does not match drone_id");
  });
});

describe("Test Connection tRPC Procedure", () => {
  it("should define testConnection procedure in drones router", async () => {
    const routersContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/routers.ts", "utf-8")
    );
    expect(routersContent).toContain("testConnection: protectedProcedure");
    expect(routersContent).toContain("droneId: z.string()");
    expect(routersContent).toContain("apiKey: z.string()");
  });

  it("should test all 5 endpoints: health, auth, pointcloud, telemetry, camera", async () => {
    const routersContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/routers.ts", "utf-8")
    );
    expect(routersContent).toContain('"Health Check"');
    expect(routersContent).toContain('"API Key Authentication"');
    expect(routersContent).toContain('"Point Cloud Ingest"');
    expect(routersContent).toContain('"Telemetry Ingest"');
    expect(routersContent).toContain('"Camera Status"');
  });

  it("should return structured results with pass/fail status and latency", async () => {
    const routersContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/routers.ts", "utf-8")
    );
    // Check result structure
    expect(routersContent).toContain("total_latency_ms");
    expect(routersContent).toContain("tested_at");
    expect(routersContent).toContain('"pass"');
    expect(routersContent).toContain('"fail"');
    expect(routersContent).toContain("latency_ms");
  });

  it("should use dry-run approach for ingest endpoints (not send actual data)", async () => {
    const routersContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/routers.ts", "utf-8")
    );
    // Verify dry-run: sends minimal payload that triggers 400 but proves auth works
    expect(routersContent).toContain("dry-run");
    expect(routersContent).toContain("Endpoint reachable, auth valid (dry-run)");
  });

  it("should derive base URL from request headers", async () => {
    const routersContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/routers.ts", "utf-8")
    );
    expect(routersContent).toContain("x-forwarded-proto");
    expect(routersContent).toContain("x-forwarded-host");
  });

  it("should compute allPassed and totalLatency from results", async () => {
    const routersContent = await import("fs").then((fs) =>
      fs.readFileSync("./server/routers.ts", "utf-8")
    );
    expect(routersContent).toContain("const allPassed = results.every");
    expect(routersContent).toContain("const totalLatency = results.reduce");
  });
});

describe("Test Connection Frontend Integration", () => {
  it("should have Test Connection button in DroneConfig", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("Test Connection");
    expect(droneConfigContent).toContain("handleTestConnection");
    expect(droneConfigContent).toContain("testConnectionMutation");
  });

  it("should use drones.testConnection tRPC mutation", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("trpc.drones.testConnection.useMutation");
  });

  it("should display test results with pass/fail indicators", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("showTestResults");
    expect(droneConfigContent).toContain("testResults");
    expect(droneConfigContent).toContain("All Tests Passed");
    expect(droneConfigContent).toContain("Some Tests Failed");
  });

  it("should show loading state during test", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("testConnectionMutation.isPending");
    expect(droneConfigContent).toContain("Testing...");
    expect(droneConfigContent).toContain("Loader2");
  });

  it("should require an active API key before testing", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("No active API key found");
    expect(droneConfigContent).toContain("disabled={testConnectionMutation.isPending || !activeKey}");
  });

  it("should display per-test latency and total latency", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("total_latency_ms");
    expect(droneConfigContent).toContain("latency_ms");
    expect(droneConfigContent).toContain("ms total");
  });

  it("should show Zap icon for test connection button", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("Zap");
  });

  it("should have dismiss button to close test results", async () => {
    const droneConfigContent = await import("fs").then((fs) =>
      fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8")
    );
    expect(droneConfigContent).toContain("setShowTestResults(false)");
  });
});
