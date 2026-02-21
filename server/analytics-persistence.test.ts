import { describe, it, expect, beforeEach, vi } from "vitest";

// Test the persistence helper functions by simulating their logic
// (The actual functions are in the client component, so we test the logic pattern)

const ANALYTICS_STORAGE_KEY = "flight-analytics-state";

interface PersistedAnalyticsState {
  selectedLogId: number;
  droneId: string;
  activeTab: string;
}

// Replicate the helper functions for testing
function saveAnalyticsState(storage: Map<string, string>, state: PersistedAnalyticsState) {
  storage.set(ANALYTICS_STORAGE_KEY, JSON.stringify(state));
}

function loadAnalyticsState(storage: Map<string, string>): PersistedAnalyticsState | null {
  const raw = storage.get(ANALYTICS_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.selectedLogId === "number" && typeof parsed.droneId === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearAnalyticsState(storage: Map<string, string>) {
  storage.delete(ANALYTICS_STORAGE_KEY);
}

describe("Flight Analytics Persistence", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
  });

  describe("saveAnalyticsState", () => {
    it("saves state to storage", () => {
      saveAnalyticsState(storage, {
        selectedLogId: 42,
        droneId: "drone_001",
        activeTab: "charts",
      });
      expect(storage.has(ANALYTICS_STORAGE_KEY)).toBe(true);
      const saved = JSON.parse(storage.get(ANALYTICS_STORAGE_KEY)!);
      expect(saved.selectedLogId).toBe(42);
      expect(saved.droneId).toBe("drone_001");
      expect(saved.activeTab).toBe("charts");
    });

    it("overwrites previous state", () => {
      saveAnalyticsState(storage, {
        selectedLogId: 1,
        droneId: "drone_001",
        activeTab: "charts",
      });
      saveAnalyticsState(storage, {
        selectedLogId: 2,
        droneId: "drone_002",
        activeTab: "timeline",
      });
      const saved = loadAnalyticsState(storage);
      expect(saved?.selectedLogId).toBe(2);
      expect(saved?.droneId).toBe("drone_002");
      expect(saved?.activeTab).toBe("timeline");
    });
  });

  describe("loadAnalyticsState", () => {
    it("returns null when no state is saved", () => {
      expect(loadAnalyticsState(storage)).toBeNull();
    });

    it("returns saved state", () => {
      saveAnalyticsState(storage, {
        selectedLogId: 10,
        droneId: "quiver_003",
        activeTab: "gps",
      });
      const loaded = loadAnalyticsState(storage);
      expect(loaded).toEqual({
        selectedLogId: 10,
        droneId: "quiver_003",
        activeTab: "gps",
      });
    });

    it("returns null for invalid JSON", () => {
      storage.set(ANALYTICS_STORAGE_KEY, "not-valid-json{{{");
      expect(loadAnalyticsState(storage)).toBeNull();
    });

    it("returns null for missing selectedLogId", () => {
      storage.set(ANALYTICS_STORAGE_KEY, JSON.stringify({ droneId: "drone_001", activeTab: "charts" }));
      expect(loadAnalyticsState(storage)).toBeNull();
    });

    it("returns null for non-number selectedLogId", () => {
      storage.set(ANALYTICS_STORAGE_KEY, JSON.stringify({ selectedLogId: "abc", droneId: "drone_001", activeTab: "charts" }));
      expect(loadAnalyticsState(storage)).toBeNull();
    });

    it("returns null for missing droneId", () => {
      storage.set(ANALYTICS_STORAGE_KEY, JSON.stringify({ selectedLogId: 1, activeTab: "charts" }));
      expect(loadAnalyticsState(storage)).toBeNull();
    });
  });

  describe("clearAnalyticsState", () => {
    it("removes saved state", () => {
      saveAnalyticsState(storage, {
        selectedLogId: 5,
        droneId: "drone_001",
        activeTab: "charts",
      });
      expect(loadAnalyticsState(storage)).not.toBeNull();
      clearAnalyticsState(storage);
      expect(loadAnalyticsState(storage)).toBeNull();
    });

    it("does nothing when no state exists", () => {
      clearAnalyticsState(storage);
      expect(loadAnalyticsState(storage)).toBeNull();
    });
  });

  describe("Restoration logic", () => {
    it("should not restore if persisted drone doesn't match current drone", () => {
      const persisted = { selectedLogId: 1, droneId: "drone_A", activeTab: "charts" };
      const currentDrone = "drone_B";
      // Simulating the check: if (selectedDrone && persisted.droneId !== selectedDrone) return;
      const shouldRestore = !(currentDrone && persisted.droneId !== currentDrone);
      expect(shouldRestore).toBe(false);
    });

    it("should restore if persisted drone matches current drone", () => {
      const persisted = { selectedLogId: 1, droneId: "drone_A", activeTab: "charts" };
      const currentDrone = "drone_A";
      const shouldRestore = !(currentDrone && persisted.droneId !== currentDrone);
      expect(shouldRestore).toBe(true);
    });

    it("should restore if no drone is currently selected", () => {
      const persisted = { selectedLogId: 1, droneId: "drone_A", activeTab: "charts" };
      const currentDrone = "";
      const shouldRestore = !(currentDrone && persisted.droneId !== currentDrone);
      expect(shouldRestore).toBe(true);
    });

    it("should not restore if log no longer exists in list", () => {
      const persisted = { selectedLogId: 99, droneId: "drone_A", activeTab: "charts" };
      const logs = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const logExists = logs.some((l) => l.id === persisted.selectedLogId);
      expect(logExists).toBe(false);
    });

    it("should restore if log exists in list", () => {
      const persisted = { selectedLogId: 2, droneId: "drone_A", activeTab: "charts" };
      const logs = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const logExists = logs.some((l) => l.id === persisted.selectedLogId);
      expect(logExists).toBe(true);
    });

    it("should persist activeTab changes", () => {
      saveAnalyticsState(storage, { selectedLogId: 1, droneId: "d1", activeTab: "charts" });
      // Simulate tab change
      saveAnalyticsState(storage, { selectedLogId: 1, droneId: "d1", activeTab: "timeline" });
      const loaded = loadAnalyticsState(storage);
      expect(loaded?.activeTab).toBe("timeline");
    });
  });
});
