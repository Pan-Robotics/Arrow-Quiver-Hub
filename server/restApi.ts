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

    // Determine data source mode
    const dataSourceMode = app.dataSource || 'custom_endpoint';
    
    let outputData: any;
    let executionTime: number | undefined;

    if (dataSourceMode === 'passthrough') {
      // Passthrough mode: skip parser, use raw payload directly
      outputData = rawPayload;
      console.log(`[REST API] Passthrough mode for app ${appId}`);
    } else if (dataSourceMode === 'stream_subscription') {
      // Stream subscription apps shouldn't receive data via REST
      return res.status(400).json({
        success: false,
        error: `App "${appId}" uses stream subscription and does not accept REST payloads`,
      });
    } else {
      // Custom endpoint mode: execute the parser
      const parseResult = await executeParser(app.parserCode, rawPayload);
      
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: `Parser execution failed: ${parseResult.error}`,
        });
      }
      outputData = parseResult.output;
      executionTime = parseResult.executionTime;
    }

    // Store the parsed data
    const storedData = await storeAppData({
      appId,
      data: outputData,
      rawPayload,
    });

    // Broadcast to connected WebSocket clients
    broadcastAppData(appId, outputData);

    // Return success response
    return res.status(200).json({
      success: true,
      appId,
      data: outputData,
      timestamp: storedData.timestamp,
      ...(executionTime && { executionTime }),
    });
  } catch (error) {
    console.error("[REST API] Payload ingest error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
