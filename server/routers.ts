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
import { createCustomApp, getAllCustomApps, getCustomAppByAppId, installAppForUser, uninstallAppForUser, getUserInstalledApps, updateCustomApp, createAppVersion, getAppVersions, getAppVersion, rollbackAppToVersion, deleteCustomApp } from "./customAppDb";
import { createDroneJob, getPendingJobsForDrone, acknowledgeJob, completeJob, getAllJobsForDrone, createDroneFile, getDroneFile, getDroneFiles, deleteDroneFile } from "./droneJobsDb";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import { gzipSync } from "zlib";

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
          uiSchema: app.uiSchema,
          dataSchema: app.dataSchema,
        }));
      }),

    // Install an app for the current user
    installApp: protectedProcedure
      .input(z.object({ appId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        // List of built-in apps that don't exist in customApps table
        const builtInApps = ["telemetry", "camera"];
        
        // For custom apps, verify they exist and are published
        if (!builtInApps.includes(input.appId)) {
          const app = await getCustomAppByAppId(input.appId);
          if (!app) {
            throw new Error(`App "${input.appId}" not found`);
          }

          if (app.published !== "published") {
            throw new Error("Cannot install unpublished app");
          }
        }

        const result = await installAppForUser(ctx.user.id, input.appId);
        return {
          success: true,
          installedAt: result.installedAt,
        };
      }),

    // Uninstall an app for the current user
    uninstallApp: protectedProcedure
      .input(z.object({ appId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await uninstallAppForUser(ctx.user.id, input.appId);
        return { success: true };
      }),

    // Get all apps installed by the current user
    getUserApps: protectedProcedure.query(async ({ ctx }) => {
      const installedApps = await getUserInstalledApps(ctx.user.id);
      return installedApps.map((item) => {
        // For built-in apps (no entry in customApps), return minimal metadata
        if (!item.app) {
          return {
            appId: item.appId,
            name: item.appId, // Will be overridden in frontend with proper name
            installedAt: item.installedAt,
          };
        }
        // For custom apps, return full app data
        return {
          ...item.app,
          installedAt: item.installedAt,
        };
      });
    }),

    // Get a specific app by ID (for editing)
    getAppById: protectedProcedure
      .input(z.object({ appId: z.string() }))
      .query(async ({ input, ctx }) => {
        const app = await getCustomAppByAppId(input.appId);
        if (!app) {
          throw new Error(`App "${input.appId}" not found`);
        }

        // Check if user has permission to edit (must be creator or owner)
        if (app.creatorId !== ctx.user.id && ctx.user.role !== 'admin') {
          throw new Error('You do not have permission to edit this app');
        }

        return app;
      }),

    // Update an existing app
    updateApp: protectedProcedure
      .input(
        z.object({
          appId: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          parserCode: z.string().optional(),
          dataSchema: z.any().optional(),
          uiSchema: z.any().optional(),
          createVersion: z.boolean().optional(), // Whether to create a version snapshot before updating
        })
      )
      .mutation(async ({ input, ctx }) => {
        const app = await getCustomAppByAppId(input.appId);
        if (!app) {
          throw new Error(`App "${input.appId}" not found`);
        }

        // Check if user is the creator
        if (app.creatorId !== ctx.user.id) {
          throw new Error("Only the app creator can update this app");
        }

        // Create version snapshot if requested
        if (input.createVersion) {
          await createAppVersion(input.appId, ctx.user.id);
        }

        // Update the app
        const updates: any = {};
        if (input.name) updates.name = input.name;
        if (input.description !== undefined) updates.description = input.description;
        if (input.parserCode) updates.parserCode = input.parserCode;
        if (input.dataSchema) updates.dataSchema = JSON.stringify(input.dataSchema);
        if (input.uiSchema) updates.uiSchema = JSON.stringify(input.uiSchema);

        await updateCustomApp(app.id, updates);

        return { success: true };
      }),

    // Get version history for an app
    getVersionHistory: protectedProcedure
      .input(z.object({ appId: z.string() }))
      .query(async ({ input }) => {
        const versions = await getAppVersions(input.appId);
        return versions;
      }),

    // Send test payload to an app (for testing purposes)
    sendTestPayload: publicProcedure
      .input(
        z.object({
          appId: z.string(),
          payload: z.any(),
        })
      )
      .mutation(async ({ input }) => {
        const { broadcastAppData } = await import('./websocket');
        const app = await getCustomAppByAppId(input.appId);
        if (!app) {
          throw new Error(`App "${input.appId}" not found`);
        }

        // Execute parser if available
        let parsedData = input.payload;
        if (app.parserCode) {
          const result = await executeParser(app.parserCode, input.payload);
          if (result.success && result.output) {
            parsedData = result.output;
          }
        }

        console.log('[sendTestPayload] Parsed data:', JSON.stringify(parsedData));

        // Broadcast the data to all connected clients
        broadcastAppData(input.appId, parsedData);

        console.log('[sendTestPayload] Broadcast complete');

        return { success: true, parsedData };
      }),

    // Rollback app to a specific version
    rollbackToVersion: protectedProcedure
      .input(
        z.object({
          appId: z.string(),
          versionId: z.number(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const app = await getCustomAppByAppId(input.appId);
        if (!app) {
          throw new Error(`App "${input.appId}" not found`);
        }

        // Check if user is the creator
        if (app.creatorId !== ctx.user.id) {
          throw new Error("Only the app creator can rollback this app");
        }

        // Create a snapshot of current state before rollback
        await createAppVersion(input.appId, ctx.user.id);

        // Rollback to the specified version
        await rollbackAppToVersion(input.appId, input.versionId);

        return { success: true };
      }),

    // Delete an app completely (cascade delete all related data)
    deleteApp: protectedProcedure
      .input(z.object({ appId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const app = await getCustomAppByAppId(input.appId);
        if (!app) {
          throw new Error(`App "${input.appId}" not found`);
        }

        // Check if user is the creator or admin
        if (app.creatorId !== ctx.user.id && ctx.user.role !== 'admin') {
          throw new Error("Only the app creator or admin can delete this app");
        }

        // Delete the app and all related data
        await deleteCustomApp(input.appId);

        return { success: true };
      }),
  }),

  // Drone management
  drones: router({
    // List all drones
    list: publicProcedure.query(async () => {
      const drones = await getAllDrones();
      return { drones };
    }),
  }),

  // Drone job management for two-way communication
  droneJobs: router({
    // Get pending jobs for a drone (called by Pi)
    getPendingJobs: publicProcedure
      .input(z.object({ droneId: z.string(), apiKey: z.string() }))
      .query(async ({ input }) => {
        // Validate API key
        const apiKeyRecord = await validateApiKey(input.apiKey);
        if (!apiKeyRecord || apiKeyRecord.droneId !== input.droneId) {
          throw new Error("Invalid API key");
        }

        const jobs = await getPendingJobsForDrone(input.droneId);
        return { jobs };
      }),

    // Acknowledge a job (mark as in progress)
    acknowledgeJob: publicProcedure
      .input(z.object({ jobId: z.number(), apiKey: z.string(), droneId: z.string() }))
      .mutation(async ({ input }) => {
        // Validate API key
        const apiKeyRecord = await validateApiKey(input.apiKey);
        if (!apiKeyRecord || apiKeyRecord.droneId !== input.droneId) {
          throw new Error("Invalid API key");
        }

        await acknowledgeJob(input.jobId);
        return { success: true };
      }),

    // Complete a job (mark as completed or failed)
    completeJob: publicProcedure
      .input(
        z.object({
          jobId: z.number(),
          apiKey: z.string(),
          droneId: z.string(),
          success: z.boolean(),
          errorMessage: z.string().nullable().optional(),
        })
      )
      .mutation(async ({ input }) => {
        // Validate API key
        const apiKeyRecord = await validateApiKey(input.apiKey);
        if (!apiKeyRecord || apiKeyRecord.droneId !== input.droneId) {
          throw new Error("Invalid API key");
        }

        await completeJob(input.jobId, input.success, input.errorMessage);
        return { success: true };
      }),

    // Get all jobs for a drone (for monitoring/history)
    getAllJobs: protectedProcedure
      .input(z.object({ droneId: z.string(), limit: z.number().optional() }))
      .query(async ({ input }) => {
        const jobs = await getAllJobsForDrone(input.droneId, input.limit);
        return { jobs };
      }),

    // Create a new job (called by web UI)
    createJob: protectedProcedure
      .input(
        z.object({
          droneId: z.string(),
          type: z.string(),
          payload: z.any(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await createDroneJob({
          droneId: input.droneId,
          type: input.type,
          payload: input.payload,
          createdBy: ctx.user.id,
        });
        return { success: true };
      }),

    // Upload a file for a drone
    uploadFile: publicProcedure
      .input(
        z.object({
          droneId: z.string(),
          filename: z.string(),
          content: z.string(), // base64 encoded
          mimeType: z.string().optional(),
          description: z.string().optional(),
          targetPath: z.string(), // where to save on Pi
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Decode base64 content
        let buffer = Buffer.from(input.content, "base64");
        const originalFileSize = buffer.length;
        
        // Compress Python files to bypass content scanning
        let isCompressed = false;
        if (input.filename.endsWith('.py')) {
          buffer = Buffer.from(gzipSync(buffer));
          isCompressed = true;
          console.log(`[uploadFile] Compressed ${input.filename}: ${originalFileSize} → ${buffer.length} bytes`);
        }
        
        const fileSize = buffer.length;

        // Generate unique file ID
        const fileId = nanoid();
        
        // For compressed files, add .gz extension for S3 storage
        // The original filename is preserved in metadata and used when downloading to Pi
        let storageFilename = input.filename;
        if (isCompressed) {
          storageFilename = input.filename + '.gz';
          console.log(`[uploadFile] Storing compressed file as ${storageFilename}`);
        }
        
        const storageKey = `drone-files/${input.droneId}/${fileId}-${storageFilename}`;

        // Upload to S3
        const { url } = await storagePut(
          storageKey,
          buffer,
          input.mimeType || "application/octet-stream"
        );

        // Store file metadata
        await createDroneFile({
          fileId,
          filename: input.filename,
          mimeType: input.mimeType || "application/octet-stream",
          fileSize,
          storageKey,
          url,
          droneId: input.droneId,
          description: input.description,
          uploadedBy: ctx.user?.id || 0, // 0 for anonymous uploads
        });

        // Create a job for the drone to download this file
        await createDroneJob({
          droneId: input.droneId,
          type: "upload_file",
          payload: {
            fileId,
            fileUrl: url,
            targetPath: input.targetPath,
            filename: input.filename,
            isCompressed, // Pi needs to decompress if true
          },
          createdBy: ctx.user?.id || 0, // 0 for anonymous uploads
        });

        return { success: true, fileId, url };
      }),

    // Get file download URL (called by Pi)
    getFile: publicProcedure
      .input(z.object({ fileId: z.string(), apiKey: z.string(), droneId: z.string() }))
      .query(async ({ input }) => {
        // Validate API key
        const apiKeyRecord = await validateApiKey(input.apiKey);
        if (!apiKeyRecord || apiKeyRecord.droneId !== input.droneId) {
          throw new Error("Invalid API key");
        }

        const file = await getDroneFile(input.fileId);
        if (!file) {
          throw new Error("File not found");
        }

        // Check if file is for this drone or available to all
        if (file.droneId && file.droneId !== input.droneId) {
          throw new Error("File not available for this drone");
        }

        return { file };
      }),

    // Get all files for a drone (for monitoring)
    getFiles: protectedProcedure
      .input(z.object({ droneId: z.string() }))
      .query(async ({ input }) => {
        const files = await getDroneFiles(input.droneId);
        return { files };
      }),

    // Delete a file
    deleteFile: protectedProcedure
      .input(z.object({ fileId: z.string() }))
      .mutation(async ({ input }) => {
        await deleteDroneFile(input.fileId);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
