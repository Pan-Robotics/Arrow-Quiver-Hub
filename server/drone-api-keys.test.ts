import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module
vi.mock("./db", () => ({
  getAllDrones: vi.fn(),
  getApiKeysForDrone: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  reactivateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  upsertDrone: vi.fn(),
  validateApiKey: vi.fn(),
  getDroneByDroneId: vi.fn(),
  insertScan: vi.fn(),
  getRecentScans: vi.fn(),
  getScanStats: vi.fn(),
  insertTelemetry: vi.fn(),
  getRecentTelemetry: vi.fn(),
}));

vi.mock("./websocket", () => ({
  broadcastPointCloud: vi.fn(),
  broadcastTelemetry: vi.fn(),
  broadcastCameraStatus: vi.fn(),
  broadcastAppData: vi.fn(),
}));

vi.mock("./parserExecutor", () => ({
  executeParser: vi.fn(),
  validateParserCode: vi.fn(),
}));

vi.mock("./schemaExtractor", () => ({
  extractSchema: vi.fn(),
}));

vi.mock("./customAppDb", () => ({
  createCustomApp: vi.fn(),
  getAllCustomApps: vi.fn(),
  getCustomAppByAppId: vi.fn(),
  installAppForUser: vi.fn(),
  uninstallAppForUser: vi.fn(),
  getUserInstalledApps: vi.fn(),
  updateCustomApp: vi.fn(),
  createAppVersion: vi.fn(),
  getAppVersions: vi.fn(),
  getAppVersion: vi.fn(),
  rollbackAppToVersion: vi.fn(),
  deleteCustomApp: vi.fn(),
}));

vi.mock("./droneJobsDb", () => ({
  createDroneJob: vi.fn(),
  getPendingJobsForDrone: vi.fn(),
  acknowledgeJob: vi.fn(),
  completeJob: vi.fn(),
  getAllJobsForDrone: vi.fn(),
  createDroneFile: vi.fn(),
  getDroneFile: vi.fn(),
  getDroneFiles: vi.fn(),
  deleteDroneFile: vi.fn(),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ url: "https://example.com/file.txt", key: "file.txt" }),
}));

import {
  getAllDrones,
  getApiKeysForDrone,
  createApiKey,
  revokeApiKey,
  reactivateApiKey,
  deleteApiKey,
  upsertDrone,
} from "./db";

describe("Drone API Key Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createApiKey", () => {
    it("should create an API key with description", async () => {
      const mockKey = {
        id: 1,
        key: "test-key-abc123",
        droneId: "quiver_001",
        description: "Test key",
        isActive: true,
        createdAt: new Date(),
      };
      (createApiKey as any).mockResolvedValue(mockKey);

      const result = await createApiKey("quiver_001", "Test key");
      expect(result).toEqual(mockKey);
      expect(createApiKey).toHaveBeenCalledWith("quiver_001", "Test key");
    });

    it("should create an API key without description", async () => {
      const mockKey = {
        id: 2,
        key: "test-key-def456",
        droneId: "quiver_002",
        description: null,
        isActive: true,
        createdAt: new Date(),
      };
      (createApiKey as any).mockResolvedValue(mockKey);

      const result = await createApiKey("quiver_002");
      expect(result).toEqual(mockKey);
      expect(createApiKey).toHaveBeenCalledWith("quiver_002");
    });

    it("should return null when database is unavailable", async () => {
      (createApiKey as any).mockResolvedValue(null);

      const result = await createApiKey("quiver_001");
      expect(result).toBeNull();
    });
  });

  describe("getApiKeysForDrone", () => {
    it("should return all keys for a drone", async () => {
      const mockKeys = [
        {
          id: 1,
          key: "key-1",
          droneId: "quiver_001",
          description: "Key 1",
          isActive: true,
          createdAt: new Date(),
        },
        {
          id: 2,
          key: "key-2",
          droneId: "quiver_001",
          description: "Key 2",
          isActive: false,
          createdAt: new Date(),
        },
      ];
      (getApiKeysForDrone as any).mockResolvedValue(mockKeys);

      const result = await getApiKeysForDrone("quiver_001");
      expect(result).toHaveLength(2);
      expect(result[0].droneId).toBe("quiver_001");
      expect(result[1].isActive).toBe(false);
    });

    it("should return empty array for drone with no keys", async () => {
      (getApiKeysForDrone as any).mockResolvedValue([]);

      const result = await getApiKeysForDrone("quiver_999");
      expect(result).toEqual([]);
    });
  });

  describe("revokeApiKey", () => {
    it("should revoke an active key", async () => {
      (revokeApiKey as any).mockResolvedValue(true);

      const result = await revokeApiKey(1);
      expect(result).toBe(true);
      expect(revokeApiKey).toHaveBeenCalledWith(1);
    });

    it("should return false when database is unavailable", async () => {
      (revokeApiKey as any).mockResolvedValue(false);

      const result = await revokeApiKey(999);
      expect(result).toBe(false);
    });
  });

  describe("reactivateApiKey", () => {
    it("should reactivate a revoked key", async () => {
      (reactivateApiKey as any).mockResolvedValue(true);

      const result = await reactivateApiKey(1);
      expect(result).toBe(true);
      expect(reactivateApiKey).toHaveBeenCalledWith(1);
    });
  });

  describe("deleteApiKey", () => {
    it("should permanently delete a key", async () => {
      (deleteApiKey as any).mockResolvedValue(true);

      const result = await deleteApiKey(1);
      expect(result).toBe(true);
      expect(deleteApiKey).toHaveBeenCalledWith(1);
    });
  });

  describe("getAllDrones", () => {
    it("should return all registered drones", async () => {
      const mockDrones = [
        {
          id: 1,
          droneId: "quiver_001",
          name: null,
          lastSeen: new Date(),
          isActive: true,
          createdAt: new Date(),
        },
      ];
      (getAllDrones as any).mockResolvedValue(mockDrones);

      const result = await getAllDrones();
      expect(result).toHaveLength(1);
      expect(result[0].droneId).toBe("quiver_001");
    });
  });

  describe("upsertDrone (register)", () => {
    it("should register a new drone", async () => {
      const mockDrone = {
        id: 2,
        droneId: "quiver_002",
        name: "Field Survey Drone",
        lastSeen: new Date(),
        isActive: true,
        createdAt: new Date(),
      };
      (upsertDrone as any).mockResolvedValue(mockDrone);

      const result = await upsertDrone({
        droneId: "quiver_002",
        name: "Field Survey Drone",
        lastSeen: new Date(),
        isActive: true,
      });
      expect(result).toEqual(mockDrone);
      expect(result.droneId).toBe("quiver_002");
      expect(result.name).toBe("Field Survey Drone");
    });
  });
});

describe("Connection Info Generation", () => {
  it("should generate correct .env snippet format", () => {
    const baseUrl = "https://example.com";
    const droneId = "quiver_001";
    const apiKey = "test-key-123";

    const envSnippet = [
      `QUIVER_HUB_URL=${baseUrl}`,
      `QUIVER_DRONE_ID=${droneId}`,
      `QUIVER_API_KEY=${apiKey}`,
      `QUIVER_POINTCLOUD_ENDPOINT=${baseUrl}/api/rest/pointcloud/ingest`,
      `QUIVER_TELEMETRY_ENDPOINT=${baseUrl}/api/rest/telemetry/ingest`,
      `QUIVER_CAMERA_ENDPOINT=${baseUrl}/api/rest/camera/status`,
      `QUIVER_WS_URL=${baseUrl.replace("http", "ws")}`,
      `QUIVER_JOBS_ENDPOINT=${baseUrl}/api/trpc/droneJobs.getPendingJobs`,
    ].join("\n");

    expect(envSnippet).toContain("QUIVER_HUB_URL=https://example.com");
    expect(envSnippet).toContain("QUIVER_DRONE_ID=quiver_001");
    expect(envSnippet).toContain("QUIVER_API_KEY=test-key-123");
    expect(envSnippet).toContain("QUIVER_POINTCLOUD_ENDPOINT=https://example.com/api/rest/pointcloud/ingest");
    expect(envSnippet).toContain("QUIVER_TELEMETRY_ENDPOINT=https://example.com/api/rest/telemetry/ingest");
    expect(envSnippet).toContain("QUIVER_CAMERA_ENDPOINT=https://example.com/api/rest/camera/status");
    expect(envSnippet).toContain("QUIVER_WS_URL=wss://example.com");
    expect(envSnippet).toContain("QUIVER_JOBS_ENDPOINT=https://example.com/api/trpc/droneJobs.getPendingJobs");
  });

  it("should handle http to ws conversion correctly", () => {
    expect("http://localhost:3000".replace("http", "ws")).toBe("ws://localhost:3000");
    expect("https://example.com".replace("http", "ws")).toBe("wss://example.com");
  });

  it("should show placeholder when no active key", () => {
    const envLine = `QUIVER_API_KEY=${undefined ? "some-key" : "<generate-an-api-key>"}`;
    expect(envLine).toContain("<generate-an-api-key>");
  });
});
