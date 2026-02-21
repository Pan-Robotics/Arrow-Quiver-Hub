import { describe, it, expect } from "vitest";

/**
 * Tests for Mission Planner and Flight Analytics "Coming Soon" placeholder built-in apps.
 * Validates presence across all 4 integration points for each app.
 */

// ─── Mission Planner ────────────────────────────────────────────────

describe("Mission Planner - App Store", () => {
  it("is listed in the AppStore storeApps array with correct id", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain('"mission"');
    expect(source).toContain("Mission Planner");
  });

  it("has correct category and description", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain("Planning");
    expect(source).toContain("waypoints");
    expect(source).toContain("geofencing");
  });

  it("uses Map icon instead of Package placeholder", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain("icon: Map");
    // Verify the import exists
    expect(source).toContain("Map");
  });
});

describe("Mission Planner - App Management", () => {
  it("is defined in BUILT_IN_APP_INFO", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("mission:");
    expect(source).toContain("Mission Planner");
  });

  it("has features list", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("Interactive map-based waypoint planning");
    expect(source).toContain("Geofence boundary definition and alerts");
    expect(source).toContain("Return-to-home and failsafe configuration");
    expect(source).toContain("Mission upload to flight controller");
    expect(source).toContain("Real-time mission progress tracking");
    expect(source).toContain("Mission templates and reusable flight plans");
  });

  it("has data streams defined", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("mission_status");
    expect(source).toContain("waypoint_progress");
  });
});

describe("Mission Planner - Home.tsx Integration", () => {
  it("is in builtInAppMetadata", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");
    expect(source).toContain("mission:");
    expect(source).toContain("Mission Planner");
    expect(source).toContain("icon: Map");
  });

  it("has a Coming Soon placeholder in renderApp switch", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");
    expect(source).toContain('case "mission"');
    // Verify the Coming Soon badge is present for this case
    const missionBlock = source.substring(
      source.indexOf('case "mission"'),
      source.indexOf('case "analytics"')
    );
    expect(missionBlock).toContain("Coming Soon");
    expect(missionBlock).toContain("Mission Planner");
  });
});

describe("Mission Planner - Server Router", () => {
  it("is included in the builtInApps list", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./server/routers.ts", "utf-8");
    expect(source).toContain('"mission"');
    expect(source).toMatch(/builtInApps\s*=\s*\[.*"mission".*\]/);
  });
});

// ─── Flight Analytics ───────────────────────────────────────────────

describe("Flight Analytics - App Store", () => {
  it("is listed in the AppStore storeApps array with correct id", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain('"analytics"');
    expect(source).toContain("Flight Analytics");
  });

  it("has correct category and description", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain("Analytics");
    expect(source).toContain("ArduPilot");
    expect(source).toContain("interactive charts");
  });

  it("uses BarChart3 icon instead of Package placeholder", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain("icon: BarChart3");
    expect(source).toContain("BarChart3");
  });
});

describe("Flight Analytics - App Management", () => {
  it("is defined in BUILT_IN_APP_INFO", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("analytics:");
    expect(source).toContain("Flight Analytics");
  });

  it("has features list", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("Flight duration and distance statistics");
    expect(source).toContain("Battery consumption trend analysis");
    expect(source).toContain("Altitude and speed profile charts");
    expect(source).toContain("Per-drone performance comparison");
    expect(source).toContain("Exportable PDF and CSV flight reports");
    expect(source).toContain("Historical flight path replay on map");
  });

  it("has data streams defined", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    // analytics uses telemetry and flight_logs streams
    expect(source).toContain("flight_logs");
  });
});

describe("Flight Analytics - Home.tsx Integration", () => {
  it("is in builtInAppMetadata", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");
    expect(source).toContain("analytics:");
    expect(source).toContain("Flight Analytics");
    expect(source).toContain("icon: BarChart3");
  });

  it("renders FlightAnalyticsApp component in renderApp switch", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");
    expect(source).toContain('case "analytics"');
    expect(source).toContain("<FlightAnalyticsApp />");
    expect(source).toContain("import FlightAnalyticsApp");
  });
});

describe("Flight Analytics - Server Router", () => {
  it("is included in the builtInApps list", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./server/routers.ts", "utf-8");
    expect(source).toContain('"analytics"');
    expect(source).toMatch(/builtInApps\s*=\s*\[.*"analytics".*\]/);
  });
});

// ─── Cross-cutting ──────────────────────────────────────────────────

describe("Both apps - no Package icon placeholders remain", () => {
  it("Mission Planner does not use Package icon in AppStore", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    // Extract the mission app block
    const missionStart = source.indexOf('id: "mission"');
    const missionEnd = source.indexOf("}", missionStart);
    const missionBlock = source.substring(missionStart, missionEnd);
    expect(missionBlock).not.toContain("icon: Package");
  });

  it("Flight Analytics does not use Package icon in AppStore", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    const analyticsStart = source.indexOf('id: "analytics"');
    const analyticsEnd = source.indexOf("}", analyticsStart);
    const analyticsBlock = source.substring(analyticsStart, analyticsEnd);
    expect(analyticsBlock).not.toContain("icon: Package");
  });
});
