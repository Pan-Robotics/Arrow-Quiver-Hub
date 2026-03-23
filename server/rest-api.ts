/**
 * REST API endpoints for external integrations
 * These endpoints are designed for non-tRPC clients (e.g., Python scripts)
 */

import { Router, Request, Response } from "express";
import {
  validateApiKey,
  upsertDrone,
  insertScan,
  insertTelemetry,
  createFlightLog,
} from "./db";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import { broadcastPointCloud, broadcastTelemetry, broadcastCameraStatus, broadcastCameraStream, broadcastAppData } from "./websocket";
import type { PointCloudMessage } from "./websocket";
import { handlePayloadIngest } from "./payloadIngest";

const router = Router();

// In-memory buffer for recent scans (for polling fallback)
const lastScans = new Map<string, PointCloudMessage>();

// In-memory registry for active WebRTC stream URLs from companion computers
// Maps droneId -> { webrtcUrl, registeredAt, droneId }
export interface WebRTCStreamEntry {
  webrtcUrl: string;      // e.g. "https://quiver.tail1234.ts.net/api/webrtc?src=camera"
  registeredAt: number;   // Unix timestamp ms
  droneId: string;
}
export const webrtcStreamRegistry = new Map<string, WebRTCStreamEntry>();

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

    // Also broadcast to the RPLidar Point Cloud Viewer custom app
    // Convert raw 2D points to Point3D format for the canvas widget
    const point3DData = points
      .filter((p: any) => p.distance > 0)
      .map((p: any) => ({
        x: p.x,
        y: p.y,
        z: 0,
        distance: p.distance,
        intensity: p.quality,
      }));

    broadcastAppData('rplidar-pointcloud-viewer', {
      point_cloud: point3DData,
      point_count: stats.point_count,
      valid_points: stats.valid_points,
      avg_distance: stats.avg_distance,
      avg_quality: stats.avg_quality,
      min_distance: stats.min_distance,
      max_distance: stats.max_distance,
      drone_id,
    });

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

/**
 * POST /api/rest/telemetry/ingest
 * Receive telemetry data from companion computer
 * 
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   timestamp: string (ISO format),
 *   telemetry: {
 *     attitude: {roll_deg, pitch_deg, yaw_deg, timestamp},
 *     position: {latitude_deg, longitude_deg, absolute_altitude_m, relative_altitude_m, timestamp},
 *     gps: {num_satellites, fix_type, timestamp},
 *     battery_fc: {voltage_v, remaining_percent, timestamp},
 *     battery_uavcan: {voltage_v, current_a, temperature_k, state_of_charge_pct, state_of_health_pct, timestamp},
 *     in_air: boolean
 *   }
 * }
 */
router.post("/telemetry/ingest", async (req: Request, res: Response) => {
  try {
    console.log("[Telemetry REST] Received request", { hasBody: !!req.body });
    const { api_key, drone_id, timestamp, telemetry } = req.body;
    console.log("[Telemetry REST] Parsed fields", { api_key: api_key ? "present" : "missing", drone_id, timestamp: timestamp ? "present" : "missing", telemetry: telemetry ? "present" : "missing" });

    // Validate required fields
    if (!api_key || !drone_id || !timestamp || !telemetry) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, timestamp, telemetry",
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

    // Validate telemetry is an object
    if (typeof telemetry !== "object" || telemetry === null) {
      return res.status(400).json({
        success: false,
        error: "telemetry must be an object",
      });
    }

    // Update drone last seen
    await upsertDrone({
      droneId: drone_id,
      lastSeen: new Date(timestamp),
      isActive: true,
    });

    // Store telemetry in database
    await insertTelemetry({
      droneId: drone_id,
      timestamp: new Date(timestamp),
      telemetryData: telemetry,
    });

    // Broadcast to WebSocket clients
    const message = {
      drone_id,
      timestamp,
      telemetry,
    };
    broadcastTelemetry(message);

    // Return success
    return res.status(200).json({
      success: true,
      message: "Telemetry data received",
      stats: {
        drone_id,
        timestamp,
      },
    });
  } catch (error) {
    console.error("Error in /api/rest/telemetry/ingest:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/rest/camera/status
 * Receive camera status from companion computer
 * 
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   timestamp: number (Unix timestamp),
 *   connected: boolean,
 *   attitude?: { yaw: number, pitch: number, roll: number },
 *   recording?: boolean,
 *   hdr_enabled?: boolean,
 *   tf_card_present?: boolean,
 *   zoom_level?: number
 * }
 */
router.post("/camera/status", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, timestamp, connected, attitude, recording, hdr_enabled, tf_card_present, zoom_level } = req.body;

    // Validate required fields
    if (!api_key || !drone_id || timestamp === undefined || connected === undefined) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, timestamp, connected",
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

    // Broadcast camera status to WebSocket clients
    broadcastCameraStatus({
      drone_id,
      timestamp,
      connected,
      attitude,
      recording,
      hdr_enabled,
      tf_card_present,
      zoom_level,
    });

    return res.status(200).json({
      success: true,
      message: "Camera status received",
    });
  } catch (error) {
    console.error("Error in /api/rest/camera/status:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/rest/payload/:appId/ingest
 * Receive payload data for a custom app
 * 
 * Request body: any JSON payload
 * Response: parsed data
 */
router.post("/payload/:appId/ingest", handlePayloadIngest);

/**
 * POST /api/rest/test-connection
 * Test connectivity using an API key
 * Used by the Drone Config page to verify endpoints before deploying
 * 
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string
 * }
 * 
 * Response: { success: true, drone_id, endpoints: { health, pointcloud, telemetry, camera, websocket } }
 */
router.post("/test-connection", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { api_key, drone_id } = req.body;

    if (!api_key || !drone_id) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id",
      });
    }

    // Validate API key
    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({
        success: false,
        error: "Invalid API key",
        latency_ms: Date.now() - startTime,
      });
    }

    // Verify drone ID matches API key
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({
        success: false,
        error: "API key does not match drone_id",
        latency_ms: Date.now() - startTime,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Connection verified",
      drone_id,
      api_key_id: apiKeyRecord.id,
      api_key_description: apiKeyRecord.description,
      latency_ms: Date.now() - startTime,
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error in /api/rest/test-connection:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
      latency_ms: Date.now() - startTime,
    });
  }
});

/**
 * POST /api/rest/flightlog/upload
 * Upload a flight log file (.BIN or .log) from the companion computer.
 * Authenticated via API key. Stores file in S3 and metadata in DB.
 *
 * Request: multipart/form-data or JSON with base64 content
 * {
 *   api_key: string,
 *   drone_id: string,
 *   filename: string,
 *   content: string (base64 encoded file),
 *   description?: string
 * }
 */
router.post("/flightlog/upload", async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { api_key, drone_id, filename, content, description } = req.body;

    // Validate required fields
    if (!api_key || !drone_id || !filename || !content) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, filename, content (base64)",
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

    // Validate file extension
    const ext = filename.toLowerCase().split(".").pop();
    if (ext !== "bin" && ext !== "log") {
      return res.status(400).json({
        success: false,
        error: "Invalid file format. Only .BIN and .log files are accepted.",
      });
    }

    // Decode base64 content
    const buffer = Buffer.from(content, "base64");
    const fileSize = buffer.length;

    // Enforce 100MB limit
    if (fileSize > 100 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: "File too large. Maximum size is 100MB.",
      });
    }

    const format = ext === "log" ? "log" as const : "bin" as const;

    // Upload to S3
    const fileKey = `flight-logs/${drone_id}/${nanoid()}-${filename}`;
    const { url } = await storagePut(fileKey, buffer, "application/octet-stream");

    // Store metadata in DB
    await createFlightLog({
      droneId: drone_id,
      filename,
      fileSize,
      storageKey: fileKey,
      url,
      format,
      description: description || null,
      uploadSource: "api",
      uploadedBy: null,
    });

    // Update drone last seen
    await upsertDrone({
      droneId: drone_id,
      lastSeen: new Date(),
      isActive: true,
    });

    return res.status(200).json({
      success: true,
      message: "Flight log uploaded successfully",
      filename,
      file_size: fileSize,
      format,
      url,
      latency_ms: Date.now() - startTime,
    });
  } catch (error) {
    console.error("Error in /api/rest/flightlog/upload:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
      latency_ms: Date.now() - startTime,
    });
  }
});

/**
 * POST /api/rest/camera/stream-register
 * Register a WebRTC stream URL from the companion computer.
 * The companion provides the go2rtc WHEP signaling URL (exposed via Tailscale funnel).
 * The server stores it and notifies browser clients via WebSocket.
 * No proxying needed — WebRTC media flows peer-to-peer.
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   webrtc_url: string  (e.g. "https://quiver.tail1234.ts.net/api/webrtc?src=camera")
 * }
 */
router.post("/camera/stream-register", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, webrtc_url } = req.body;

    if (!api_key || !drone_id || !webrtc_url) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, webrtc_url",
      });
    }

    // Validate API key
    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }

    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    // Validate URL format
    try {
      new URL(webrtc_url);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid webrtc_url format" });
    }

    // Register the stream
    webrtcStreamRegistry.set(drone_id, {
      webrtcUrl: webrtc_url,
      registeredAt: Date.now(),
      droneId: drone_id,
    });

    console.log(`[WebRTC] Stream registered for ${drone_id}: ${webrtc_url}`);

    // Broadcast the WebRTC URL to browser clients via WebSocket
    broadcastCameraStream(drone_id, webrtc_url);

    return res.status(200).json({
      success: true,
      message: "WebRTC stream registered",
      webrtc_url,
    });
  } catch (error) {
    console.error("Error in /api/rest/camera/stream-register:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/rest/camera/stream-unregister
 * Unregister a WebRTC stream (companion shutting down).
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string
 * }
 */
router.post("/camera/stream-unregister", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id } = req.body;

    if (!api_key || !drone_id) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id",
      });
    }

    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }

    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    webrtcStreamRegistry.delete(drone_id);
    console.log(`[WebRTC] Stream unregistered for ${drone_id}`);

    // Notify browser clients that stream is gone
    broadcastCameraStream(drone_id, null);

    return res.status(200).json({ success: true, message: "Stream unregistered" });
  } catch (error) {
    console.error("Error in /api/rest/camera/stream-unregister:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/rest/camera/stream-status/:droneId
 * Check if a WebRTC stream is registered for a drone.
 * Returns the go2rtc WHEP signaling URL for the browser to connect directly.
 */
router.get("/camera/stream-status/:droneId", (req: Request, res: Response) => {
  const { droneId } = req.params;
  const entry = webrtcStreamRegistry.get(droneId);

  if (!entry) {
    return res.status(200).json({
      success: true,
      active: false,
      drone_id: droneId,
    });
  }

  return res.status(200).json({
    success: true,
    active: true,
    drone_id: droneId,
    webrtc_url: entry.webrtcUrl,
    registered_at: new Date(entry.registeredAt).toISOString(),
  });
});

export default router;
