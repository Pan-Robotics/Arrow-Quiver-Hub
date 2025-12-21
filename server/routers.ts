import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  upsertDrone,
  getDroneByDroneId,
  getAllDrones,
  insertScan,
  getRecentScans,
  getScanStats,
  validateApiKey,
  insertTelemetry,
  getRecentTelemetry,
} from "./db";
import { broadcastPointCloud, broadcastTelemetry } from "./websocket";
import type { PointCloudMessage, TelemetryMessage } from "./websocket";
import { executeParser, validateParserCode } from "./parserExecutor";
import { extractSchema } from "./schemaExtractor";
import { createCustomApp, getAllCustomApps, getCustomAppByAppId } from "./customAppDb";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Point cloud data ingestion
  pointcloud: router({
    // Receive point cloud data from companion computer
    ingest: publicProcedure
      .input(
        z.object({
          api_key: z.string(),
          drone_id: z.string(),
          timestamp: z.string(),
          points: z.array(
            z.object({
              angle: z.number(),
              distance: z.number(),
              quality: z.number(),
              x: z.number(),
              y: z.number(),
            })
          ),
          stats: z.object({
            point_count: z.number(),
            valid_points: z.number(),
            min_distance: z.number(),
            max_distance: z.number(),
            avg_distance: z.number(),
            avg_quality: z.number(),
          }),
        })
      )
      .mutation(async ({ input }) => {
        // Validate API key
        const apiKeyRecord = await validateApiKey(input.api_key);
        if (!apiKeyRecord) {
          throw new Error("Invalid API key");
        }

        // Verify drone ID matches API key
        if (apiKeyRecord.droneId !== input.drone_id) {
          throw new Error("Drone ID mismatch");
        }

        // Update drone last seen
        await upsertDrone({
          droneId: input.drone_id,
          lastSeen: new Date(input.timestamp),
          isActive: true,
        });

        // Store scan metadata in database
        await insertScan({
          droneId: input.drone_id,
          timestamp: new Date(input.timestamp),
          pointCount: input.stats.point_count,
          minDistance: Math.round(input.stats.min_distance),
          maxDistance: Math.round(input.stats.max_distance),
          avgQuality: Math.round(input.stats.avg_quality),
        });

        // Broadcast to WebSocket clients
        const message: PointCloudMessage = {
          drone_id: input.drone_id,
          timestamp: input.timestamp,
          points: input.points,
          stats: input.stats,
        };
        broadcastPointCloud(message);

        return { success: true };
      }),

    // Get list of drones
    getDrones: publicProcedure.query(async () => {
      return await getAllDrones();
    }),

    // Get recent scans for a drone
    getRecentScans: publicProcedure
      .input(
        z.object({
          droneId: z.string(),
          limit: z.number().optional().default(100),
        })
      )
      .query(async ({ input }) => {
        return await getRecentScans(input.droneId, input.limit);
      }),

    // Get current stats for a drone
    getStats: publicProcedure
      .input(z.object({ droneId: z.string() }))
      .query(async ({ input }) => {
        return await getScanStats(input.droneId);
      }),
  }),

  // Telemetry data ingestion
  telemetry: router({
    // Receive telemetry data from companion computer
    ingest: publicProcedure
      .input(
        z.object({
          api_key: z.string(),
          drone_id: z.string(),
          timestamp: z.string(),
          telemetry: z.object({
            attitude: z.object({
              roll_deg: z.number(),
              pitch_deg: z.number(),
              yaw_deg: z.number(),
              timestamp: z.string(),
            }).nullable(),
            position: z.object({
              latitude_deg: z.number(),
              longitude_deg: z.number(),
              absolute_altitude_m: z.number(),
              relative_altitude_m: z.number(),
              timestamp: z.string(),
            }).nullable(),
            gps: z.object({
              num_satellites: z.number(),
              fix_type: z.number(),
              timestamp: z.string(),
            }).nullable(),
            battery_fc: z.object({
              voltage_v: z.number(),
              remaining_percent: z.number(),
              timestamp: z.string(),
            }).nullable(),
            battery_uavcan: z.object({
              battery_id: z.number(),
              voltage_v: z.number(),
              current_a: z.number(),
              temperature_k: z.number(),
              state_of_charge_pct: z.number(),
              timestamp: z.string(),
            }).nullable(),
            in_air: z.boolean(),
          }),
        })
      )
      .mutation(async ({ input }) => {
        // Validate API key
        const apiKeyRecord = await validateApiKey(input.api_key);
        if (!apiKeyRecord) {
          throw new Error("Invalid API key");
        }

        // Verify drone ID matches API key
        if (apiKeyRecord.droneId !== input.drone_id) {
          throw new Error("Drone ID mismatch");
        }

        // Update drone last seen
        await upsertDrone({
          droneId: input.drone_id,
          lastSeen: new Date(input.timestamp),
          isActive: true,
        });

        // Store telemetry in database
        await insertTelemetry({
          droneId: input.drone_id,
          timestamp: new Date(input.timestamp),
          telemetryData: input.telemetry,
        });

        // Broadcast to WebSocket clients
        const message: TelemetryMessage = {
          drone_id: input.drone_id,
          timestamp: input.timestamp,
          telemetry: input.telemetry,
        };
        broadcastTelemetry(message);

        return { success: true };
      }),

    // Get recent telemetry for a drone
    getRecentTelemetry: publicProcedure
      .input(
        z.object({
          droneId: z.string(),
          limit: z.number().optional().default(100),
        })
      )
      .query(async ({ input }) => {
        return await getRecentTelemetry(input.droneId, input.limit);
      }),
  }),

  // App builder endpoints
  appBuilder: router({
    // Test a payload parser
    testParser: publicProcedure
      .input(
        z.object({
          parserCode: z.string(),
          testData: z.any(),
        })
      )
      .mutation(async ({ input }) => {
        // Validate parser code
        const validation = validateParserCode(input.parserCode);
        if (!validation.valid) {
          return {
            success: false,
            error: validation.errors.join('; '),
          };
        }

        // Execute parser
        const result = await executeParser(input.parserCode, input.testData);
        return result;
      }),

    // Validate parser code without executing
    validateParser: publicProcedure
      .input(z.object({ parserCode: z.string() }))
      .query(({ input }) => {
        return validateParserCode(input.parserCode);
      }),

    // Extract SCHEMA from parser code
    extractSchema: publicProcedure
      .input(z.object({ parserCode: z.string() }))
      .mutation(async ({ input }) => {
        const result = await extractSchema(input.parserCode);
        return result;
      }),

    // Save a complete custom app (parser + UI schema)
    saveApp: protectedProcedure
      .input(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          parserCode: z.string(),
          dataSchema: z.any(), // JSON schema
          uiSchema: z.any(), // UI layout configuration
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Generate unique appId from name
        const appId = input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        // Check if appId already exists
        const existing = await getCustomAppByAppId(appId);
        if (existing) {
          throw new Error(`An app with ID "${appId}" already exists`);
        }

        // Create the app
        const app = await createCustomApp({
          appId,
          name: input.name,
          description: input.description || null,
          icon: null,
          parserCode: input.parserCode,
          dataSchema: JSON.stringify(input.dataSchema),
          uiSchema: JSON.stringify(input.uiSchema),
          version: "1.0.0",
          published: "published",
          creatorId: ctx.user.id,
        });

        return {
          success: true,
          appId: app.appId,
          id: app.id,
        };
      }),

    // Get all custom apps
    listApps: publicProcedure
      .input(z.object({ publishedOnly: z.boolean().optional() }).optional())
      .query(async ({ input }) => {
        const apps = await getAllCustomApps(input?.publishedOnly || false);
        return apps.map((app) => ({
          id: app.id,
          appId: app.appId,
          name: app.name,
          description: app.description,
          icon: app.icon,
          version: app.version,
          published: app.published,
          createdAt: app.createdAt,
        }));
      }),
  }),
});

export type AppRouter = typeof appRouter;
