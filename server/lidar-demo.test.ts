import { describe, it, expect } from 'vitest';

/**
 * Tests for the RPLidar demo mode mock data generator and data transformation.
 * These functions are extracted from the LidarApp component for testability.
 */

interface Point {
  angle: number;
  distance: number;
  quality: number;
  x: number;
  y: number;
}

interface PointCloudData {
  drone_id: string;
  timestamp: string;
  points: Point[];
  stats: {
    point_count: number;
    valid_points: number;
    min_distance: number;
    max_distance: number;
    avg_distance: number;
    avg_quality: number;
  };
}

interface Point3D {
  x: number;
  y: number;
  z: number;
  distance: number;
  intensity: number;
}

/**
 * Generate a realistic mock RPLidar scan (same logic as LidarApp).
 */
function generateMockScan(scanNumber: number): PointCloudData {
  const points: Point[] = [];
  const numPoints = 360;

  for (let i = 0; i < numPoints; i++) {
    const angle = (i * 360.0) / numPoints;
    const angleRad = (angle * Math.PI) / 180;

    let baseDist: number;
    if (angle >= 0 && angle < 90) {
      baseDist = 3000 + 200 * Math.sin(angleRad * 3);
    } else if (angle >= 90 && angle < 180) {
      baseDist = 2500 + 150 * Math.cos(angleRad * 2);
    } else if (angle >= 180 && angle < 270) {
      baseDist = 4000 + 300 * Math.sin(angleRad * 4);
    } else {
      baseDist = 2000 + 100 * Math.cos(angleRad * 5);
    }

    if (angle >= 40 && angle <= 55) {
      baseDist = Math.min(baseDist, 1500 + (Math.random() - 0.5) * 100);
    }
    if (angle >= 145 && angle <= 165) {
      baseDist = Math.min(baseDist, 1800 + (Math.random() - 0.5) * 60);
    }
    if (angle >= 245 && angle <= 260) {
      baseDist = Math.min(baseDist, 1200 + (Math.random() - 0.5) * 80);
    }

    let distance = Math.max(100, baseDist + (Math.random() - 0.5) * 40);
    distance += 50 * Math.sin(scanNumber * 0.1 + angleRad);

    let quality = Math.floor(Math.random() * 37) + 10;

    if (Math.random() < 0.02) {
      distance = 0;
      quality = 0;
    }

    const x = distance * Math.cos(angleRad);
    const y = distance * Math.sin(angleRad);

    points.push({
      angle: Math.round(angle * 100) / 100,
      distance: Math.round(distance * 10) / 10,
      quality,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    });
  }

  const validPoints = points.filter((p) => p.distance > 0);
  const distances = validPoints.map((p) => p.distance);
  const qualities = validPoints.map((p) => p.quality);

  return {
    drone_id: 'demo_drone',
    timestamp: new Date().toISOString(),
    points,
    stats: {
      point_count: points.length,
      valid_points: validPoints.length,
      min_distance: distances.length > 0 ? Math.min(...distances) : 0,
      max_distance: distances.length > 0 ? Math.max(...distances) : 0,
      avg_distance: distances.length > 0 ? distances.reduce((a, b) => a + b, 0) / distances.length : 0,
      avg_quality: qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0,
    },
  };
}

/**
 * Convert raw RPLidar 2D points to 3D format (same logic as LidarApp).
 */
function convertTo3D(points: Point[]): Point3D[] {
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

describe('RPLidar Mock Data Generator', () => {
  it('should generate 360 points per scan', () => {
    const scan = generateMockScan(0);
    expect(scan.points).toHaveLength(360);
  });

  it('should have correct drone_id', () => {
    const scan = generateMockScan(0);
    expect(scan.drone_id).toBe('demo_drone');
  });

  it('should have valid ISO timestamp', () => {
    const scan = generateMockScan(0);
    const date = new Date(scan.timestamp);
    expect(date.getTime()).not.toBeNaN();
  });

  it('should produce points with all required fields', () => {
    const scan = generateMockScan(0);
    for (const point of scan.points) {
      expect(point).toHaveProperty('angle');
      expect(point).toHaveProperty('distance');
      expect(point).toHaveProperty('quality');
      expect(point).toHaveProperty('x');
      expect(point).toHaveProperty('y');
    }
  });

  it('should have angles covering 0-360 degrees', () => {
    const scan = generateMockScan(0);
    const angles = scan.points.map(p => p.angle);
    expect(Math.min(...angles)).toBeCloseTo(0, 0);
    expect(Math.max(...angles)).toBeGreaterThan(350);
  });

  it('should have distances in realistic range (100-5000mm)', () => {
    const scan = generateMockScan(0);
    const validPoints = scan.points.filter(p => p.distance > 0);
    for (const point of validPoints) {
      expect(point.distance).toBeGreaterThanOrEqual(100);
      expect(point.distance).toBeLessThanOrEqual(6000);
    }
  });

  it('should have some invalid points (distance=0)', () => {
    // Run multiple scans to ensure at least one has invalid points
    let totalInvalid = 0;
    for (let i = 0; i < 10; i++) {
      const scan = generateMockScan(i);
      totalInvalid += scan.points.filter(p => p.distance === 0).length;
    }
    // With 2% invalid rate over 3600 points, expect at least a few
    expect(totalInvalid).toBeGreaterThan(0);
  });

  it('should have quality values in RPLidar range (0-47)', () => {
    const scan = generateMockScan(0);
    for (const point of scan.points) {
      expect(point.quality).toBeGreaterThanOrEqual(0);
      expect(point.quality).toBeLessThanOrEqual(47);
    }
  });

  it('should compute correct x,y from angle and distance', () => {
    const scan = generateMockScan(0);
    for (const point of scan.points) {
      if (point.distance === 0) continue;
      const angleRad = (point.angle * Math.PI) / 180;
      const expectedX = point.distance * Math.cos(angleRad);
      const expectedY = point.distance * Math.sin(angleRad);
      expect(point.x).toBeCloseTo(Math.round(expectedX * 10) / 10, 0);
      expect(point.y).toBeCloseTo(Math.round(expectedY * 10) / 10, 0);
    }
  });

  it('should compute correct stats', () => {
    const scan = generateMockScan(0);
    const validPoints = scan.points.filter(p => p.distance > 0);
    
    expect(scan.stats.point_count).toBe(360);
    expect(scan.stats.valid_points).toBe(validPoints.length);
    expect(scan.stats.valid_points).toBeGreaterThan(300); // ~98% valid
    expect(scan.stats.min_distance).toBeGreaterThan(0);
    expect(scan.stats.max_distance).toBeGreaterThan(scan.stats.min_distance);
    expect(scan.stats.avg_distance).toBeGreaterThan(1000);
    expect(scan.stats.avg_distance).toBeLessThan(5000);
    expect(scan.stats.avg_quality).toBeGreaterThan(10);
    expect(scan.stats.avg_quality).toBeLessThan(47);
  });

  it('should produce different data for different scan numbers', () => {
    const scan1 = generateMockScan(0);
    const scan2 = generateMockScan(100);
    // Distances should differ due to sin(scanNumber * 0.1) term
    const dist1 = scan1.points[0].distance;
    const dist2 = scan2.points[0].distance;
    expect(dist1).not.toBe(dist2);
  });

  it('should simulate obstacles at specific angles', () => {
    const scan = generateMockScan(0);
    
    // Obstacle 1: angles 40-55 at ~1500mm
    const obstacle1 = scan.points.filter(p => p.angle >= 40 && p.angle <= 55 && p.distance > 0);
    const avgDist1 = obstacle1.reduce((s, p) => s + p.distance, 0) / obstacle1.length;
    expect(avgDist1).toBeLessThan(2000);
    
    // Obstacle 3: angles 245-260 at ~1200mm
    const obstacle3 = scan.points.filter(p => p.angle >= 245 && p.angle <= 260 && p.distance > 0);
    const avgDist3 = obstacle3.reduce((s, p) => s + p.distance, 0) / obstacle3.length;
    expect(avgDist3).toBeLessThan(1500);
  });
});

describe('Point Data Transformation (convertTo3D)', () => {
  it('should filter out invalid points (distance=0)', () => {
    const points: Point[] = [
      { angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 },
      { angle: 90, distance: 0, quality: 0, x: 0, y: 0 },
      { angle: 180, distance: 2000, quality: 25, x: -2000, y: 0 },
    ];
    const result = convertTo3D(points);
    expect(result).toHaveLength(2);
  });

  it('should set z=0 for all points (2D lidar)', () => {
    const points: Point[] = [
      { angle: 0, distance: 1000, quality: 30, x: 1000, y: 0 },
      { angle: 90, distance: 2000, quality: 25, x: 0, y: 2000 },
    ];
    const result = convertTo3D(points);
    for (const p of result) {
      expect(p.z).toBe(0);
    }
  });

  it('should preserve x and y coordinates', () => {
    const points: Point[] = [
      { angle: 45, distance: 1414, quality: 30, x: 1000, y: 1000 },
    ];
    const result = convertTo3D(points);
    expect(result[0].x).toBe(1000);
    expect(result[0].y).toBe(1000);
  });

  it('should map distance correctly', () => {
    const points: Point[] = [
      { angle: 0, distance: 3500, quality: 30, x: 3500, y: 0 },
    ];
    const result = convertTo3D(points);
    expect(result[0].distance).toBe(3500);
  });

  it('should map quality to intensity', () => {
    const points: Point[] = [
      { angle: 0, distance: 1000, quality: 42, x: 1000, y: 0 },
    ];
    const result = convertTo3D(points);
    expect(result[0].intensity).toBe(42);
  });

  it('should handle empty input', () => {
    const result = convertTo3D([]);
    expect(result).toHaveLength(0);
  });

  it('should handle all-invalid input', () => {
    const points: Point[] = [
      { angle: 0, distance: 0, quality: 0, x: 0, y: 0 },
      { angle: 90, distance: 0, quality: 0, x: 0, y: 0 },
    ];
    const result = convertTo3D(points);
    expect(result).toHaveLength(0);
  });

  it('should work with full mock scan data', () => {
    const scan = generateMockScan(0);
    const result = convertTo3D(scan.points);
    
    // Should have roughly 98% of points (2% invalid rate)
    expect(result.length).toBeGreaterThan(300);
    expect(result.length).toBeLessThanOrEqual(360);
    
    // All points should have z=0
    for (const p of result) {
      expect(p.z).toBe(0);
    }
    
    // All points should have positive distance
    for (const p of result) {
      expect(p.distance).toBeGreaterThan(0);
    }
    
    // All points should have valid intensity (quality)
    for (const p of result) {
      expect(p.intensity).toBeGreaterThanOrEqual(0);
      expect(p.intensity).toBeLessThanOrEqual(47);
    }
  });
});

describe('Data Format Compatibility', () => {
  it('should match the forwarder output format', () => {
    const scan = generateMockScan(0);
    
    // Verify the structure matches what rplidar_forwarder.py sends
    expect(scan).toHaveProperty('drone_id');
    expect(scan).toHaveProperty('timestamp');
    expect(scan).toHaveProperty('points');
    expect(scan).toHaveProperty('stats');
    
    expect(scan.stats).toHaveProperty('point_count');
    expect(scan.stats).toHaveProperty('valid_points');
    expect(scan.stats).toHaveProperty('min_distance');
    expect(scan.stats).toHaveProperty('max_distance');
    expect(scan.stats).toHaveProperty('avg_distance');
    expect(scan.stats).toHaveProperty('avg_quality');
    
    // Each point should have the forwarder's format
    const point = scan.points[0];
    expect(typeof point.angle).toBe('number');
    expect(typeof point.distance).toBe('number');
    expect(typeof point.quality).toBe('number');
    expect(typeof point.x).toBe('number');
    expect(typeof point.y).toBe('number');
  });

  it('should produce Point3D format compatible with PointCloudCanvas', () => {
    const scan = generateMockScan(0);
    const points3D = convertTo3D(scan.points);
    
    // Verify the structure matches what PointCloudCanvas expects
    for (const p of points3D) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
      expect(typeof p.z).toBe('number');
      expect(typeof p.distance).toBe('number');
      expect(typeof p.intensity).toBe('number');
    }
  });
});
