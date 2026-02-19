import { describe, it, expect } from "vitest";

/**
 * Tests for multi-stream subscription feature.
 * Validates config normalization, field mapping, data merging, and backward compatibility.
 */

// ---- Types matching AppRenderer ----

interface StreamSubscription {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  selectedFields: string[];
  fieldAliases: Record<string, string>;
}

interface MultiStreamConfig {
  streams: StreamSubscription[];
  fieldMappings: Record<string, string>; // widgetField -> "streamId:fieldPath"
}

interface LegacyStreamConfig {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  fieldMappings: Record<string, string>;
}

// ---- Helpers matching AppRenderer logic ----

function normalizeConfig(dataSourceConfig: any): MultiStreamConfig | null {
  if (!dataSourceConfig) return null;

  // New multi-stream format
  if (dataSourceConfig.streams && Array.isArray(dataSourceConfig.streams)) {
    return dataSourceConfig as MultiStreamConfig;
  }

  // Legacy single-stream format: convert to multi-stream
  if (dataSourceConfig.streamId) {
    const legacy = dataSourceConfig as LegacyStreamConfig;
    return {
      streams: [{
        streamId: legacy.streamId,
        streamEvent: legacy.streamEvent,
        subscribeEvent: legacy.subscribeEvent,
        subscribeParam: legacy.subscribeParam,
        selectedFields: legacy.fieldMappings ? Object.values(legacy.fieldMappings) : [],
        fieldAliases: {},
      }],
      fieldMappings: legacy.fieldMappings || {},
    };
  }

  return null;
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current: any, key: string) => current?.[key], obj);
}

function parseFieldMapping(mapping: string): { streamId: string; fieldPath: string } | null {
  // Handle app: prefixed stream IDs (e.g., "app:weather-station:temperature")
  if (mapping.startsWith('app:')) {
    // Find the second colon after "app:"
    const afterApp = mapping.substring(4); // remove "app:"
    const colonIdx = afterApp.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      streamId: 'app:' + afterApp.substring(0, colonIdx),
      fieldPath: afterApp.substring(colonIdx + 1),
    };
  }
  
  // Standard stream IDs (e.g., "pointcloud:stats.point_count")
  const colonIdx = mapping.indexOf(':');
  if (colonIdx === -1) return null;
  return {
    streamId: mapping.substring(0, colonIdx),
    fieldPath: mapping.substring(colonIdx + 1),
  };
}

function applyStreamData(
  streamId: string,
  rawData: any,
  fieldMappings: Record<string, string>,
  existingData: Record<string, any>
): Record<string, any> {
  const updates: Record<string, any> = {};

  for (const [widgetField, mapping] of Object.entries(fieldMappings)) {
    const parsed = parseFieldMapping(mapping);
    if (!parsed) continue;

    if (parsed.streamId === streamId) {
      updates[widgetField] = getNestedValue(rawData, parsed.fieldPath);
    }
  }

  return { ...existingData, ...updates };
}

// ---- Tests ----

describe("Multi-Stream Config Normalization", () => {
  it("should return null for null/undefined config", () => {
    expect(normalizeConfig(null)).toBeNull();
    expect(normalizeConfig(undefined)).toBeNull();
  });

  it("should pass through multi-stream config as-is", () => {
    const config: MultiStreamConfig = {
      streams: [
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["points", "stats.point_count"],
          fieldAliases: {},
        },
        {
          streamId: "telemetry",
          streamEvent: "telemetry",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "telemetry",
          selectedFields: ["altitude", "battery_level"],
          fieldAliases: {},
        },
      ],
      fieldMappings: {
        point_cloud: "pointcloud:points",
        point_count: "pointcloud:stats.point_count",
        altitude: "telemetry:altitude",
        battery: "telemetry:battery_level",
      },
    };

    const result = normalizeConfig(config);
    expect(result).toEqual(config);
    expect(result!.streams).toHaveLength(2);
  });

  it("should convert legacy single-stream config to multi-stream format", () => {
    const legacy: LegacyStreamConfig = {
      streamId: "pointcloud",
      streamEvent: "pointcloud",
      subscribeEvent: "subscribe_stream",
      subscribeParam: "pointcloud",
      fieldMappings: {
        point_cloud: "points",
        avg_distance: "stats.avg_distance",
      },
    };

    const result = normalizeConfig(legacy);
    expect(result).not.toBeNull();
    expect(result!.streams).toHaveLength(1);
    expect(result!.streams[0].streamId).toBe("pointcloud");
    expect(result!.fieldMappings).toEqual(legacy.fieldMappings);
  });

  it("should handle legacy config with empty fieldMappings", () => {
    const legacy = {
      streamId: "telemetry",
      streamEvent: "telemetry",
      subscribeEvent: "subscribe_stream",
      subscribeParam: "telemetry",
      fieldMappings: {},
    };

    const result = normalizeConfig(legacy);
    expect(result!.streams).toHaveLength(1);
    expect(result!.fieldMappings).toEqual({});
  });
});

describe("Multi-Stream Field Mapping", () => {
  it("should extract correct fields from pointcloud stream data", () => {
    const fieldMappings = {
      point_cloud: "pointcloud:points",
      point_count: "pointcloud:stats.point_count",
      avg_distance: "pointcloud:stats.avg_distance",
    };

    const rawData = {
      drone_id: "quiver_001",
      points: [{ x: 100, y: 200, z: 0, distance: 223.6, intensity: 0.8 }],
      stats: {
        point_count: 360,
        valid_points: 340,
        avg_distance: 1500.5,
        avg_quality: 28,
      },
    };

    const result = applyStreamData("pointcloud", rawData, fieldMappings, {});
    expect(result.point_cloud).toEqual(rawData.points);
    expect(result.point_count).toBe(360);
    expect(result.avg_distance).toBe(1500.5);
  });

  it("should extract correct fields from telemetry stream data", () => {
    const fieldMappings = {
      altitude: "telemetry:altitude",
      battery: "telemetry:battery_level",
      gps_lat: "telemetry:gps.latitude",
    };

    const rawData = {
      altitude: 150.5,
      battery_level: 87,
      gps: { latitude: 51.5074, longitude: -0.1278 },
      speed: 12.3,
    };

    const result = applyStreamData("telemetry", rawData, fieldMappings, {});
    expect(result.altitude).toBe(150.5);
    expect(result.battery).toBe(87);
    expect(result.gps_lat).toBe(51.5074);
  });

  it("should only apply fields matching the stream ID", () => {
    const fieldMappings = {
      point_cloud: "pointcloud:points",
      altitude: "telemetry:altitude",
    };

    const pointcloudData = {
      points: [{ x: 1, y: 2, z: 0 }],
    };

    // When processing pointcloud data, only pointcloud fields should be applied
    const result = applyStreamData("pointcloud", pointcloudData, fieldMappings, {});
    expect(result.point_cloud).toEqual(pointcloudData.points);
    expect(result.altitude).toBeUndefined();
  });

  it("should merge data from multiple streams without overwriting", () => {
    const fieldMappings = {
      point_cloud: "pointcloud:points",
      point_count: "pointcloud:stats.point_count",
      altitude: "telemetry:altitude",
      battery: "telemetry:battery_level",
    };

    // First: pointcloud data arrives
    const pointcloudData = {
      points: [{ x: 100, y: 200, z: 0 }],
      stats: { point_count: 360 },
    };
    let merged = applyStreamData("pointcloud", pointcloudData, fieldMappings, {});
    expect(merged.point_cloud).toEqual(pointcloudData.points);
    expect(merged.point_count).toBe(360);
    expect(merged.altitude).toBeUndefined();

    // Then: telemetry data arrives — should merge, not overwrite
    const telemetryData = {
      altitude: 150.5,
      battery_level: 87,
    };
    merged = applyStreamData("telemetry", telemetryData, fieldMappings, merged);
    expect(merged.point_cloud).toEqual(pointcloudData.points); // preserved
    expect(merged.point_count).toBe(360); // preserved
    expect(merged.altitude).toBe(150.5); // added
    expect(merged.battery).toBe(87); // added
  });

  it("should update fields when new data arrives from the same stream", () => {
    const fieldMappings = {
      point_count: "pointcloud:stats.point_count",
      avg_distance: "pointcloud:stats.avg_distance",
    };

    let existing = { point_count: 360, avg_distance: 1500 };

    const newData = {
      stats: { point_count: 380, avg_distance: 1600 },
    };

    const result = applyStreamData("pointcloud", newData, fieldMappings, existing);
    expect(result.point_count).toBe(380);
    expect(result.avg_distance).toBe(1600);
  });

  it("should handle missing nested fields gracefully", () => {
    const fieldMappings = {
      deep_value: "pointcloud:stats.nested.deep.value",
    };

    const rawData = { stats: {} };
    const result = applyStreamData("pointcloud", rawData, fieldMappings, {});
    expect(result.deep_value).toBeUndefined();
  });

  it("should ignore mappings without colon separator", () => {
    const fieldMappings = {
      bad_mapping: "no_colon_here",
      good_mapping: "pointcloud:stats.point_count",
    };

    const rawData = { stats: { point_count: 100 } };
    const result = applyStreamData("pointcloud", rawData, fieldMappings, {});
    expect(result.bad_mapping).toBeUndefined();
    expect(result.good_mapping).toBe(100);
  });
});

describe("Multi-Stream Subscription Deduplication", () => {
  it("should deduplicate stream subscriptions", () => {
    const config: MultiStreamConfig = {
      streams: [
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["points"],
          fieldAliases: {},
        },
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["stats.avg_distance"],
          fieldAliases: {},
        },
      ],
      fieldMappings: {
        point_cloud: "pointcloud:points",
        avg_distance: "pointcloud:stats.avg_distance",
      },
    };

    // Simulate deduplication logic from AppRenderer
    const subscribedStreams = new Set<string>();
    const subscriptions: string[] = [];

    for (const sub of config.streams) {
      if (subscribedStreams.has(sub.streamId)) continue;
      subscribedStreams.add(sub.streamId);
      subscriptions.push(sub.streamId);
    }

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toBe("pointcloud");
  });

  it("should subscribe to multiple different streams", () => {
    const config: MultiStreamConfig = {
      streams: [
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["points"],
          fieldAliases: {},
        },
        {
          streamId: "telemetry",
          streamEvent: "telemetry",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "telemetry",
          selectedFields: ["altitude"],
          fieldAliases: {},
        },
        {
          streamId: "camera_status",
          streamEvent: "camera_status",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "camera_status",
          selectedFields: ["recording"],
          fieldAliases: {},
        },
      ],
      fieldMappings: {
        point_cloud: "pointcloud:points",
        altitude: "telemetry:altitude",
        recording: "camera_status:recording",
      },
    };

    const subscribedStreams = new Set<string>();
    for (const sub of config.streams) {
      subscribedStreams.add(sub.streamId);
    }

    expect(subscribedStreams.size).toBe(3);
  });
});

describe("Multi-Stream with Custom App Sources", () => {
  it("should handle app: prefixed stream IDs", () => {
    const config: MultiStreamConfig = {
      streams: [
        {
          streamId: "app:weather-station",
          streamEvent: "app_data",
          subscribeEvent: "subscribe_app",
          subscribeParam: "weather-station",
          selectedFields: ["temperature", "humidity"],
          fieldAliases: {},
        },
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["points"],
          fieldAliases: {},
        },
      ],
      fieldMappings: {
        temperature: "app:weather-station:temperature",
        humidity: "app:weather-station:humidity",
        point_cloud: "pointcloud:points",
      },
    };

    // Separate built-in and app streams
    const builtInStreams: string[] = [];
    const appStreams: string[] = [];

    for (const sub of config.streams) {
      if (sub.streamId.startsWith("app:")) {
        appStreams.push(sub.streamId.replace("app:", ""));
      } else {
        builtInStreams.push(sub.streamId);
      }
    }

    expect(builtInStreams).toEqual(["pointcloud"]);
    expect(appStreams).toEqual(["weather-station"]);
  });

  it("should apply field mappings from app: streams correctly", () => {
    const fieldMappings = {
      temperature: "app:weather-station:temperature",
      point_cloud: "pointcloud:points",
    };

    const appData = { temperature: 22.5, humidity: 65 };
    const result = applyStreamData("app:weather-station", appData, fieldMappings, {});
    expect(result.temperature).toBe(22.5);
    expect(result.point_cloud).toBeUndefined(); // different stream
  });
});

describe("Field Alias Support", () => {
  it("should generate unique widget field names with aliases", () => {
    // When two streams have fields with the same name (e.g., "timestamp"),
    // aliases prevent collisions
    const config: MultiStreamConfig = {
      streams: [
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["timestamp", "stats.point_count"],
          fieldAliases: { timestamp: "pc_timestamp" },
        },
        {
          streamId: "telemetry",
          streamEvent: "telemetry",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "telemetry",
          selectedFields: ["timestamp", "altitude"],
          fieldAliases: { timestamp: "telem_timestamp" },
        },
      ],
      fieldMappings: {
        pc_timestamp: "pointcloud:timestamp",
        telem_timestamp: "telemetry:timestamp",
        point_count: "pointcloud:stats.point_count",
        altitude: "telemetry:altitude",
      },
    };

    const pcData = { timestamp: "2026-02-19T23:00:00Z", stats: { point_count: 360 } };
    const telemData = { timestamp: "2026-02-19T23:00:01Z", altitude: 150 };

    let merged = applyStreamData("pointcloud", pcData, config.fieldMappings, {});
    merged = applyStreamData("telemetry", telemData, config.fieldMappings, merged);

    expect(merged.pc_timestamp).toBe("2026-02-19T23:00:00Z");
    expect(merged.telem_timestamp).toBe("2026-02-19T23:00:01Z");
    expect(merged.point_count).toBe(360);
    expect(merged.altitude).toBe(150);
  });
});

describe("Backward Compatibility", () => {
  it("should handle existing RPLidar Point Cloud Viewer app (legacy format)", () => {
    // This is the format used by the manually created RPLidar Point Cloud Viewer
    const legacyConfig = {
      streamId: "pointcloud",
      streamEvent: "pointcloud",
      subscribeEvent: "subscribe_stream",
      subscribeParam: "pointcloud",
      fieldMappings: {
        point_cloud: "points",
        drone_id: "drone_id",
        point_count: "stats.point_count",
        valid_points: "stats.valid_points",
        avg_distance: "stats.avg_distance",
        avg_quality: "stats.avg_quality",
        min_distance: "stats.min_distance",
        max_distance: "stats.max_distance",
      },
    };

    const normalized = normalizeConfig(legacyConfig);
    expect(normalized).not.toBeNull();
    expect(normalized!.streams).toHaveLength(1);
    expect(normalized!.streams[0].streamId).toBe("pointcloud");
    // Legacy fieldMappings are preserved as-is
    expect(normalized!.fieldMappings.point_cloud).toBe("points");
    expect(normalized!.fieldMappings.avg_distance).toBe("stats.avg_distance");
  });

  it("should handle existing LiDAR Stats Monitor app (new format)", () => {
    // This is the format generated by the updated AppBuilder
    const newConfig: MultiStreamConfig = {
      streams: [
        {
          streamId: "pointcloud",
          streamEvent: "pointcloud",
          subscribeEvent: "subscribe_stream",
          subscribeParam: "pointcloud",
          selectedFields: ["points", "stats.avg_distance", "drone_id"],
          fieldAliases: {},
        },
      ],
      fieldMappings: {
        points: "pointcloud:points",
        avg_distance: "pointcloud:stats.avg_distance",
        drone_id: "pointcloud:drone_id",
      },
    };

    const normalized = normalizeConfig(newConfig);
    expect(normalized).not.toBeNull();
    expect(normalized!.streams).toHaveLength(1);
    expect(normalized!.fieldMappings.points).toBe("pointcloud:points");
  });
});

describe("getNestedValue helper", () => {
  it("should extract top-level values", () => {
    expect(getNestedValue({ foo: 42 }, "foo")).toBe(42);
  });

  it("should extract nested values", () => {
    expect(getNestedValue({ a: { b: { c: 99 } } }, "a.b.c")).toBe(99);
  });

  it("should return undefined for missing paths", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, "a.c")).toBeUndefined();
    expect(getNestedValue(null, "a")).toBeUndefined();
    expect(getNestedValue(undefined, "a")).toBeUndefined();
  });

  it("should handle array access via numeric keys", () => {
    expect(getNestedValue({ items: [10, 20, 30] }, "items.1")).toBe(20);
  });
});
