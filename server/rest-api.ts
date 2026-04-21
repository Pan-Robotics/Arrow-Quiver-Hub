/**
 * REST API endpoints for external integrations
 * These endpoints are designed for non-tRPC clients (e.g., Python scripts)
 */

import { Router, Request, Response } from "express";
import multer from "multer";
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
import { createHash } from "crypto";
import { sdk } from "./_core/sdk";

// Multer for multipart file uploads (FC logs, firmware, etc.)
const upload = multer({ storage: multer.memoryStorage() });
import {
  upsertFcLog,
  updateFcLog,
  getFcLogById,
  createFirmwareUpdate,
  updateFirmwareStatus,
  getFirmwareUpdateById,
  insertDiagnostics,
  cleanupOldDiagnostics,
} from "./logsOtaDb";
import { broadcastLogProgress, broadcastFirmwareProgress, broadcastDiagnostics } from "./websocket";

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

/**
 * POST /api/rest/camera/whep-proxy/:droneId
 * Server-side WHEP proxy — relays SDP offer/answer between the browser and
 * the go2rtc instance on the companion (via Tailscale).
 *
 * The browser cannot reach the Tailscale URL directly (different network /
 * CORS), so the Hub server acts as a signaling relay. Only the SDP text is
 * proxied; actual WebRTC media flows peer-to-peer after ICE completes.
 *
 * Request:
 *   Content-Type: application/sdp
 *   Body: SDP offer string
 *
 * Response:
 *   Content-Type: application/sdp
 *   Body: SDP answer string from go2rtc
 */
router.post("/camera/whep-proxy/:droneId", async (req: Request, res: Response) => {
  const { droneId } = req.params;

  try {
    const entry = webrtcStreamRegistry.get(droneId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: `No active stream registered for drone ${droneId}`,
      });
    }

    // Read the raw SDP offer from the request body
    // Express may have already parsed it as text if content-type is application/sdp
    let sdpOffer: string;
    if (typeof req.body === "string") {
      sdpOffer = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      sdpOffer = req.body.toString("utf-8");
    } else {
      // Body parser may have parsed as JSON — try to get raw
      sdpOffer = JSON.stringify(req.body);
    }

    if (!sdpOffer || sdpOffer.length < 10) {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid SDP offer in request body",
      });
    }

    console.log(`[WHEP Proxy] Relaying SDP offer for ${droneId} to ${entry.webrtcUrl} (${sdpOffer.length} bytes)`);

    // Forward the SDP offer to the go2rtc WHEP endpoint on the companion
    const upstreamResponse = await fetch(entry.webrtcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: sdpOffer,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text().catch(() => "(no body)");
      console.error(`[WHEP Proxy] Upstream returned ${upstreamResponse.status}: ${errorText.slice(0, 200)}`);
      return res.status(502).json({
        success: false,
        error: `go2rtc returned ${upstreamResponse.status}`,
        detail: errorText.slice(0, 500),
      });
    }

    const sdpAnswer = await upstreamResponse.text();
    console.log(`[WHEP Proxy] Got SDP answer for ${droneId} (${sdpAnswer.length} bytes)`);

    res.setHeader("Content-Type", "application/sdp");
    return res.status(200).send(sdpAnswer);
  } catch (error: any) {
    // Distinguish timeout from other errors
    if (error?.name === "TimeoutError" || error?.code === "UND_ERR_CONNECT_TIMEOUT") {
      console.error(`[WHEP Proxy] Timeout reaching go2rtc for ${droneId}`);
      return res.status(504).json({
        success: false,
        error: "Timeout reaching go2rtc on companion",
      });
    }
    console.error(`[WHEP Proxy] Error for ${droneId}:`, error);
    return res.status(502).json({
      success: false,
      error: "Failed to reach go2rtc on companion",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─── FC Log Management ─────────────────────────────────────────────────────

/**
 * POST /api/rest/logs/fc-list
 * Pi reports discovered FC log files from the SD card.
 * Creates/updates fcLogs entries with status "discovered".
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   logs: Array<{ remote_path: string, filename: string, file_size?: number }>
 * }
 */
router.post("/logs/fc-list", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, logs } = req.body;

    if (!api_key || !drone_id || !logs || !Array.isArray(logs)) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, logs[]",
      });
    }

    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    let created = 0;
    for (const log of logs) {
      if (!log.remote_path || !log.filename) continue;
      await upsertFcLog({
        droneId: drone_id,
        remotePath: log.remote_path,
        filename: log.filename,
        fileSize: log.file_size || null,
        status: "discovered",
      });
      created++;
    }

    console.log(`[Logs] ${created} FC logs listed for ${drone_id}`);

    return res.status(200).json({
      success: true,
      message: `${created} FC logs registered`,
      count: created,
    });
  } catch (error) {
    console.error("Error in /api/rest/logs/fc-list:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/rest/logs/fc-progress
 * Pi reports download progress for an FC log.
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   log_id: number,
 *   status: "downloading" | "uploading" | "completed" | "failed",
 *   progress: number (0-100),
 *   error_message?: string
 * }
 */
router.post("/logs/fc-progress", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, log_id, status, progress, error_message } = req.body;

    if (!api_key || !drone_id || !log_id || !status) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, log_id, status",
      });
    }

    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    await updateFcLog(log_id, {
      status,
      progress: progress ?? 0,
      errorMessage: error_message || null,
    });

    // Broadcast progress to browser clients
    broadcastLogProgress(drone_id, {
      logId: log_id,
      status,
      progress: progress ?? 0,
      errorMessage: error_message,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error in /api/rest/logs/fc-progress:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/rest/logs/fc-upload
 * Pi uploads a downloaded FC log file to S3 via the Hub.
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   log_id: number,
 *   filename: string,
 *   content: string (base64 encoded),
 *   file_size: number
 * }
 */
router.post("/logs/fc-upload", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, log_id, filename, content, file_size } = req.body;

    if (!api_key || !drone_id || !log_id || !filename || !content) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, log_id, filename, content",
      });
    }

    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    const buffer = Buffer.from(content, "base64");

    // Compute SHA-256 hash for artefact integrity
    const sha256Hash = createHash("sha256").update(buffer).digest("hex");

    // Upload to S3
    const fileKey = `fc-logs/${drone_id}/${nanoid()}-${filename}`;
    const { url } = await storagePut(fileKey, buffer, "application/octet-stream");

    // Update the FC log record
    await updateFcLog(log_id, {
      status: "completed",
      progress: 100,
      storageKey: fileKey,
      url,
      fileSize: file_size || buffer.length,
      downloadedAt: new Date(),
      sha256Hash,
    });

    // Also create a flight log entry for the Flight Analytics app
    await createFlightLog({
      droneId: drone_id,
      filename,
      fileSize: file_size || buffer.length,
      storageKey: fileKey,
      url,
      format: filename.toLowerCase().endsWith(".log") ? "log" : "bin",
      description: `Auto-downloaded from FC via MAVFTP`,
      uploadSource: "api",
      uploadedBy: null,
    });

    // Broadcast completion
    broadcastLogProgress(drone_id, {
      logId: log_id,
      status: "completed",
      progress: 100,
      url,
      filename,
    });

    console.log(`[Logs] FC log uploaded for ${drone_id}: ${filename} (${buffer.length} bytes)`);

    return res.status(200).json({
      success: true,
      message: "FC log uploaded",
      url,
      file_size: buffer.length,
    });
  } catch (error) {
    console.error("Error in /api/rest/logs/fc-upload:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/rest/logs/fc-upload-multipart
 * Pi uploads a downloaded FC log file as multipart/form-data (no base64 overhead).
 * Fields: api_key, drone_id, log_id, filename, file_size
 * File field: "file" — the raw .BIN file
 */
router.post("/logs/fc-upload-multipart", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, log_id, filename, file_size } = req.body;
    const file = req.file;

    if (!api_key || !drone_id || !log_id || !filename || !file) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, log_id, filename, file",
      });
    }

    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    const buffer = file.buffer;

    // Compute SHA-256 hash for artefact integrity
    const sha256Hash = createHash("sha256").update(buffer).digest("hex");

    // Upload to S3
    const fileKey = `fc-logs/${drone_id}/${nanoid()}-${filename}`;
    const { url } = await storagePut(fileKey, buffer, "application/octet-stream");

    // Update the FC log record
    const numLogId = typeof log_id === "string" ? parseInt(log_id, 10) : log_id;
    await updateFcLog(numLogId, {
      status: "completed",
      progress: 100,
      storageKey: fileKey,
      url,
      fileSize: file_size ? parseInt(file_size, 10) : buffer.length,
      downloadedAt: new Date(),
      sha256Hash,
    });

    // Also create a flight log entry for the Flight Analytics app
    await createFlightLog({
      droneId: drone_id,
      filename,
      fileSize: file_size ? parseInt(file_size, 10) : buffer.length,
      storageKey: fileKey,
      url,
      format: filename.toLowerCase().endsWith(".log") ? "log" : "bin",
      description: `Auto-downloaded from FC via HTTP`,
      uploadSource: "api",
      uploadedBy: null,
    });

    // Broadcast completion
    broadcastLogProgress(drone_id, {
      logId: numLogId,
      status: "completed",
      progress: 100,
      url,
      filename,
    });

    console.log(`[Logs] FC log uploaded (multipart) for ${drone_id}: ${filename} (${buffer.length} bytes)`);

    return res.status(200).json({
      success: true,
      message: "FC log uploaded",
      url,
      file_size: buffer.length,
    });
  } catch (error) {
    console.error("Error in /api/rest/logs/fc-upload-multipart:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─── FC Log Download Proxy (Browser → S3) ────────────────────────────────

/**
 * GET /api/rest/logs/fc-download/:logId
 * Authenticated download proxy for FC log files.
 * Fetches the file from S3 and streams it to the browser with
 * Content-Disposition: attachment so the browser triggers a "Save As" dialog.
 *
 * Authentication: session cookie (same as tRPC protectedProcedure).
 * If the log is not yet downloaded (status != completed), returns 404.
 */
router.get("/logs/fc-download/:logId", async (req: Request, res: Response) => {
  try {
    // Authenticate via session cookie (same mechanism as tRPC protectedProcedure)
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const logId = parseInt(req.params.logId, 10);
    if (isNaN(logId)) {
      return res.status(400).json({ success: false, error: "Invalid log ID" });
    }

    const fcLog = await getFcLogById(logId);
    if (!fcLog) {
      return res.status(404).json({ success: false, error: "FC log not found" });
    }

    if (fcLog.status !== "completed" || !fcLog.url) {
      return res.status(404).json({
        success: false,
        error: "FC log has not been downloaded yet",
        status: fcLog.status,
      });
    }

    // Fetch the file from S3
    const upstream = await fetch(fcLog.url, {
      signal: AbortSignal.timeout(120_000), // 2 min timeout for large files
    });

    if (!upstream.ok) {
      console.error(`[FC Download] S3 returned ${upstream.status} for log ${logId}`);
      return res.status(502).json({
        success: false,
        error: `Storage returned ${upstream.status}`,
      });
    }

    // Sanitize filename for Content-Disposition
    const safeFilename = fcLog.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    // Forward Content-Length if available
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    // Stream the body to the browser
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch((err) => {
        console.error(`[FC Download] Stream error for log ${logId}:`, err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: "Stream interrupted" });
        } else {
          res.end();
        }
      });
    } else {
      // Fallback: buffer the whole response (shouldn't happen with fetch)
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
    }
  } catch (error) {
    console.error("Error in /api/rest/logs/fc-download:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    res.end();
  }
});

// ─── Firmware Update Progress ──────────────────────────────────────────────

/**
 * POST /api/rest/firmware/progress
 * Pi reports firmware flash progress.
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   update_id: number,
 *   status: "transferring" | "flashing" | "verifying" | "completed" | "failed",
 *   flash_stage?: string (ardupilot.abin rename stage),
 *   progress: number (0-100),
 *   error_message?: string
 * }
 */
router.post("/firmware/progress", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, update_id, status, flash_stage, progress, error_message } = req.body;

    if (!api_key || !drone_id || !update_id || !status) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: api_key, drone_id, update_id, status",
      });
    }

    const apiKeyRecord = await validateApiKey(api_key);
    if (!apiKeyRecord) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }
    if (apiKeyRecord.droneId !== drone_id) {
      return res.status(403).json({ success: false, error: "Drone ID mismatch" });
    }

    const updates: any = {
      status,
      progress: progress ?? 0,
      errorMessage: error_message || null,
    };
    if (flash_stage) updates.flashStage = flash_stage;
    if (status === "transferring" || status === "flashing") {
      updates.startedAt = new Date();
    }
    if (status === "completed" || status === "failed") {
      updates.completedAt = new Date();
    }

    await updateFirmwareStatus(update_id, updates);

    // Broadcast to browser
    broadcastFirmwareProgress(drone_id, {
      updateId: update_id,
      status,
      flashStage: flash_stage,
      progress: progress ?? 0,
      errorMessage: error_message,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error in /api/rest/firmware/progress:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─── System Diagnostics ────────────────────────────────────────────────────

/**
 * POST /api/rest/diagnostics/report
 * Pi sends a system health snapshot (CPU, memory, disk, temp, services).
 * Stored in DB and broadcast to browser.
 *
 * Request body:
 * {
 *   api_key: string,
 *   drone_id: string,
 *   cpu_percent: number,
 *   memory_percent: number,
 *   disk_percent: number,
 *   cpu_temp_c: number,
 *   uptime_seconds: number,
 *   services: { [name: string]: "active" | "inactive" | "failed" },
 *   network: { [iface: string]: { ip: string, rx_bytes: number, tx_bytes: number } }
 * }
 */
router.post("/diagnostics/report", async (req: Request, res: Response) => {
  try {
    const { api_key, drone_id, cpu_percent, memory_percent, disk_percent, cpu_temp_c, uptime_seconds, services, network, fc_webserver } = req.body;

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

    // Store in DB
    await insertDiagnostics({
      droneId: drone_id,
      cpuPercent: cpu_percent ?? null,
      memoryPercent: memory_percent ?? null,
      diskPercent: disk_percent ?? null,
      cpuTempC: cpu_temp_c ?? null,
      uptimeSeconds: uptime_seconds ?? null,
      services: services ?? null,
      network: network ?? null,
    });

    // Cleanup old entries (keep last 24h at 1/min = 1440)
    await cleanupOldDiagnostics(drone_id, 1440);

    // Broadcast to browser
    broadcastDiagnostics(drone_id, {
      cpuPercent: cpu_percent,
      memoryPercent: memory_percent,
      diskPercent: disk_percent,
      cpuTempC: cpu_temp_c,
      uptimeSeconds: uptime_seconds,
      services,
      network,
      fcWebserver: fc_webserver ?? null,
      timestamp: new Date().toISOString(),
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error in /api/rest/diagnostics/report:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
