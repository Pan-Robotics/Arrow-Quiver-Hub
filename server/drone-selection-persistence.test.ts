import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const hookPath = path.resolve(__dirname, "../client/src/hooks/useDroneSelection.ts");
const lidarPath = path.resolve(__dirname, "../client/src/components/apps/LidarApp.tsx");
const telemetryPath = path.resolve(__dirname, "../client/src/components/apps/TelemetryApp.tsx");
const cameraPath = path.resolve(__dirname, "../client/src/components/apps/CameraFeedApp.tsx");

describe("useDroneSelection hook", () => {
  const hookSource = fs.readFileSync(hookPath, "utf-8");

  it("exists as a standalone hook file", () => {
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it("defines the STORAGE_KEY constant", () => {
    expect(hookSource).toContain("STORAGE_KEY");
    expect(hookSource).toContain("quiver-hub-selected-drone");
  });

  it("reads from localStorage on initialization", () => {
    expect(hookSource).toContain("localStorage.getItem(STORAGE_KEY)");
  });

  it("writes to localStorage when selection changes", () => {
    expect(hookSource).toContain("localStorage.setItem(STORAGE_KEY, droneId)");
  });

  it("removes from localStorage when cleared", () => {
    expect(hookSource).toContain("localStorage.removeItem(STORAGE_KEY)");
  });

  it("handles localStorage errors gracefully", () => {
    // Should have try-catch around localStorage operations
    const tryCatchCount = (hookSource.match(/try\s*\{/g) || []).length;
    expect(tryCatchCount).toBeGreaterThanOrEqual(2); // at least read + write
  });

  it("fetches drones via trpc", () => {
    expect(hookSource).toContain("trpc.pointcloud.getDrones.useQuery");
  });

  it("validates stored drone against available drones", () => {
    // Should check if stored drone is still in the drone list
    expect(hookSource).toContain("droneIds.includes(selectedDrone)");
  });

  it("falls back to first drone if stored value is stale", () => {
    expect(hookSource).toContain("drones[0].droneId");
  });

  it("exports selectedDrone, setSelectedDrone, drones, and isLoading", () => {
    expect(hookSource).toContain("selectedDrone");
    expect(hookSource).toContain("setSelectedDrone");
    expect(hookSource).toContain("drones");
    expect(hookSource).toContain("isLoading");
  });

  it("uses useCallback for the setter to ensure stable reference", () => {
    expect(hookSource).toContain("useCallback");
  });
});

describe("LidarApp uses shared hook", () => {
  const source = fs.readFileSync(lidarPath, "utf-8");

  it("imports useDroneSelection", () => {
    expect(source).toContain("import { useDroneSelection }");
    expect(source).toContain("@/hooks/useDroneSelection");
  });

  it("calls useDroneSelection hook", () => {
    expect(source).toContain("useDroneSelection()");
  });

  it("does NOT import trpc directly for drone fetching", () => {
    // trpc import should be removed since the hook handles it
    expect(source).not.toContain("import { trpc }");
  });

  it("does NOT have inline drone auto-select useEffect", () => {
    // Should not contain the old pattern of auto-selecting first drone
    expect(source).not.toContain("if (drones && drones.length > 0 && !selectedDrone)");
  });

  it("does NOT call trpc.pointcloud.getDrones.useQuery directly", () => {
    expect(source).not.toContain("trpc.pointcloud.getDrones.useQuery");
  });
});

describe("TelemetryApp uses shared hook", () => {
  const source = fs.readFileSync(telemetryPath, "utf-8");

  it("imports useDroneSelection", () => {
    expect(source).toContain("import { useDroneSelection }");
    expect(source).toContain("@/hooks/useDroneSelection");
  });

  it("calls useDroneSelection hook", () => {
    expect(source).toContain("useDroneSelection()");
  });

  it("does NOT import trpc directly for drone fetching", () => {
    expect(source).not.toContain("import { trpc }");
  });

  it("does NOT have inline drone auto-select useEffect", () => {
    expect(source).not.toContain("if (drones && drones.length > 0 && !selectedDrone)");
  });

  it("does NOT call trpc.pointcloud.getDrones.useQuery directly", () => {
    expect(source).not.toContain("trpc.pointcloud.getDrones.useQuery");
  });
});

describe("CameraFeedApp uses shared hook", () => {
  const source = fs.readFileSync(cameraPath, "utf-8");

  it("imports useDroneSelection", () => {
    expect(source).toContain("import { useDroneSelection }");
    expect(source).toContain("@/hooks/useDroneSelection");
  });

  it("calls useDroneSelection hook", () => {
    expect(source).toContain("useDroneSelection()");
  });

  it("does NOT import trpc directly for drone fetching", () => {
    expect(source).not.toContain("import { trpc }");
  });

  it("does NOT have inline drone auto-select useEffect", () => {
    expect(source).not.toContain("if (drones && drones.length > 0 && !selectedDrone)");
  });

  it("does NOT call trpc.pointcloud.getDrones.useQuery directly", () => {
    expect(source).not.toContain("trpc.pointcloud.getDrones.useQuery");
  });
});

describe("All apps share the same localStorage key", () => {
  const hookSource = fs.readFileSync(hookPath, "utf-8");

  it("uses a single shared key for all apps", () => {
    // The key is defined once in the hook, not in individual apps
    const keyMatch = hookSource.match(/STORAGE_KEY\s*=\s*["']([^"']+)["']/);
    expect(keyMatch).not.toBeNull();
    expect(keyMatch![1]).toBe("quiver-hub-selected-drone");
  });

  it("no app defines its own localStorage key", () => {
    const lidar = fs.readFileSync(lidarPath, "utf-8");
    const telemetry = fs.readFileSync(telemetryPath, "utf-8");
    const camera = fs.readFileSync(cameraPath, "utf-8");

    // None of the apps should reference localStorage directly
    expect(lidar).not.toContain("localStorage");
    expect(telemetry).not.toContain("localStorage");
    expect(camera).not.toContain("localStorage");
  });
});
