import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { initializeWebSocket } from "../websocket";
import restApiRouter from "../rest-api";
import { startJobReaper } from "../droneJobsDb";
import { migrateDb } from "../db";
import { registerCompanionSuiteRoutes } from "../companionSuite";
import { startDroneSubscribers } from "../droneSubscriber";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Open the local SQLite database and apply migrations (creates the DB on first run)
  await migrateDb();

  const app = express();
  const server = createServer(app);

  // Initialize WebSocket server
  initializeWebSocket(server);
  // Configure body parser — no practical size limit (FC logs can exceed 200MB)
  app.use(express.json({ limit: "500mb" }));
  app.use(express.urlencoded({ limit: "500mb", extended: true }));
  // Parse raw text bodies (needed for SDP in WHEP proxy)
  app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }));
  // Local file storage served under /files/*
  registerStorageProxy(app);
  // Companion suite for the single-command Pi installer (/companion/*)
  registerCompanionSuiteRoutes(app);
  // REST API for external integrations
  app.use("/api/rest", restApiRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Bind all interfaces (not just loopback) so companion computers can reach the
  // Hub's REST/tRPC/Socket.IO over the drone subnet, LAN or tailnet. Set
  // HOST=127.0.0.1 to restrict the Hub to this machine only.
  const host = process.env.HOST?.trim() || "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`Server running on http://localhost:${port}/ (listening on ${host}:${port})`);

    // Start the job reliability reaper (runs every 60s)
    startJobReaper(60_000);
    // Start the outbound "pull" data plane for any drones in pull mode
    // (Tailscale Phase B). No-op when every drone is in the default push mode.
    startDroneSubscribers().catch((err) =>
      console.error("[DroneSubscriber] Failed to start:", err)
    );
  });
}

startServer().catch(console.error);
