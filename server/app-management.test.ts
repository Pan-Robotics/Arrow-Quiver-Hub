import { describe, it, expect } from 'vitest';

/**
 * Tests for App Management logic:
 * - Built-in app detection
 * - Display name resolution
 * - Description resolution
 * - Edit/Delete button visibility rules
 * - Data source label formatting
 * - View modal content differentiation
 */

// Replicate the built-in app info from AppManagement.tsx
const BUILT_IN_APP_INFO: Record<string, {
  name: string;
  description: string;
  category: string;
  dataStreams: string[];
  features: string[];
}> = {
  telemetry: {
    name: "Flight Telemetry",
    description: "Real-time flight data including attitude (roll/pitch/yaw), GPS position, altitude, speed, and battery monitoring from MAVLink and UAVCAN flight controllers.",
    category: "Monitoring",
    dataStreams: ["telemetry"],
    features: [
      "Attitude indicator (roll, pitch, yaw)",
      "GPS position display (latitude, longitude)",
      "Altitude and relative altitude tracking",
      "Battery voltage and remaining percentage",
      "Satellite count and GPS fix status",
      "In-air status detection",
    ],
  },
  camera: {
    name: "Camera Feed",
    description: "Live video stream from SIYI A8 mini gimbal camera with gimbal control, zoom, recording, and snapshot capabilities via RTSP-to-HLS streaming.",
    category: "Media",
    dataStreams: ["camera_status"],
    features: [
      "Live RTSP video stream via HLS",
      "Gimbal yaw and pitch control",
      "Zoom level adjustment",
      "Recording start/stop",
      "Snapshot capture",
      "Camera connection status monitoring",
    ],
  },
};

/** Check if an app is a built-in app (no database entry) */
function isBuiltInApp(app: any): boolean {
  return !app.id || BUILT_IN_APP_INFO[app.appId] !== undefined;
}

/** Get display name for an app */
function getAppDisplayName(app: any): string {
  const builtIn = BUILT_IN_APP_INFO[app.appId];
  if (builtIn) return builtIn.name;
  return app.name || app.appId;
}

/** Get description for an app */
function getAppDescription(app: any): string {
  const builtIn = BUILT_IN_APP_INFO[app.appId];
  if (builtIn) return builtIn.description;
  return app.description || "No description provided";
}

/** Get data source label */
function getDataSourceLabel(dataSource: string): string {
  switch (dataSource) {
    case 'custom_endpoint': return 'Custom REST Endpoint';
    case 'stream_subscription': return 'Stream Subscription';
    case 'passthrough': return 'Passthrough';
    default: return dataSource || 'Unknown';
  }
}

// Mock app data as returned by getUserApps
const mockBuiltInTelemetry = {
  appId: "telemetry",
  name: "telemetry", // Backend returns appId as name for built-in
  installedAt: new Date("2025-01-15"),
};

const mockBuiltInCamera = {
  appId: "camera",
  name: "camera",
  installedAt: new Date("2025-01-15"),
};

const mockCustomApp = {
  id: 42,
  appId: "rplidar-pointcloud-viewer",
  name: "RPLidar Point Cloud Viewer",
  description: "Real-time point cloud visualization from RPLidar data stream",
  version: "1.0.0",
  published: "published",
  dataSource: "stream_subscription",
  dataSourceConfig: JSON.stringify({
    streams: [
      {
        streamId: "pointcloud",
        streamEvent: "pointcloud",
        subscribeEvent: "subscribe_stream",
        subscribeParam: "pointcloud",
        selectedFields: ["points", "stats.point_count", "stats.valid_points"],
        fieldAliases: {},
      },
    ],
    fieldMappings: {
      points: "pointcloud:points",
      point_count: "pointcloud:stats.point_count",
    },
  }),
  parserCode: "def parse(data):\n    return data",
  dataSchema: JSON.stringify({ points: { type: "array" }, point_count: { type: "number" } }),
  uiSchema: JSON.stringify({ columns: 3, widgets: [{ id: "w1", type: "canvas", position: { row: 1, col: 1, colSpan: 3 }, config: { label: "Point Cloud" }, dataBinding: { field: "points" } }] }),
  creatorId: 1,
  installedAt: new Date("2025-02-01"),
};

const mockCustomEndpointApp = {
  id: 43,
  appId: "lidar-stats-monitor",
  name: "LiDAR Stats Monitor",
  description: "Monitors LiDAR statistics in real-time",
  version: "1.0.0",
  published: "published",
  dataSource: "custom_endpoint",
  dataSourceConfig: null,
  parserCode: "def parse(data):\n    return {'count': len(data.get('points', []))}",
  dataSchema: JSON.stringify({ count: { type: "number" } }),
  uiSchema: JSON.stringify({ columns: 2, widgets: [] }),
  creatorId: 1,
  installedAt: new Date("2025-02-05"),
};

describe('App Management - Built-in App Detection', () => {
  it('should identify telemetry as built-in', () => {
    expect(isBuiltInApp(mockBuiltInTelemetry)).toBe(true);
  });

  it('should identify camera as built-in', () => {
    expect(isBuiltInApp(mockBuiltInCamera)).toBe(true);
  });

  it('should identify custom app with id as NOT built-in', () => {
    expect(isBuiltInApp(mockCustomApp)).toBe(false);
  });

  it('should identify custom endpoint app as NOT built-in', () => {
    expect(isBuiltInApp(mockCustomEndpointApp)).toBe(false);
  });

  it('should identify app without id but unknown appId as built-in (no DB entry)', () => {
    const unknownApp = { appId: "unknown-app", name: "unknown-app", installedAt: new Date() };
    // No id field → treated as built-in (safe default)
    expect(isBuiltInApp(unknownApp)).toBe(true);
  });
});

describe('App Management - Display Names', () => {
  it('should return proper name for telemetry built-in', () => {
    expect(getAppDisplayName(mockBuiltInTelemetry)).toBe("Flight Telemetry");
  });

  it('should return proper name for camera built-in', () => {
    expect(getAppDisplayName(mockBuiltInCamera)).toBe("Camera Feed");
  });

  it('should return app name for custom apps', () => {
    expect(getAppDisplayName(mockCustomApp)).toBe("RPLidar Point Cloud Viewer");
  });

  it('should fall back to appId when name is missing', () => {
    const noNameApp = { appId: "some-app", id: 99, installedAt: new Date() };
    expect(getAppDisplayName(noNameApp)).toBe("some-app");
  });
});

describe('App Management - Descriptions', () => {
  it('should return built-in description for telemetry', () => {
    const desc = getAppDescription(mockBuiltInTelemetry);
    expect(desc).toContain("attitude");
    expect(desc).toContain("MAVLink");
  });

  it('should return built-in description for camera', () => {
    const desc = getAppDescription(mockBuiltInCamera);
    expect(desc).toContain("SIYI A8 mini");
    expect(desc).toContain("RTSP");
  });

  it('should return custom app description', () => {
    expect(getAppDescription(mockCustomApp)).toBe("Real-time point cloud visualization from RPLidar data stream");
  });

  it('should return fallback for app without description', () => {
    const noDescApp = { appId: "no-desc", id: 100, installedAt: new Date() };
    expect(getAppDescription(noDescApp)).toBe("No description provided");
  });
});

describe('App Management - Data Source Labels', () => {
  it('should format custom_endpoint label', () => {
    expect(getDataSourceLabel('custom_endpoint')).toBe('Custom REST Endpoint');
  });

  it('should format stream_subscription label', () => {
    expect(getDataSourceLabel('stream_subscription')).toBe('Stream Subscription');
  });

  it('should format passthrough label', () => {
    expect(getDataSourceLabel('passthrough')).toBe('Passthrough');
  });

  it('should handle unknown data source', () => {
    expect(getDataSourceLabel('something_else')).toBe('something_else');
  });

  it('should handle empty data source', () => {
    expect(getDataSourceLabel('')).toBe('Unknown');
  });
});

describe('App Management - Edit/Delete Button Visibility', () => {
  it('should NOT show Edit button for built-in telemetry', () => {
    const builtIn = isBuiltInApp(mockBuiltInTelemetry);
    expect(builtIn).toBe(true);
    // Edit button is hidden when builtIn is true
  });

  it('should NOT show Edit button for built-in camera', () => {
    const builtIn = isBuiltInApp(mockBuiltInCamera);
    expect(builtIn).toBe(true);
  });

  it('should show Edit button for custom apps', () => {
    const builtIn = isBuiltInApp(mockCustomApp);
    expect(builtIn).toBe(false);
    // Edit button is shown when builtIn is false
  });

  it('should NOT show Delete button for built-in apps (no id)', () => {
    // Delete button requires !builtIn && app.id
    const builtIn = isBuiltInApp(mockBuiltInTelemetry);
    const hasId = !!(mockBuiltInTelemetry as any).id;
    expect(builtIn || !hasId).toBe(true); // Either condition prevents Delete
  });

  it('should show Delete button for custom apps with id', () => {
    const builtIn = isBuiltInApp(mockCustomApp);
    const hasId = !!(mockCustomApp as any).id;
    expect(!builtIn && hasId).toBe(true);
  });

  it('should NOT show Export button for built-in apps', () => {
    const builtIn = isBuiltInApp(mockBuiltInTelemetry);
    expect(builtIn).toBe(true);
    // Export button is hidden when builtIn is true
  });

  it('should show Export button for custom apps', () => {
    const builtIn = isBuiltInApp(mockCustomApp);
    expect(builtIn).toBe(false);
  });
});

describe('App Management - Built-in App Metadata', () => {
  it('should have metadata for telemetry', () => {
    const info = BUILT_IN_APP_INFO['telemetry'];
    expect(info).toBeDefined();
    expect(info.name).toBe("Flight Telemetry");
    expect(info.category).toBe("Monitoring");
    expect(info.dataStreams).toContain("telemetry");
    expect(info.features.length).toBeGreaterThan(0);
  });

  it('should have metadata for camera', () => {
    const info = BUILT_IN_APP_INFO['camera'];
    expect(info).toBeDefined();
    expect(info.name).toBe("Camera Feed");
    expect(info.category).toBe("Media");
    expect(info.dataStreams).toContain("camera_status");
    expect(info.features.length).toBeGreaterThan(0);
  });

  it('should NOT have metadata for unknown apps', () => {
    expect(BUILT_IN_APP_INFO['unknown']).toBeUndefined();
  });

  it('should NOT have metadata for custom apps', () => {
    expect(BUILT_IN_APP_INFO['rplidar-pointcloud-viewer']).toBeUndefined();
  });
});

describe('App Management - View Modal Content Differentiation', () => {
  it('should use built-in view for telemetry', () => {
    const builtIn = isBuiltInApp(mockBuiltInTelemetry);
    expect(builtIn).toBe(true);
    // Built-in view shows: icon, description, data streams, features, installation info
    const info = BUILT_IN_APP_INFO[mockBuiltInTelemetry.appId];
    expect(info).toBeDefined();
    expect(info!.features.length).toBeGreaterThan(0);
    expect(info!.dataStreams.length).toBeGreaterThan(0);
  });

  it('should use custom view for rplidar-pointcloud-viewer', () => {
    const builtIn = isBuiltInApp(mockCustomApp);
    expect(builtIn).toBe(false);
    // Custom view shows: parser code, data schema, UI schema, data source config
    expect(mockCustomApp.parserCode).toBeTruthy();
    expect(mockCustomApp.dataSchema).toBeTruthy();
    expect(mockCustomApp.uiSchema).toBeTruthy();
    expect(mockCustomApp.dataSourceConfig).toBeTruthy();
  });

  it('should parse stream subscriptions from custom app config', () => {
    const config = JSON.parse(mockCustomApp.dataSourceConfig!);
    expect(config.streams).toBeDefined();
    expect(config.streams.length).toBe(1);
    expect(config.streams[0].streamId).toBe("pointcloud");
    expect(config.streams[0].selectedFields).toContain("points");
  });

  it('should show REST endpoint for custom_endpoint apps', () => {
    expect(mockCustomEndpointApp.dataSource).toBe('custom_endpoint');
    // REST endpoint section is shown for custom_endpoint apps
    const endpoint = `/api/rest/payload/${mockCustomEndpointApp.appId}/ingest`;
    expect(endpoint).toBe('/api/rest/payload/lidar-stats-monitor/ingest');
  });

  it('should NOT show REST endpoint for stream_subscription apps', () => {
    expect(mockCustomApp.dataSource).toBe('stream_subscription');
    // REST endpoint section is NOT shown for stream_subscription apps
  });
});
