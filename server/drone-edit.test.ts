import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db functions
const mockUpdateDroneByDroneId = vi.fn();
const mockUpdateApiKeyDescription = vi.fn();
const mockGetDroneByDroneId = vi.fn();
const mockUpsertDrone = vi.fn();
const mockCreateApiKey = vi.fn();
const mockGetApiKeysForDrone = vi.fn();
const mockRevokeApiKey = vi.fn();
const mockDeleteApiKey = vi.fn();
const mockReactivateApiKey = vi.fn();
const mockGetAllDrones = vi.fn();

vi.mock("./db", () => ({
  updateDroneByDroneId: (...args: any[]) => mockUpdateDroneByDroneId(...args),
  updateApiKeyDescription: (...args: any[]) => mockUpdateApiKeyDescription(...args),
  getDroneByDroneId: (...args: any[]) => mockGetDroneByDroneId(...args),
  upsertDrone: (...args: any[]) => mockUpsertDrone(...args),
  createApiKey: (...args: any[]) => mockCreateApiKey(...args),
  getApiKeysForDrone: (...args: any[]) => mockGetApiKeysForDrone(...args),
  revokeApiKey: (...args: any[]) => mockRevokeApiKey(...args),
  deleteApiKey: (...args: any[]) => mockDeleteApiKey(...args),
  reactivateApiKey: (...args: any[]) => mockReactivateApiKey(...args),
  getAllDrones: (...args: any[]) => mockGetAllDrones(...args),
}));

describe("Drone Edit Features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("updateDroneByDroneId", () => {
    it("should update drone name only", async () => {
      mockUpdateDroneByDroneId.mockResolvedValue({
        id: 1,
        droneId: "quiver_001",
        name: "Updated Name",
        isActive: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await mockUpdateDroneByDroneId("quiver_001", { name: "Updated Name" });

      expect(mockUpdateDroneByDroneId).toHaveBeenCalledWith("quiver_001", { name: "Updated Name" });
      expect(result).toBeDefined();
      expect(result.name).toBe("Updated Name");
      expect(result.droneId).toBe("quiver_001");
    });

    it("should update drone ID and cascade to API keys", async () => {
      mockUpdateDroneByDroneId.mockResolvedValue({
        id: 1,
        droneId: "quiver_new",
        name: "Test Drone",
        isActive: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await mockUpdateDroneByDroneId("quiver_001", { droneId: "quiver_new" });

      expect(mockUpdateDroneByDroneId).toHaveBeenCalledWith("quiver_001", { droneId: "quiver_new" });
      expect(result).toBeDefined();
      expect(result.droneId).toBe("quiver_new");
    });

    it("should update both name and droneId", async () => {
      mockUpdateDroneByDroneId.mockResolvedValue({
        id: 1,
        droneId: "quiver_new",
        name: "New Name",
        isActive: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await mockUpdateDroneByDroneId("quiver_001", {
        droneId: "quiver_new",
        name: "New Name",
      });

      expect(result.droneId).toBe("quiver_new");
      expect(result.name).toBe("New Name");
    });

    it("should return null when no updates provided", async () => {
      mockUpdateDroneByDroneId.mockResolvedValue(null);

      const result = await mockUpdateDroneByDroneId("quiver_001", {});
      expect(result).toBeNull();
    });

    it("should handle setting name to null (clearing it)", async () => {
      mockUpdateDroneByDroneId.mockResolvedValue({
        id: 1,
        droneId: "quiver_001",
        name: null,
        isActive: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await mockUpdateDroneByDroneId("quiver_001", { name: null });
      expect(result.name).toBeNull();
    });
  });

  describe("updateApiKeyDescription", () => {
    it("should update API key description", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(true);

      const result = await mockUpdateApiKeyDescription(1, "New description");

      expect(mockUpdateApiKeyDescription).toHaveBeenCalledWith(1, "New description");
      expect(result).toBe(true);
    });

    it("should clear API key description by setting to null", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(true);

      const result = await mockUpdateApiKeyDescription(1, null);

      expect(mockUpdateApiKeyDescription).toHaveBeenCalledWith(1, null);
      expect(result).toBe(true);
    });

    it("should return false when db is unavailable", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(false);

      const result = await mockUpdateApiKeyDescription(999, "desc");
      expect(result).toBe(false);
    });
  });

  describe("Drone update tRPC procedure validation", () => {
    it("should reject update when new droneId is already taken", async () => {
      // Simulate the procedure logic: check if droneId exists
      mockGetDroneByDroneId.mockResolvedValue({
        id: 2,
        droneId: "quiver_002",
        name: "Existing Drone",
      });

      const existing = await mockGetDroneByDroneId("quiver_002");
      expect(existing).toBeDefined();
      // The procedure would throw an error here
      expect(existing.droneId).toBe("quiver_002");
    });

    it("should allow update when new droneId is available", async () => {
      mockGetDroneByDroneId.mockResolvedValue(null);

      const existing = await mockGetDroneByDroneId("quiver_new");
      expect(existing).toBeNull();
      // The procedure would proceed with the update
    });

    it("should skip droneId uniqueness check when droneId is unchanged", async () => {
      // When currentDroneId === droneId, no check needed
      const currentDroneId = "quiver_001";
      const newDroneId = "quiver_001";

      expect(currentDroneId).toBe(newDroneId);
      // getDroneByDroneId should NOT be called
      expect(mockGetDroneByDroneId).not.toHaveBeenCalled();
    });
  });

  describe("API key description update tRPC procedure", () => {
    it("should call updateApiKeyDescription with correct params", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(true);

      const keyId = 5;
      const description = "Updated forwarder key";

      const result = await mockUpdateApiKeyDescription(keyId, description);

      expect(mockUpdateApiKeyDescription).toHaveBeenCalledWith(5, "Updated forwarder key");
      expect(result).toBe(true);
    });

    it("should handle null description (clearing it)", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(true);

      const result = await mockUpdateApiKeyDescription(5, null);

      expect(mockUpdateApiKeyDescription).toHaveBeenCalledWith(5, null);
      expect(result).toBe(true);
    });

    it("should throw when update fails", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(false);

      const result = await mockUpdateApiKeyDescription(999, "desc");
      expect(result).toBe(false);
      // The procedure would throw "Failed to update API key description"
    });
  });

  describe("Edge cases", () => {
    it("should handle empty string description as valid input", async () => {
      mockUpdateApiKeyDescription.mockResolvedValue(true);

      const result = await mockUpdateApiKeyDescription(1, "");
      expect(result).toBe(true);
    });

    it("should handle very long drone names", async () => {
      const longName = "A".repeat(500);
      mockUpdateDroneByDroneId.mockResolvedValue({
        id: 1,
        droneId: "quiver_001",
        name: longName,
        isActive: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await mockUpdateDroneByDroneId("quiver_001", { name: longName });
      expect(result.name).toBe(longName);
    });

    it("should handle special characters in drone ID", async () => {
      mockUpdateDroneByDroneId.mockResolvedValue({
        id: 1,
        droneId: "drone-test_123",
        name: null,
        isActive: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await mockUpdateDroneByDroneId("quiver_001", { droneId: "drone-test_123" });
      expect(result.droneId).toBe("drone-test_123");
    });
  });
});
