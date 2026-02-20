import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Tests to verify that all built-in apps have drone selector dropdowns.
 * These are structural tests that check the component source code for the
 * required drone selector patterns.
 */

const clientDir = path.resolve(__dirname, "../client/src/components/apps");

function readComponent(filename: string): string {
  return fs.readFileSync(path.join(clientDir, filename), "utf-8");
}

describe("Drone selector in built-in apps", () => {
  describe("LidarApp", () => {
    const source = readComponent("LidarApp.tsx");

    it("imports Select components from shadcn/ui", () => {
      expect(source).toContain("Select");
      expect(source).toContain("SelectTrigger");
      expect(source).toContain("SelectContent");
      expect(source).toContain("SelectItem");
      expect(source).toContain("SelectValue");
    });

    it("uses trpc to fetch drones", () => {
      expect(source).toContain("trpc.pointcloud.getDrones.useQuery");
    });

    it("has selectedDrone state", () => {
      expect(source).toContain("selectedDrone");
      expect(source).toContain("setSelectedDrone");
    });

    it("renders a drone selector dropdown", () => {
      expect(source).toContain("Select drone");
      expect(source).toContain("onValueChange={setSelectedDrone}");
    });

    it("auto-selects first drone", () => {
      expect(source).toContain("drones[0].droneId");
    });
  });

  describe("TelemetryApp", () => {
    const source = readComponent("TelemetryApp.tsx");

    it("imports Select components from shadcn/ui", () => {
      expect(source).toContain("Select");
      expect(source).toContain("SelectTrigger");
      expect(source).toContain("SelectContent");
      expect(source).toContain("SelectItem");
      expect(source).toContain("SelectValue");
    });

    it("uses trpc to fetch drones", () => {
      expect(source).toContain("trpc.pointcloud.getDrones.useQuery");
    });

    it("has selectedDrone state", () => {
      expect(source).toContain("selectedDrone");
      expect(source).toContain("setSelectedDrone");
    });

    it("renders a drone selector dropdown", () => {
      expect(source).toContain("Select drone");
      expect(source).toContain("onValueChange={setSelectedDrone}");
    });

    it("auto-selects first drone", () => {
      expect(source).toContain("drones[0].droneId");
    });

    it("does NOT accept droneId as a prop", () => {
      // The component should manage its own drone selection, not accept it as a prop
      expect(source).not.toMatch(/interface\s+\w*Props[\s\S]*droneId/);
      expect(source).not.toContain("{ droneId }");
    });

    it("does NOT hardcode quiver_001", () => {
      expect(source).not.toContain("quiver_001");
    });

    it("subscribes to selected drone via WebSocket", () => {
      expect(source).toContain("selectedDrone");
      expect(source).toContain("emit('subscribe'");
    });
  });

  describe("CameraFeedApp", () => {
    const source = readComponent("CameraFeedApp.tsx");

    it("imports Select components from shadcn/ui", () => {
      expect(source).toContain("Select");
      expect(source).toContain("SelectTrigger");
      expect(source).toContain("SelectContent");
      expect(source).toContain("SelectItem");
      expect(source).toContain("SelectValue");
    });

    it("uses trpc to fetch drones", () => {
      expect(source).toContain("trpc.pointcloud.getDrones.useQuery");
    });

    it("has selectedDrone state", () => {
      expect(source).toContain("selectedDrone");
      expect(source).toContain("setSelectedDrone");
    });

    it("renders a drone selector dropdown", () => {
      expect(source).toContain("Select drone");
      expect(source).toContain("onValueChange={setSelectedDrone}");
    });

    it("auto-selects first drone", () => {
      expect(source).toContain("drones[0].droneId");
    });

    it("does NOT hardcode quiver_001", () => {
      expect(source).not.toContain("quiver_001");
    });

    it("uses selectedDrone for WebSocket subscription", () => {
      expect(source).toContain("subscribe_camera");
      expect(source).toContain("selectedDrone");
    });

    it("uses selectedDrone for camera commands", () => {
      expect(source).toContain("droneId: selectedDrone");
    });
  });

  describe("Home.tsx integration", () => {
    const homeSource = fs.readFileSync(
      path.resolve(__dirname, "../client/src/pages/Home.tsx"),
      "utf-8"
    );

    it("does NOT pass droneId prop to TelemetryApp", () => {
      expect(homeSource).not.toContain("TelemetryApp droneId");
    });

    it("does NOT pass droneId prop to CameraFeedApp", () => {
      expect(homeSource).not.toContain("CameraFeedApp droneId");
    });

    it("does NOT pass droneId prop to LidarApp", () => {
      expect(homeSource).not.toContain("LidarApp droneId");
    });

    it("renders TelemetryApp without props", () => {
      expect(homeSource).toContain("<TelemetryApp />");
    });

    it("renders CameraFeedApp without props", () => {
      expect(homeSource).toContain("<CameraFeedApp />");
    });

    it("renders LidarApp without props", () => {
      expect(homeSource).toContain("<LidarApp />");
    });
  });
});
