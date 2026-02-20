import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const hookPath = path.resolve(__dirname, "../client/src/hooks/useDroneSelection.ts");
const lidarPath = path.resolve(__dirname, "../client/src/components/apps/LidarApp.tsx");
const telemetryPath = path.resolve(__dirname, "../client/src/components/apps/TelemetryApp.tsx");
const cameraPath = path.resolve(__dirname, "../client/src/components/apps/CameraFeedApp.tsx");

describe("useDroneSelection hook (per-app persistence)", () => {
  const hookSource = fs.readFileSync(hookPath, "utf-8");

  it("exists as a standalone hook file", () => {
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it("defines a STORAGE_PREFIX constant", () => {
    expect(hookSource).toContain("STORAGE_PREFIX");
    expect(hookSource).toContain("quiver-hub-selected-drone");
  });

  it("builds per-app keys using a storageKey helper", () => {
    expect(hookSource).toContain("storageKey");
    expect(hookSource).toContain("STORAGE_PREFIX");
    expect(hookSource).toContain("appId");
  });

  it("accepts an appId parameter", () => {
    expect(hookSource).toMatch(/function useDroneSelection\(appId:\s*string\)/);
  });

  it("reads from localStorage using the per-app key", () => {
    expect(hookSource).toContain("localStorage.getItem(key)");
  });

  it("writes to localStorage using the per-app key", () => {
    expect(hookSource).toContain("localStorage.setItem(key, droneId)");
  });

  it("removes from localStorage using the per-app key", () => {
    expect(hookSource).toContain("localStorage.removeItem(key)");
  });

  it("handles localStorage errors gracefully", () => {
    const tryCatchCount = (hookSource.match(/try\s*\{/g) || []).length;
    expect(tryCatchCount).toBeGreaterThanOrEqual(2);
  });

  it("fetches drones via trpc", () => {
    expect(hookSource).toContain("trpc.pointcloud.getDrones.useQuery");
  });

  it("validates stored drone against available drones", () => {
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

describe("Each app passes a unique appId", () => {
  const lidar = fs.readFileSync(lidarPath, "utf-8");
  const telemetry = fs.readFileSync(telemetryPath, "utf-8");
  const camera = fs.readFileSync(cameraPath, "utf-8");

  it("LidarApp passes 'lidar' as appId", () => {
    expect(lidar).toContain('useDroneSelection("lidar")');
  });

  it("TelemetryApp passes 'telemetry' as appId", () => {
    expect(telemetry).toContain('useDroneSelection("telemetry")');
  });

  it("CameraFeedApp passes 'camera' as appId", () => {
    expect(camera).toContain('useDroneSelection("camera")');
  });

  it("all three appIds are distinct", () => {
    const lidarMatch = lidar.match(/useDroneSelection\("([^"]+)"\)/);
    const telemetryMatch = telemetry.match(/useDroneSelection\("([^"]+)"\)/);
    const cameraMatch = camera.match(/useDroneSelection\("([^"]+)"\)/);

    expect(lidarMatch).not.toBeNull();
    expect(telemetryMatch).not.toBeNull();
    expect(cameraMatch).not.toBeNull();

    const ids = [lidarMatch![1], telemetryMatch![1], cameraMatch![1]];
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });
});

describe("LidarApp uses shared hook", () => {
  const source = fs.readFileSync(lidarPath, "utf-8");

  it("imports useDroneSelection", () => {
    expect(source).toContain("import { useDroneSelection }");
    expect(source).toContain("@/hooks/useDroneSelection");
  });

  it("does NOT import trpc directly for drone fetching", () => {
    expect(source).not.toContain("import { trpc }");
  });

  it("does NOT have inline drone auto-select useEffect", () => {
    expect(source).not.toContain("if (drones && drones.length > 0 && !selectedDrone)");
  });
});

describe("TelemetryApp uses shared hook", () => {
  const source = fs.readFileSync(telemetryPath, "utf-8");

  it("imports useDroneSelection", () => {
    expect(source).toContain("import { useDroneSelection }");
    expect(source).toContain("@/hooks/useDroneSelection");
  });

  it("does NOT import trpc directly for drone fetching", () => {
    expect(source).not.toContain("import { trpc }");
  });

  it("does NOT have inline drone auto-select useEffect", () => {
    expect(source).not.toContain("if (drones && drones.length > 0 && !selectedDrone)");
  });
});

describe("CameraFeedApp uses shared hook", () => {
  const source = fs.readFileSync(cameraPath, "utf-8");

  it("imports useDroneSelection", () => {
    expect(source).toContain("import { useDroneSelection }");
    expect(source).toContain("@/hooks/useDroneSelection");
  });

  it("does NOT import trpc directly for drone fetching", () => {
    expect(source).not.toContain("import { trpc }");
  });

  it("does NOT have inline drone auto-select useEffect", () => {
    expect(source).not.toContain("if (drones && drones.length > 0 && !selectedDrone)");
  });
});

describe("No app references localStorage directly", () => {
  it("LidarApp does not use localStorage", () => {
    const source = fs.readFileSync(lidarPath, "utf-8");
    expect(source).not.toContain("localStorage");
  });

  it("TelemetryApp does not use localStorage", () => {
    const source = fs.readFileSync(telemetryPath, "utf-8");
    expect(source).not.toContain("localStorage");
  });

  it("CameraFeedApp does not use localStorage", () => {
    const source = fs.readFileSync(cameraPath, "utf-8");
    expect(source).not.toContain("localStorage");
  });
});
