import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  upsertDrone,
  getDroneByDroneId,
  getAllDrones,
  insertScan,
  getRecentScans,
  getScanStats,
  validateApiKey,
} from "./db";
import { broadcastPointCloud } from "./websocket";
import type { PointCloudMessage } from "./websocket";

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
});

export type AppRouter = typeof appRouter;
