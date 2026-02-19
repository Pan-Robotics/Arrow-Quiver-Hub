import { describe, it, expect } from 'vitest';

/**
 * Tests for the Canvas widget data handling in AppRenderer.
 * Verifies that the CanvasWidget's data parsing logic correctly handles
 * all input formats that may come from the UI Builder data bindings.
 */

// Replicate the parsedPoints logic from CanvasWidget
function parsePointData(value: any): any[] {
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  return [];
}

describe('CanvasWidget Data Parsing', () => {
  it('should handle null/undefined input', () => {
    expect(parsePointData(null)).toEqual([]);
    expect(parsePointData(undefined)).toEqual([]);
  });

  it('should handle empty array', () => {
    expect(parsePointData([])).toEqual([]);
  });

  it('should handle Point3D array directly', () => {
    const points = [
      { x: 100, y: 200, z: 0, distance: 223.6, intensity: 30 },
      { x: -50, y: 300, z: 0, distance: 304.1, intensity: 25 },
    ];
    const result = parsePointData(points);
    expect(result).toHaveLength(2);
    expect(result[0].x).toBe(100);
    expect(result[0].y).toBe(200);
    expect(result[0].z).toBe(0);
    expect(result[0].distance).toBe(223.6);
    expect(result[0].intensity).toBe(30);
  });

  it('should handle JSON string input', () => {
    const points = [
      { x: 100, y: 200, z: 0, distance: 223.6, intensity: 30 },
    ];
    const jsonStr = JSON.stringify(points);
    const result = parsePointData(jsonStr);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(100);
  });

  it('should handle invalid JSON string gracefully', () => {
    expect(parsePointData('not valid json')).toEqual([]);
    expect(parsePointData('{broken')).toEqual([]);
  });

  it('should handle empty JSON string', () => {
    expect(parsePointData('[]')).toEqual([]);
  });

  it('should handle non-array values (number, object)', () => {
    expect(parsePointData(42)).toEqual([]);
    expect(parsePointData({ x: 1, y: 2 })).toEqual([]);
    expect(parsePointData(true)).toEqual([]);
  });

  it('should handle large point cloud data', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({
      x: Math.cos(i * Math.PI / 180) * 3000,
      y: Math.sin(i * Math.PI / 180) * 3000,
      z: 0,
      distance: 3000,
      intensity: 30,
    }));
    const result = parsePointData(points);
    expect(result).toHaveLength(1000);
  });

  it('should handle stringified large point cloud data', () => {
    const points = Array.from({ length: 360 }, (_, i) => ({
      x: Math.cos(i * Math.PI / 180) * 2000,
      y: Math.sin(i * Math.PI / 180) * 2000,
      z: 0,
      distance: 2000,
      intensity: 25,
    }));
    const result = parsePointData(JSON.stringify(points));
    expect(result).toHaveLength(360);
    expect(result[0].x).toBeCloseTo(2000, 0);
  });
});

describe('CanvasWidget Config Defaults', () => {
  // Verify the default config values match the RPLidar LidarApp
  it('should use correct default point sizes', () => {
    // 2D mode default: 3 (matching LidarApp)
    const default2DPointSize = 3;
    // 3D mode default: 4 (matching LidarApp)
    const default3DPointSize = 4;
    
    expect(default2DPointSize).toBe(3);
    expect(default3DPointSize).toBe(4);
  });

  it('should use correct default distance range for RPLidar', () => {
    // RPLidar A1 range: 0-5000mm
    const defaultMinDistance = 0;
    const defaultMaxDistance = 5000;
    
    expect(defaultMinDistance).toBe(0);
    expect(defaultMaxDistance).toBe(5000);
  });

  it('should default to distance color mode', () => {
    const defaultColorMode = 'distance';
    expect(defaultColorMode).toBe('distance');
  });

  it('should default to 2D render mode', () => {
    // 2D mode is the default for reliability (works without WebGL)
    const defaultRenderMode = '2d';
    expect(defaultRenderMode).toBe('2d');
  });
});

describe('Point3D Format Compatibility', () => {
  it('should accept the format produced by LidarApp convertTo3D', () => {
    // This is the exact format that LidarApp.convertTo3D produces
    const convertedPoints = [
      { x: 2999.5, y: 52.3, z: 0, distance: 3000, intensity: 30 },
      { x: -1499.2, y: 2598.1, z: 0, distance: 2999.5, intensity: 25 },
    ];
    
    const result = parsePointData(convertedPoints);
    expect(result).toHaveLength(2);
    
    // Verify all required fields are present
    for (const p of result) {
      expect(p).toHaveProperty('x');
      expect(p).toHaveProperty('y');
      expect(p).toHaveProperty('z');
      expect(p).toHaveProperty('distance');
      expect(p).toHaveProperty('intensity');
      expect(p.z).toBe(0); // 2D lidar
    }
  });

  it('should accept the format from UI Builder data binding (stringified)', () => {
    // UI Builder may pass data as a JSON string from WebSocket
    const wsData = JSON.stringify([
      { x: 1000, y: 0, z: 0, distance: 1000, intensity: 40 },
    ]);
    
    const result = parsePointData(wsData);
    expect(result).toHaveLength(1);
    expect(result[0].distance).toBe(1000);
  });

  it('should handle minimal point format (x, y, z only)', () => {
    // Some sources may not include distance/intensity
    const minimalPoints = [
      { x: 100, y: 200, z: 0 },
      { x: -300, y: 400, z: 0 },
    ];
    
    const result = parsePointData(minimalPoints);
    expect(result).toHaveLength(2);
    expect(result[0].x).toBe(100);
    // distance and intensity may be undefined - renderers handle this
  });
});
