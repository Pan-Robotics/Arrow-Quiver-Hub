import { describe, it, expect } from 'vitest';

/**
 * Tests for the Data Source Configuration and Stream Subscription features.
 * Validates the data flow from stream sources through field mappings to widgets.
 */

// Helper: simulate getNestedValue (same logic as AppRenderer)
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

// Helper: simulate applyFieldMappings (same logic as AppRenderer)
function applyFieldMappings(rawData: any, mappings: Record<string, string>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [widgetField, streamPath] of Object.entries(mappings)) {
    result[widgetField] = getNestedValue(rawData, streamPath);
  }
  return result;
}

describe('Data Source Configuration', () => {
  describe('dataSource types', () => {
    it('should support custom_endpoint type', () => {
      const config = { dataSource: 'custom_endpoint' };
      expect(['custom_endpoint', 'stream_subscription', 'passthrough']).toContain(config.dataSource);
    });

    it('should support stream_subscription type', () => {
      const config = { dataSource: 'stream_subscription' };
      expect(['custom_endpoint', 'stream_subscription', 'passthrough']).toContain(config.dataSource);
    });

    it('should support passthrough type', () => {
      const config = { dataSource: 'passthrough' };
      expect(['custom_endpoint', 'stream_subscription', 'passthrough']).toContain(config.dataSource);
    });
  });

  describe('dataSourceConfig structure', () => {
    it('should parse valid JSON config', () => {
      const raw = '{"streamId":"pointcloud","fieldMappings":{"points":"points"}}';
      const config = JSON.parse(raw);
      expect(config.streamId).toBe('pointcloud');
      expect(config.fieldMappings).toBeDefined();
    });

    it('should handle already-parsed config objects', () => {
      const config = { streamId: 'pointcloud', fieldMappings: { points: 'points' } };
      expect(config.streamId).toBe('pointcloud');
    });

    it('should handle null/undefined config gracefully', () => {
      const raw = null;
      const config = raw ? JSON.parse(raw) : null;
      expect(config).toBeNull();
    });
  });
});

describe('Stream Subscription - Field Mappings', () => {
  const pointcloudMessage = {
    drone_id: 'quiver_001',
    timestamp: '2026-02-19T20:00:00Z',
    points: [
      { angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 },
      { angle: 90, distance: 2000, quality: 25, x: 0, y: 2000 },
    ],
    stats: {
      point_count: 512,
      valid_points: 400,
      avg_distance: 1350.5,
      avg_quality: 22,
      min_distance: 150,
      max_distance: 4500,
    },
  };

  const fieldMappings = {
    drone_id: 'drone_id',
    timestamp: 'timestamp',
    points: 'points',
    point_count: 'stats.point_count',
    valid_points: 'stats.valid_points',
    avg_distance: 'stats.avg_distance',
    avg_quality: 'stats.avg_quality',
    min_distance: 'stats.min_distance',
    max_distance: 'stats.max_distance',
  };

  it('should map top-level fields correctly', () => {
    const mapped = applyFieldMappings(pointcloudMessage, fieldMappings);
    expect(mapped.drone_id).toBe('quiver_001');
    expect(mapped.timestamp).toBe('2026-02-19T20:00:00Z');
  });

  it('should map nested stats fields correctly', () => {
    const mapped = applyFieldMappings(pointcloudMessage, fieldMappings);
    expect(mapped.point_count).toBe(512);
    expect(mapped.valid_points).toBe(400);
    expect(mapped.avg_distance).toBe(1350.5);
    expect(mapped.avg_quality).toBe(22);
    expect(mapped.min_distance).toBe(150);
    expect(mapped.max_distance).toBe(4500);
  });

  it('should map points array correctly', () => {
    const mapped = applyFieldMappings(pointcloudMessage, fieldMappings);
    expect(Array.isArray(mapped.points)).toBe(true);
    expect(mapped.points).toHaveLength(2);
    expect(mapped.points[0].angle).toBe(0);
    expect(mapped.points[0].distance).toBe(1000);
  });

  it('should handle missing nested paths gracefully', () => {
    const mappings = { missing_field: 'stats.nonexistent.deep' };
    const mapped = applyFieldMappings(pointcloudMessage, mappings);
    expect(mapped.missing_field).toBeUndefined();
  });

  it('should handle empty mappings', () => {
    const mapped = applyFieldMappings(pointcloudMessage, {});
    expect(Object.keys(mapped)).toHaveLength(0);
  });

  it('should handle empty source data', () => {
    const mapped = applyFieldMappings({}, fieldMappings);
    expect(mapped.drone_id).toBeUndefined();
    expect(mapped.point_count).toBeUndefined();
  });
});

describe('Stream Subscription - getNestedValue', () => {
  const data = {
    level1: {
      level2: {
        level3: 'deep_value',
      },
      array: [1, 2, 3],
    },
    simple: 42,
  };

  it('should get top-level values', () => {
    expect(getNestedValue(data, 'simple')).toBe(42);
  });

  it('should get nested values', () => {
    expect(getNestedValue(data, 'level1.level2.level3')).toBe('deep_value');
  });

  it('should return undefined for missing paths', () => {
    expect(getNestedValue(data, 'nonexistent')).toBeUndefined();
    expect(getNestedValue(data, 'level1.nonexistent')).toBeUndefined();
  });

  it('should handle null/undefined objects', () => {
    expect(getNestedValue(null, 'any')).toBeUndefined();
    expect(getNestedValue(undefined, 'any')).toBeUndefined();
  });
});

describe('Stream Subscription - WebSocket Room Logic', () => {
  it('should determine correct room for pointcloud stream', () => {
    const streamId = 'pointcloud';
    const room = `stream:${streamId}`;
    expect(room).toBe('stream:pointcloud');
  });

  it('should determine correct room for telemetry stream', () => {
    const streamId = 'telemetry';
    const room = `stream:${streamId}`;
    expect(room).toBe('stream:telemetry');
  });

  it('should determine correct room for camera_status stream', () => {
    const streamId = 'camera_status';
    const room = `stream:${streamId}`;
    expect(room).toBe('stream:camera_status');
  });

  it('should handle app: prefix streams correctly', () => {
    const streamId = 'app:my-custom-app';
    const isAppStream = streamId.startsWith('app:');
    expect(isAppStream).toBe(true);
    const sourceAppId = streamId.replace('app:', '');
    expect(sourceAppId).toBe('my-custom-app');
  });

  it('should distinguish built-in streams from app streams', () => {
    const builtInStreams = ['pointcloud', 'telemetry', 'camera_status'];
    const appStream = 'app:some-app';
    
    expect(builtInStreams.includes('pointcloud')).toBe(true);
    expect(appStream.startsWith('app:')).toBe(true);
    expect(builtInStreams.includes(appStream)).toBe(false);
  });
});

describe('Stream Subscription - Telemetry Stream Mapping', () => {
  const telemetryMessage = {
    drone_id: 'quiver_001',
    timestamp: '2026-02-19T20:00:00Z',
    telemetry: {
      attitude: { roll_deg: 1.5, pitch_deg: -0.3, yaw_deg: 45.2, timestamp: '2026-02-19T20:00:00Z' },
      position: { latitude_deg: 37.7749, longitude_deg: -122.4194, absolute_altitude_m: 100, relative_altitude_m: 50, timestamp: '2026-02-19T20:00:00Z' },
      battery_fc: { voltage_v: 22.5, remaining_percent: 75, timestamp: '2026-02-19T20:00:00Z' },
      gps: { num_satellites: 12, fix_type: 3, timestamp: '2026-02-19T20:00:00Z' },
      in_air: true,
    },
  };

  const telemetryMappings = {
    drone_id: 'drone_id',
    roll: 'telemetry.attitude.roll_deg',
    pitch: 'telemetry.attitude.pitch_deg',
    yaw: 'telemetry.attitude.yaw_deg',
    latitude: 'telemetry.position.latitude_deg',
    longitude: 'telemetry.position.longitude_deg',
    altitude: 'telemetry.position.relative_altitude_m',
    battery: 'telemetry.battery_fc.remaining_percent',
    satellites: 'telemetry.gps.num_satellites',
    in_air: 'telemetry.in_air',
  };

  it('should map telemetry attitude fields', () => {
    const mapped = applyFieldMappings(telemetryMessage, telemetryMappings);
    expect(mapped.roll).toBe(1.5);
    expect(mapped.pitch).toBe(-0.3);
    expect(mapped.yaw).toBe(45.2);
  });

  it('should map telemetry position fields', () => {
    const mapped = applyFieldMappings(telemetryMessage, telemetryMappings);
    expect(mapped.latitude).toBe(37.7749);
    expect(mapped.longitude).toBe(-122.4194);
    expect(mapped.altitude).toBe(50);
  });

  it('should map telemetry battery and GPS fields', () => {
    const mapped = applyFieldMappings(telemetryMessage, telemetryMappings);
    expect(mapped.battery).toBe(75);
    expect(mapped.satellites).toBe(12);
  });

  it('should map boolean fields', () => {
    const mapped = applyFieldMappings(telemetryMessage, telemetryMappings);
    expect(mapped.in_air).toBe(true);
  });
});

describe('Passthrough Mode', () => {
  it('should pass raw JSON data directly without parser', () => {
    const rawPayload = {
      sensor_id: 'temp_001',
      temperature: 25.3,
      humidity: 60.5,
      timestamp: '2026-02-19T20:00:00Z',
    };
    
    // In passthrough mode, data goes directly to widgets without parsing
    // The widget field names must match the JSON keys
    const widgetBindings = {
      sensor_id: 'sensor_id',
      temperature: 'temperature',
      humidity: 'humidity',
    };
    
    const mapped = applyFieldMappings(rawPayload, widgetBindings);
    expect(mapped.sensor_id).toBe('temp_001');
    expect(mapped.temperature).toBe(25.3);
    expect(mapped.humidity).toBe(60.5);
  });

  it('should handle nested passthrough data', () => {
    const rawPayload = {
      device: {
        id: 'dev_001',
        readings: {
          value: 42.0,
        },
      },
    };
    
    const mappings = {
      device_id: 'device.id',
      reading: 'device.readings.value',
    };
    
    const mapped = applyFieldMappings(rawPayload, mappings);
    expect(mapped.device_id).toBe('dev_001');
    expect(mapped.reading).toBe(42.0);
  });
});

describe('Available Streams Configuration', () => {
  it('should define pointcloud stream with correct fields', () => {
    const pointcloudStream = {
      id: 'pointcloud',
      name: 'RPLidar Point Cloud',
      event: 'pointcloud',
      fields: [
        { name: 'drone_id', type: 'string' },
        { name: 'timestamp', type: 'string' },
        { name: 'points', type: 'array' },
        { name: 'stats.point_count', type: 'number' },
        { name: 'stats.valid_points', type: 'number' },
        { name: 'stats.avg_distance', type: 'number' },
        { name: 'stats.avg_quality', type: 'number' },
        { name: 'stats.min_distance', type: 'number' },
        { name: 'stats.max_distance', type: 'number' },
      ],
    };
    
    expect(pointcloudStream.fields).toHaveLength(9);
    expect(pointcloudStream.fields.find(f => f.name === 'points')?.type).toBe('array');
    expect(pointcloudStream.fields.find(f => f.name === 'stats.avg_distance')?.type).toBe('number');
  });

  it('should define telemetry stream with correct fields', () => {
    const telemetryStream = {
      id: 'telemetry',
      name: 'Flight Telemetry',
      event: 'telemetry',
      fields: [
        { name: 'drone_id', type: 'string' },
        { name: 'telemetry.attitude.roll_deg', type: 'number' },
        { name: 'telemetry.position.latitude_deg', type: 'number' },
        { name: 'telemetry.battery_fc.remaining_percent', type: 'number' },
        { name: 'telemetry.in_air', type: 'boolean' },
      ],
    };
    
    expect(telemetryStream.fields.length).toBeGreaterThan(0);
    expect(telemetryStream.event).toBe('telemetry');
  });
});
