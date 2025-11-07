/**
 * REST API endpoints for external integrations
 * These endpoints are designed for non-tRPC clients (e.g., Python scripts)
 */

import { Router, Request, Response } from "express";
import {
  validateApiKey,
  upsertDrone,
  insertScan,
} from "./db";
import { broadcastPointCloud } from "./websocket";
import type { PointCloudMessage } from "./websocket";

const router = Router();

// In-memory buffer for recent scans (for polling fallback)
const lastScans = new Map<string, PointCloudMessage>();

/**
 * POST /api/rest/pointcloud/ingest
 * Receive point cloud data from companion computer
 * 
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   timestamp: string (ISO format),
 *   points: Array<{angle, distance, quality, x, y}>,
 *   stats: {point_count, valid_points, min_distance, max_distance, avg_distance, avg_quality}
 * }
 */
router.post("/pointcloud/ingest", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, timestamp, points, stats } = req.body;

    // Validate required fields
    if (!api_key || !drone_id || !timestamp || !points || !stats) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, timestamp, points, stats",
      });
    }

    // Validate API key
    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({
        success: false,
        error: "Invalid API key",
      });
    }

    // Verify drone ID matches API key
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({
        success: false,
        error: "Drone ID mismatch",
      });
    }

    // Validate data types
    if (!Array.isArray(points)) {
      return res.status(400).json({
        success: false,
        error: "points must be an array",
      });
    }

    if (typeof stats !== "object" || stats === null) {
      return res.status(400).json({
        success: false,
        error: "stats must be an object",
      });
    }

    // Validate stats fields
    const requiredStatsFields = [
      "point_count",
      "valid_points",
      "min_distance",
      "max_distance",
      "avg_distance",
      "avg_quality",
    ];
    for (const field of requiredStatsFields) {
      if (typeof stats[field] !== "number") {
        return res.status(400).json({
          success: false,
          error: `stats.${field} must be a number`,
        });
      }
    }

    // Validate point structure
    for (let i = 0; i < Math.min(points.length, 5); i++) {
      const point = points[i];
      const requiredPointFields = ["angle", "distance", "quality", "x", "y"];
      for (const field of requiredPointFields) {
        if (typeof point[field] !== "number") {
          return res.status(400).json({
            success: false,
            error: `points[${i}].${field} must be a number`,
          });
        }
      }
    }

    // Update drone last seen
    await upsertDrone({
      droneId: drone_id,
      lastSeen: new Date(timestamp),
      isActive: true,
    });

    // Store scan metadata in database
    await insertScan({
      droneId: drone_id,
      timestamp: new Date(timestamp),
      pointCount: stats.point_count,
      minDistance: Math.round(stats.min_distance),
      maxDistance: Math.round(stats.max_distance),
      avgQuality: Math.round(stats.avg_quality),
    });

    // Broadcast to WebSocket clients
    const message: PointCloudMessage = {
      drone_id,
      timestamp,
      points,
      stats,
    };
    // Store in memory for polling fallback
    lastScans.set(drone_id, message);

    broadcastPointCloud(message);

    // Return success
    return res.status(200).json({
      success: true,
      message: "Point cloud data received",
      stats: {
        drone_id,
        point_count: stats.point_count,
        timestamp,
      },
    });
  } catch (error) {
    console.error("Error in /api/rest/pointcloud/ingest:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/rest/health
 * Health check endpoint
 */
router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/rest/pointcloud/latest/:droneId
 * Get latest scan for a specific drone (polling fallback)
 */
router.get("/pointcloud/latest/:droneId", (req: Request, res: Response) => {
  try {
    const { droneId } = req.params;
    
    const latestScan = lastScans.get(droneId);
    
    if (!latestScan) {
      return res.status(404).json({
        success: false,
        error: "No data available for this drone",
        drone_id: droneId,
      });
    }

    return res.status(200).json({
      success: true,
      data: latestScan,
    });
  } catch (error) {
    console.error("Error in /api/rest/pointcloud/latest:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
