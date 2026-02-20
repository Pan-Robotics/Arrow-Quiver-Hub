import { describe, it, expect } from "vitest";

/**
 * Tests for the Logs & OTA Updates "Coming Soon" placeholder built-in app.
 * Validates presence across all 4 integration points.
 */

describe("Logs & OTA Updates - App Store", () => {
  it("is listed in the AppStore storeApps array", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain('"logs-ota"');
    expect(source).toContain("Logs & OTA Updates");
  });

  it("has correct category and description in AppStore", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain("Maintenance");
    expect(source).toContain("over-the-air firmware updates");
  });

  it("uses ScrollText icon in AppStore", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");
    expect(source).toContain("ScrollText");
    expect(source).toContain("icon: ScrollText");
  });
});

describe("Logs & OTA Updates - App Management", () => {
  it("is defined in BUILT_IN_APP_INFO", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain('"logs-ota"');
    expect(source).toContain("Logs & OTA Updates");
  });

  it("has features list in App Management", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("Real-time log streaming from companion computer");
    expect(source).toContain("Over-the-air firmware update deployment");
    expect(source).toContain("Update rollback and version management");
    expect(source).toContain("Log filtering and search");
  });

  it("has data streams defined", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");
    expect(source).toContain("system_logs");
    expect(source).toContain("ota_status");
  });
});

describe("Logs & OTA Updates - Home.tsx Integration", () => {
  it("is in builtInAppMetadata in Home.tsx", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");
    expect(source).toContain('"logs-ota"');
    expect(source).toContain("Logs & OTA Updates");
  });

  it("has a Coming Soon placeholder in renderApp switch", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");
    expect(source).toContain('case "logs-ota"');
    expect(source).toContain("Coming Soon");
  });
});

describe("Logs & OTA Updates - Server Router", () => {
  it("is included in the builtInApps list in routers.ts", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("./server/routers.ts", "utf-8");
    expect(source).toContain('"logs-ota"');
    // Verify it's in the builtInApps array alongside telemetry and camera
    expect(source).toMatch(/builtInApps\s*=\s*\[.*"logs-ota".*\]/);
  });
});
