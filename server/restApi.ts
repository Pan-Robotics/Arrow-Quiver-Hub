/**
 * REST API handler for custom app payload ingestion
 * Provides /api/rest/payload/:appId/ingest endpoint
 */

import type { Request, Response } from "express";
import { getCustomAppByAppId, storeAppData } from "./customAppDb";
import { executeParser } from "./parserExecutor";
import { broadcastAppData } from "./websocket";

/**
 * Handle payload ingestion for a custom app
 * POST /api/rest/payload/:appId/ingest
 * 
 * Request body: any JSON payload
 * Response: parsed data
 */
export async function handlePayloadIngest(req: Request, res: Response) {
  try {
    const { appId } = req.params;
    const rawPayload = req.body;

    // Validate appId
    if (!appId) {
      return res.status(400).json({
        success: false,
        error: "Missing appId parameter",
      });
    }

    // Get the app from database
    const app = await getCustomAppByAppId(appId);
    if (!app) {
      return res.status(404).json({
        success: false,
        error: `App "${appId}" not found`,
      });
    }

    // Execute the parser
    const parseResult = await executeParser(app.parserCode, rawPayload);
    
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: `Parser execution failed: ${parseResult.error}`,
      });
    }

    // Store the parsed data
    const storedData = await storeAppData({
      appId,
      data: parseResult.output,
      rawPayload,
    });

    // Broadcast to connected WebSocket clients
    broadcastAppData(appId, parseResult.output);

    // Return success response
    return res.status(200).json({
      success: true,
      appId,
      data: parseResult.output,
      timestamp: storedData.timestamp,
      executionTime: parseResult.executionTime,
    });
  } catch (error) {
    console.error("[REST API] Payload ingest error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
