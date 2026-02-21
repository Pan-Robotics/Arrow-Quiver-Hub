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

// ─── Module-level cache simulation ──────────────────────────────────
interface ParseState {
  status: "idle" | "downloading" | "parsing" | "complete" | "error";
  progress: number;
  availableCharts: any[];
  chartData: Record<string, any[]>;
  flightSummary?: any;
  flightModes?: any[];
  gpsTrack?: any[];
}

interface TimeFilter {
  startTime: number;
  endTime: number;
  mode: string;
  segmentIndex: number;
}

interface AnalyticsCache {
  selectedLogId: number;
  droneId: string;
  activeTab: string;
  parseState: ParseState;
  timeFilter: TimeFilter | null;
}

// Simulate the module-level cache (same pattern as the real implementation)
let _analyticsCache: AnalyticsCache | null = null;

function getAnalyticsCache(): AnalyticsCache | null {
  return _analyticsCache;
}

function setAnalyticsCache(cache: AnalyticsCache | null) {
  _analyticsCache = cache;
}

function clearAnalyticsCache() {
  _analyticsCache = null;
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

// ─── Module-level Cache Tests ──────────────────────────────────
describe("Flight Analytics Module-Level Cache", () => {
  const makeCompleteParseState = (overrides?: Partial<ParseState>): ParseState => ({
    status: "complete",
    progress: 100,
    availableCharts: [{ id: "att-rp", title: "Attitude" }],
    chartData: { "att-rp": [{ time: 0, Roll: 1.2, Pitch: -0.5 }] },
    flightSummary: { totalFlightTime: 300, maxAltitude: 50 },
    flightModes: [{ mode: "Stabilize", startTime: 0, endTime: 100, duration: 100 }],
    gpsTrack: [{ lat: 37.7749, lng: -122.4194, alt: 50, speed: 5, time: 0 }],
    ...overrides,
  });

  beforeEach(() => {
    clearAnalyticsCache();
  });

  describe("getAnalyticsCache / setAnalyticsCache / clearAnalyticsCache", () => {
    it("returns null when no cache is set", () => {
      expect(getAnalyticsCache()).toBeNull();
    });

    it("stores and retrieves cache", () => {
      const cache: AnalyticsCache = {
        selectedLogId: 42,
        droneId: "drone_001",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      };
      setAnalyticsCache(cache);
      const retrieved = getAnalyticsCache();
      expect(retrieved).not.toBeNull();
      expect(retrieved!.selectedLogId).toBe(42);
      expect(retrieved!.droneId).toBe("drone_001");
      expect(retrieved!.parseState.status).toBe("complete");
      expect(retrieved!.parseState.availableCharts).toHaveLength(1);
    });

    it("clearAnalyticsCache removes the cache", () => {
      setAnalyticsCache({
        selectedLogId: 1,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      expect(getAnalyticsCache()).not.toBeNull();
      clearAnalyticsCache();
      expect(getAnalyticsCache()).toBeNull();
    });

    it("setAnalyticsCache(null) also clears the cache", () => {
      setAnalyticsCache({
        selectedLogId: 1,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      setAnalyticsCache(null);
      expect(getAnalyticsCache()).toBeNull();
    });
  });

  describe("Cache preserves full parsed state", () => {
    it("preserves chartData across cache set/get", () => {
      const chartData = {
        "att-rp": [
          { time: 0, Roll: 1.2, Pitch: -0.5 },
          { time: 1, Roll: 2.3, Pitch: -1.1 },
        ],
        "baro-alt": [
          { time: 0, Alt: 100 },
          { time: 1, Alt: 105 },
        ],
      };
      setAnalyticsCache({
        selectedLogId: 10,
        droneId: "quiver_003",
        activeTab: "charts",
        parseState: makeCompleteParseState({ chartData }),
        timeFilter: null,
      });
      const cached = getAnalyticsCache()!;
      expect(cached.parseState.chartData["att-rp"]).toHaveLength(2);
      expect(cached.parseState.chartData["baro-alt"]).toHaveLength(2);
      expect(cached.parseState.chartData["att-rp"][0].Roll).toBe(1.2);
    });

    it("preserves flightModes across cache set/get", () => {
      const flightModes = [
        { mode: "Stabilize", startTime: 0, endTime: 100, duration: 100 },
        { mode: "Loiter", startTime: 100, endTime: 250, duration: 150 },
        { mode: "RTL", startTime: 250, endTime: 300, duration: 50 },
      ];
      setAnalyticsCache({
        selectedLogId: 10,
        droneId: "d1",
        activeTab: "timeline",
        parseState: makeCompleteParseState({ flightModes }),
        timeFilter: null,
      });
      const cached = getAnalyticsCache()!;
      expect(cached.parseState.flightModes).toHaveLength(3);
      expect(cached.parseState.flightModes![1].mode).toBe("Loiter");
    });

    it("preserves gpsTrack across cache set/get", () => {
      const gpsTrack = [
        { lat: 37.7749, lng: -122.4194, alt: 50, speed: 5, time: 0 },
        { lat: 37.7750, lng: -122.4195, alt: 55, speed: 6, time: 1 },
      ];
      setAnalyticsCache({
        selectedLogId: 10,
        droneId: "d1",
        activeTab: "map",
        parseState: makeCompleteParseState({ gpsTrack }),
        timeFilter: null,
      });
      const cached = getAnalyticsCache()!;
      expect(cached.parseState.gpsTrack).toHaveLength(2);
      expect(cached.parseState.gpsTrack![0].lat).toBe(37.7749);
    });

    it("preserves flightSummary across cache set/get", () => {
      const flightSummary = {
        totalFlightTime: 600,
        maxAltitude: 120,
        maxSpeed: 15.5,
        avgSpeed: 8.2,
        batteryConsumed: 1200,
        maxVibration: 0.35,
      };
      setAnalyticsCache({
        selectedLogId: 10,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState({ flightSummary }),
        timeFilter: null,
      });
      const cached = getAnalyticsCache()!;
      expect(cached.parseState.flightSummary.totalFlightTime).toBe(600);
      expect(cached.parseState.flightSummary.maxAltitude).toBe(120);
    });

    it("preserves timeFilter across cache set/get", () => {
      const timeFilter: TimeFilter = {
        startTime: 50,
        endTime: 150,
        mode: "Loiter",
        segmentIndex: 1,
      };
      setAnalyticsCache({
        selectedLogId: 10,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter,
      });
      const cached = getAnalyticsCache()!;
      expect(cached.timeFilter).not.toBeNull();
      expect(cached.timeFilter!.mode).toBe("Loiter");
      expect(cached.timeFilter!.startTime).toBe(50);
    });

    it("preserves null timeFilter", () => {
      setAnalyticsCache({
        selectedLogId: 10,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      const cached = getAnalyticsCache()!;
      expect(cached.timeFilter).toBeNull();
    });
  });

  describe("Cache overwrites", () => {
    it("overwrites previous cache with new data", () => {
      setAnalyticsCache({
        selectedLogId: 1,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      setAnalyticsCache({
        selectedLogId: 2,
        droneId: "d2",
        activeTab: "map",
        parseState: makeCompleteParseState({ status: "complete" }),
        timeFilter: { startTime: 0, endTime: 100, mode: "RTL", segmentIndex: 0 },
      });
      const cached = getAnalyticsCache()!;
      expect(cached.selectedLogId).toBe(2);
      expect(cached.droneId).toBe("d2");
      expect(cached.activeTab).toBe("map");
      expect(cached.timeFilter!.mode).toBe("RTL");
    });
  });

  describe("Instant restore logic (app switch scenario)", () => {
    it("cache is available immediately after setting (simulates app switch)", () => {
      // Simulate: user parses a log, cache is set
      const parseState = makeCompleteParseState();
      setAnalyticsCache({
        selectedLogId: 42,
        droneId: "drone_001",
        activeTab: "timeline",
        parseState,
        timeFilter: null,
      });

      // Simulate: component unmounts (app switch)
      // ... nothing to do, cache is module-level

      // Simulate: component remounts, reads cache in useState initializer
      const cache = getAnalyticsCache();
      expect(cache).not.toBeNull();
      expect(cache!.selectedLogId).toBe(42);
      expect(cache!.parseState.status).toBe("complete");
      expect(cache!.parseState.availableCharts).toHaveLength(1);
      // No download/parse needed — instant restore
    });

    it("cache returns same object reference (no serialization overhead)", () => {
      const parseState = makeCompleteParseState();
      const cacheObj: AnalyticsCache = {
        selectedLogId: 42,
        droneId: "drone_001",
        activeTab: "charts",
        parseState,
        timeFilter: null,
      };
      setAnalyticsCache(cacheObj);
      const retrieved = getAnalyticsCache();
      // Same reference — no serialization/deserialization
      expect(retrieved).toBe(cacheObj);
    });

    it("restoredRef should be true when cache exists (skip localStorage restore)", () => {
      setAnalyticsCache({
        selectedLogId: 42,
        droneId: "drone_001",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      // Simulates: const restoredRef = useRef(!!getAnalyticsCache());
      const restoredRef = !!getAnalyticsCache();
      expect(restoredRef).toBe(true);
    });

    it("restoredRef should be false when no cache (allow localStorage restore)", () => {
      clearAnalyticsCache();
      const restoredRef = !!getAnalyticsCache();
      expect(restoredRef).toBe(false);
    });
  });

  describe("Cache cleared on error/delete", () => {
    it("clearAnalyticsCache removes cache on parse error", () => {
      setAnalyticsCache({
        selectedLogId: 42,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      // Simulate parse error path
      clearAnalyticsCache();
      expect(getAnalyticsCache()).toBeNull();
    });

    it("clearAnalyticsCache removes cache on log delete", () => {
      setAnalyticsCache({
        selectedLogId: 42,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      // Simulate: if (selectedLogId === deleteTargetId) { clearAnalyticsCache(); }
      const selectedLogId = 42;
      const deleteTargetId = 42;
      if (selectedLogId === deleteTargetId) {
        clearAnalyticsCache();
      }
      expect(getAnalyticsCache()).toBeNull();
    });

    it("cache survives when different log is deleted", () => {
      setAnalyticsCache({
        selectedLogId: 42,
        droneId: "d1",
        activeTab: "charts",
        parseState: makeCompleteParseState(),
        timeFilter: null,
      });
      const selectedLogId = 42;
      const deleteTargetId = 99;
      if (selectedLogId === deleteTargetId) {
        clearAnalyticsCache();
      }
      expect(getAnalyticsCache()).not.toBeNull();
    });
  });
});
