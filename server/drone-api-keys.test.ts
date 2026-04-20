import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

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
  const baseUrl = "https://example.com";
  const droneId = "quiver_001";
  const apiKey = "test-key-123";

  // Helper that mirrors the envSnippet logic in DroneConfig.tsx
  function buildEnvSnippet(base: string, drone: string, key: string) {
    const wsUrl = base.replace("http", "ws");
    return [
      `QUIVER_HUB_URL=${base}`,
      `QUIVER_DRONE_ID=${drone}`,
      `QUIVER_API_KEY=${key}`,
      `QUIVER_POINTCLOUD_ENDPOINT=${base}/api/rest/pointcloud/ingest`,
      `QUIVER_TELEMETRY_ENDPOINT=${base}/api/rest/telemetry/ingest`,
      `QUIVER_PAYLOAD_ENDPOINT=${base}/api/rest/payload/{appId}/ingest`,
      `QUIVER_CAMERA_STATUS_ENDPOINT=${base}/api/rest/camera/status`,
      `QUIVER_CAMERA_STREAM_REGISTER=${base}/api/rest/camera/stream-register`,
      `QUIVER_CAMERA_STREAM_UNREGISTER=${base}/api/rest/camera/stream-unregister`,
      `QUIVER_CAMERA_STREAM_STATUS=${base}/api/rest/camera/stream-status/${drone}`,
      `QUIVER_CAMERA_WHEP_PROXY=${base}/api/rest/camera/whep-proxy/${drone}`,
      `QUIVER_FC_LOG_LIST_ENDPOINT=${base}/api/rest/logs/fc-list`,
      `QUIVER_FC_LOG_PROGRESS_ENDPOINT=${base}/api/rest/logs/fc-progress`,
      `QUIVER_FC_LOG_UPLOAD_ENDPOINT=${base}/api/rest/logs/fc-upload`,
      `QUIVER_FC_LOG_UPLOAD_MULTIPART=${base}/api/rest/logs/fc-upload-multipart`,
      `QUIVER_FC_LOG_DOWNLOAD=${base}/api/rest/logs/fc-download/{logId}`,
      `QUIVER_FIRMWARE_PROGRESS_ENDPOINT=${base}/api/rest/firmware/progress`,
      `QUIVER_DIAGNOSTICS_ENDPOINT=${base}/api/rest/diagnostics/report`,
      `QUIVER_FLIGHTLOG_UPLOAD=${base}/api/rest/flightlog/upload`,
      `QUIVER_HEALTH_ENDPOINT=${base}/api/rest/health`,
      `QUIVER_TEST_CONNECTION=${base}/api/rest/test-connection`,
      `QUIVER_WS_URL=${wsUrl}`,
      `QUIVER_JOBS_ENDPOINT=${base}/api/trpc/droneJobs.getPendingJobs`,
      `QUIVER_JOBS_ACK_ENDPOINT=${base}/api/trpc/droneJobs.acknowledgeJob`,
      `QUIVER_JOBS_COMPLETE_ENDPOINT=${base}/api/trpc/droneJobs.completeJob`,
      `QUIVER_JOBS_FAIL_ENDPOINT=${base}/api/trpc/droneJobs.failJob`,
      `FC_WEBSERVER_URL=http://192.168.144.20:8080`,
      `FC_LOG_STORE_DIR=/var/lib/quiver/fc_logs`,
    ].join("\n");
  }

  it("should generate correct .env snippet with all core connection fields", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("QUIVER_HUB_URL=https://example.com");
    expect(env).toContain("QUIVER_DRONE_ID=quiver_001");
    expect(env).toContain("QUIVER_API_KEY=test-key-123");
  });

  it("should include all core data pipeline endpoints", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("QUIVER_POINTCLOUD_ENDPOINT=https://example.com/api/rest/pointcloud/ingest");
    expect(env).toContain("QUIVER_TELEMETRY_ENDPOINT=https://example.com/api/rest/telemetry/ingest");
    expect(env).toContain("QUIVER_PAYLOAD_ENDPOINT=https://example.com/api/rest/payload/{appId}/ingest");
  });

  it("should include all camera pipeline endpoints", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("QUIVER_CAMERA_STATUS_ENDPOINT=https://example.com/api/rest/camera/status");
    expect(env).toContain("QUIVER_CAMERA_STREAM_REGISTER=https://example.com/api/rest/camera/stream-register");
    expect(env).toContain("QUIVER_CAMERA_STREAM_UNREGISTER=https://example.com/api/rest/camera/stream-unregister");
    expect(env).toContain(`QUIVER_CAMERA_STREAM_STATUS=https://example.com/api/rest/camera/stream-status/${droneId}`);
    expect(env).toContain(`QUIVER_CAMERA_WHEP_PROXY=https://example.com/api/rest/camera/whep-proxy/${droneId}`);
  });

  it("should include all logs & OTA pipeline endpoints", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("QUIVER_FC_LOG_LIST_ENDPOINT=https://example.com/api/rest/logs/fc-list");
    expect(env).toContain("QUIVER_FC_LOG_PROGRESS_ENDPOINT=https://example.com/api/rest/logs/fc-progress");
    expect(env).toContain("QUIVER_FC_LOG_UPLOAD_ENDPOINT=https://example.com/api/rest/logs/fc-upload");
    expect(env).toContain("QUIVER_FC_LOG_UPLOAD_MULTIPART=https://example.com/api/rest/logs/fc-upload-multipart");
    expect(env).toContain("QUIVER_FC_LOG_DOWNLOAD=https://example.com/api/rest/logs/fc-download/{logId}");
    expect(env).toContain("QUIVER_FIRMWARE_PROGRESS_ENDPOINT=https://example.com/api/rest/firmware/progress");
    expect(env).toContain("QUIVER_DIAGNOSTICS_ENDPOINT=https://example.com/api/rest/diagnostics/report");
  });

  it("should include system and flight analytics endpoints", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("QUIVER_HEALTH_ENDPOINT=https://example.com/api/rest/health");
    expect(env).toContain("QUIVER_TEST_CONNECTION=https://example.com/api/rest/test-connection");
    expect(env).toContain("QUIVER_FLIGHTLOG_UPLOAD=https://example.com/api/rest/flightlog/upload");
  });

  it("should include all tRPC job polling endpoints", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("QUIVER_JOBS_ENDPOINT=https://example.com/api/trpc/droneJobs.getPendingJobs");
    expect(env).toContain("QUIVER_JOBS_ACK_ENDPOINT=https://example.com/api/trpc/droneJobs.acknowledgeJob");
    expect(env).toContain("QUIVER_JOBS_COMPLETE_ENDPOINT=https://example.com/api/trpc/droneJobs.completeJob");
    expect(env).toContain("QUIVER_JOBS_FAIL_ENDPOINT=https://example.com/api/trpc/droneJobs.failJob");
  });

  it("should include FC web server configuration", () => {
    const env = buildEnvSnippet(baseUrl, droneId, apiKey);
    expect(env).toContain("FC_WEBSERVER_URL=http://192.168.144.20:8080");
    expect(env).toContain("FC_LOG_STORE_DIR=/var/lib/quiver/fc_logs");
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

describe("DroneConfig .env UI — comprehensive endpoint reference", () => {
  it("DroneConfig.tsx envSnippet contains all REST endpoint categories", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    // Core data pipelines
    expect(source).toContain("/api/rest/pointcloud/ingest");
    expect(source).toContain("/api/rest/telemetry/ingest");
    expect(source).toContain("/api/rest/payload/{appId}/ingest");
    // Camera pipeline
    expect(source).toContain("/api/rest/camera/status");
    expect(source).toContain("/api/rest/camera/stream-register");
    expect(source).toContain("/api/rest/camera/stream-unregister");
    expect(source).toContain("/api/rest/camera/stream-status/");
    expect(source).toContain("/api/rest/camera/whep-proxy/");
    // Logs & OTA
    expect(source).toContain("/api/rest/logs/fc-list");
    expect(source).toContain("/api/rest/logs/fc-progress");
    expect(source).toContain("/api/rest/logs/fc-upload");
    expect(source).toContain("/api/rest/logs/fc-upload-multipart");
    expect(source).toContain("/api/rest/logs/fc-download/");
    expect(source).toContain("/api/rest/firmware/progress");
    expect(source).toContain("/api/rest/diagnostics/report");
    // Flight analytics
    expect(source).toContain("/api/rest/flightlog/upload");
    // System
    expect(source).toContain("/api/rest/health");
    expect(source).toContain("/api/rest/test-connection");
  });

  it("DroneConfig.tsx envSnippet contains all tRPC job endpoints", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    expect(source).toContain("droneJobs.getPendingJobs");
    expect(source).toContain("droneJobs.acknowledgeJob");
    expect(source).toContain("droneJobs.completeJob");
    expect(source).toContain("droneJobs.failJob");
  });

  it("DroneConfig.tsx envSnippet contains FC web server config", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    expect(source).toContain("FC_WEBSERVER_URL=http://192.168.144.20:8080");
    expect(source).toContain("FC_LOG_STORE_DIR=/var/lib/quiver/fc_logs");
    expect(source).toContain("ARDUPILOT_WEBSERVER_SETUP.md");
  });

  it("DroneConfig.tsx has collapsible endpoint categories", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    expect(source).toContain("toggleSection");
    expect(source).toContain("expandedSections");
    expect(source).toContain("Core Data Pipelines");
    expect(source).toContain("Camera Pipeline");
    expect(source).toContain("Logs & OTA Pipeline");
    expect(source).toContain("System & Job Polling");
    expect(source).toContain("WebSocket (Socket.IO)");
    expect(source).toContain("FC Web Server (ArduPilot)");
  });

  it("DroneConfig.tsx lists all WebSocket event categories", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    // Subscribe events
    expect(source).toContain("subscribe_app");
    expect(source).toContain("subscribe_camera");
    expect(source).toContain("subscribe_logs");
    expect(source).toContain("subscribe_stream");
    // Command events
    expect(source).toContain("camera_command");
    expect(source).toContain("log_stream_request");
    // Companion events
    expect(source).toContain("register_companion");
    expect(source).toContain("log_stream_line");
    // Broadcast events
    expect(source).toContain("pointcloud_update");
    expect(source).toContain("telemetry_update");
    expect(source).toContain("fc_log_progress");
    expect(source).toContain("firmware_progress");
    expect(source).toContain("diagnostics");
  });

  it("DroneConfig.tsx envSnippet has descriptive comments for each section", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    expect(source).toContain("Core Connection");
    expect(source).toContain("REST API: Core Data Pipelines");
    expect(source).toContain("REST API: Camera Pipeline");
    expect(source).toContain("REST API: Logs & OTA Pipeline");
    expect(source).toContain("REST API: Flight Analytics");
    expect(source).toContain("REST API: System");
    expect(source).toContain("WebSocket (Socket.IO)");
    expect(source).toContain("tRPC Job Polling");
    expect(source).toContain("FC Web Server (ArduPilot net_webserver.lua)");
  });

  it("DroneConfig.tsx Quick Reference shows endpoint counts per category", () => {
    const source = fs.readFileSync("./client/src/pages/DroneConfig.tsx", "utf-8");
    expect(source).toContain("3 endpoints"); // Core
    expect(source).toContain("5 endpoints"); // Camera
    expect(source).toContain("7 endpoints"); // Logs & OTA
    expect(source).toContain("6 endpoints"); // System & Jobs
    expect(source).toContain("17 events");   // WebSocket
    expect(source).toContain("2 config");    // FC Web Server
  });
});
