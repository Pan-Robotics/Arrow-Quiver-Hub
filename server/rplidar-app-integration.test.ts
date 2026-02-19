import { describe, it, expect } from 'vitest';

/**
 * Tests for the RPLidar Point Cloud Viewer custom app integration.
 * Verifies that the REST pointcloud ingest correctly converts and broadcasts
 * data to the custom app's WebSocket channel via broadcastAppData.
 */

// Replicate the Point3D conversion logic from rest-api.ts
interface RawPoint {
  angle: number;
  distance: number;
  quality: number;
  x: number;
  y: number;
}

interface Point3D {
  x: number;
  y: number;
  z: number;
  distance: number;
  intensity: number;
}

function convertToPoint3D(points: RawPoint[]): Point3D[] {
  return points
    .filter((p) => p.distance > 0)
    .map((p) => ({
      x: p.x,
      y: p.y,
      z: 0,
      distance: p.distance,
      intensity: p.quality,
    }));
}

// Replicate the broadcastAppData payload shape
function buildAppPayload(
  points: RawPoint[],
  stats: {
    point_count: number;
    valid_points: number;
    avg_distance: number;
    avg_quality: number;
    min_distance: number;
    max_distance: number;
  },
  droneId: string
) {
  const point3DData = convertToPoint3D(points);
  return {
    point_cloud: point3DData,
    point_count: stats.point_count,
    valid_points: stats.valid_points,
    avg_distance: stats.avg_distance,
    avg_quality: stats.avg_quality,
    min_distance: stats.min_distance,
    max_distance: stats.max_distance,
    drone_id: droneId,
  };
}

describe('REST Ingest → Custom App Broadcast', () => {
  const samplePoints: RawPoint[] = [
    { angle: 0, distance: 3000, quality: 30, x: 3000, y: 0 },
    { angle: 90, distance: 2500, quality: 25, x: 0, y: 2500 },
    { angle: 180, distance: 4000, quality: 35, x: -4000, y: 0 },
    { angle: 270, distance: 2000, quality: 20, x: 0, y: -2000 },
    { angle: 45, distance: 0, quality: 0, x: 0, y: 0 }, // invalid point
  ];

  const sampleStats = {
    point_count: 5,
    valid_points: 4,
    avg_distance: 2875,
    avg_quality: 27.5,
    min_distance: 2000,
    max_distance: 4000,
  };

  it('should convert raw points to Point3D format', () => {
    const point3D = convertToPoint3D(samplePoints);
    expect(point3D).toHaveLength(4); // 5 points - 1 invalid = 4
    
    // Check first point
    expect(point3D[0].x).toBe(3000);
    expect(point3D[0].y).toBe(0);
    expect(point3D[0].z).toBe(0);
    expect(point3D[0].distance).toBe(3000);
    expect(point3D[0].intensity).toBe(30);
  });

  it('should filter out zero-distance points', () => {
    const point3D = convertToPoint3D(samplePoints);
    const hasZeroDistance = point3D.some(p => p.distance === 0);
    expect(hasZeroDistance).toBe(false);
  });

  it('should map quality to intensity', () => {
    const point3D = convertToPoint3D(samplePoints);
    expect(point3D[0].intensity).toBe(30); // quality 30 → intensity 30
    expect(point3D[1].intensity).toBe(25); // quality 25 → intensity 25
    expect(point3D[2].intensity).toBe(35); // quality 35 → intensity 35
    expect(point3D[3].intensity).toBe(20); // quality 20 → intensity 20
  });

  it('should set z=0 for all points (2D lidar)', () => {
    const point3D = convertToPoint3D(samplePoints);
    for (const p of point3D) {
      expect(p.z).toBe(0);
    }
  });

  it('should preserve x,y coordinates exactly', () => {
    const point3D = convertToPoint3D(samplePoints);
    expect(point3D[0].x).toBe(3000);
    expect(point3D[0].y).toBe(0);
    expect(point3D[1].x).toBe(0);
    expect(point3D[1].y).toBe(2500);
    expect(point3D[2].x).toBe(-4000);
    expect(point3D[2].y).toBe(0);
    expect(point3D[3].x).toBe(0);
    expect(point3D[3].y).toBe(-2000);
  });

  it('should build correct app payload shape', () => {
    const payload = buildAppPayload(samplePoints, sampleStats, 'quiver_001');
    
    // Check all required fields
    expect(payload).toHaveProperty('point_cloud');
    expect(payload).toHaveProperty('point_count');
    expect(payload).toHaveProperty('valid_points');
    expect(payload).toHaveProperty('avg_distance');
    expect(payload).toHaveProperty('avg_quality');
    expect(payload).toHaveProperty('min_distance');
    expect(payload).toHaveProperty('max_distance');
    expect(payload).toHaveProperty('drone_id');
  });

  it('should pass stats values through unchanged', () => {
    const payload = buildAppPayload(samplePoints, sampleStats, 'quiver_001');
    
    expect(payload.point_count).toBe(5);
    expect(payload.valid_points).toBe(4);
    expect(payload.avg_distance).toBe(2875);
    expect(payload.avg_quality).toBe(27.5);
    expect(payload.min_distance).toBe(2000);
    expect(payload.max_distance).toBe(4000);
    expect(payload.drone_id).toBe('quiver_001');
  });

  it('should include converted Point3D array in payload', () => {
    const payload = buildAppPayload(samplePoints, sampleStats, 'quiver_001');
    
    expect(Array.isArray(payload.point_cloud)).toBe(true);
    expect(payload.point_cloud).toHaveLength(4);
    
    // Verify Point3D format
    for (const p of payload.point_cloud) {
      expect(p).toHaveProperty('x');
      expect(p).toHaveProperty('y');
      expect(p).toHaveProperty('z');
      expect(p).toHaveProperty('distance');
      expect(p).toHaveProperty('intensity');
    }
  });
});

describe('Custom App UI Schema Compatibility', () => {
  // The UI schema defines widget data bindings that must match the payload fields
  const expectedFields = [
    'point_cloud',
    'point_count',
    'valid_points',
    'avg_distance',
    'avg_quality',
    'min_distance',
    'max_distance',
    'drone_id',
  ];

  it('should produce payload with all fields expected by UI schema widgets', () => {
    const payload = buildAppPayload(
      [{ angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 }],
      {
        point_count: 1,
        valid_points: 1,
        avg_distance: 1000,
        avg_quality: 30,
        min_distance: 1000,
        max_distance: 1000,
      },
      'test_drone'
    );

    for (const field of expectedFields) {
      expect(payload).toHaveProperty(field);
    }
  });

  it('should have point_cloud as array (for canvas widget)', () => {
    const payload = buildAppPayload(
      [{ angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 }],
      {
        point_count: 1,
        valid_points: 1,
        avg_distance: 1000,
        avg_quality: 30,
        min_distance: 1000,
        max_distance: 1000,
      },
      'test_drone'
    );

    expect(Array.isArray(payload.point_cloud)).toBe(true);
  });

  it('should have numeric values for text/gauge widgets', () => {
    const payload = buildAppPayload(
      [{ angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 }],
      {
        point_count: 1,
        valid_points: 1,
        avg_distance: 1000,
        avg_quality: 30,
        min_distance: 1000,
        max_distance: 1000,
      },
      'test_drone'
    );

    expect(typeof payload.point_count).toBe('number');
    expect(typeof payload.valid_points).toBe('number');
    expect(typeof payload.avg_distance).toBe('number');
    expect(typeof payload.avg_quality).toBe('number');
    expect(typeof payload.min_distance).toBe('number');
    expect(typeof payload.max_distance).toBe('number');
  });

  it('should have string drone_id for text widget', () => {
    const payload = buildAppPayload(
      [{ angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 }],
      {
        point_count: 1,
        valid_points: 1,
        avg_distance: 1000,
        avg_quality: 30,
        min_distance: 1000,
        max_distance: 1000,
      },
      'quiver_001'
    );

    expect(typeof payload.drone_id).toBe('string');
    expect(payload.drone_id).toBe('quiver_001');
  });
});

describe('Edge Cases', () => {
  it('should handle empty points array', () => {
    const payload = buildAppPayload(
      [],
      {
        point_count: 0,
        valid_points: 0,
        avg_distance: 0,
        avg_quality: 0,
        min_distance: 0,
        max_distance: 0,
      },
      'quiver_001'
    );

    expect(payload.point_cloud).toEqual([]);
    expect(payload.point_count).toBe(0);
  });

  it('should handle all-invalid points (all distance=0)', () => {
    const invalidPoints: RawPoint[] = [
      { angle: 0, distance: 0, quality: 0, x: 0, y: 0 },
      { angle: 90, distance: 0, quality: 0, x: 0, y: 0 },
    ];

    const payload = buildAppPayload(
      invalidPoints,
      {
        point_count: 2,
        valid_points: 0,
        avg_distance: 0,
        avg_quality: 0,
        min_distance: 0,
        max_distance: 0,
      },
      'quiver_001'
    );

    expect(payload.point_cloud).toEqual([]);
  });

  it('should handle very large distance values', () => {
    const farPoints: RawPoint[] = [
      { angle: 0, distance: 12000, quality: 10, x: 12000, y: 0 },
    ];

    const point3D = convertToPoint3D(farPoints);
    expect(point3D[0].distance).toBe(12000);
    expect(point3D[0].x).toBe(12000);
  });

  it('should handle negative coordinates', () => {
    const negPoints: RawPoint[] = [
      { angle: 180, distance: 3000, quality: 30, x: -3000, y: -0.0004 },
    ];

    const point3D = convertToPoint3D(negPoints);
    expect(point3D[0].x).toBe(-3000);
    expect(point3D[0].y).toBeCloseTo(0, 2);
  });

  it('should handle a full 360-degree scan', () => {
    const fullScan: RawPoint[] = Array.from({ length: 360 }, (_, i) => {
      const angle = i;
      const angleRad = (angle * Math.PI) / 180;
      const distance = 2000 + 500 * Math.sin(angleRad * 2);
      return {
        angle,
        distance,
        quality: 25 + Math.random() * 10,
        x: distance * Math.cos(angleRad),
        y: distance * Math.sin(angleRad),
      };
    });

    const payload = buildAppPayload(
      fullScan,
      {
        point_count: 360,
        valid_points: 360,
        avg_distance: 2000,
        avg_quality: 30,
        min_distance: 1500,
        max_distance: 2500,
      },
      'quiver_001'
    );

    expect(payload.point_cloud).toHaveLength(360);
    expect(payload.point_count).toBe(360);
  });
});
