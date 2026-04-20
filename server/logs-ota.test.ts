import { describe, it, expect } from "vitest";
import * as fs from "fs";

/**
 * Tests for the Logs & OTA Updates pipeline.
 * Validates:
 *   1. App Store integration (listing, metadata)
 *   2. Home.tsx integration (import + rendering)
 *   3. Server routers (fcLogs, firmware, diagnostics tRPC routers)
 *   4. REST API endpoints (fc-list, fc-progress, fc-upload, firmware/progress, diagnostics/report)
 *   5. WebSocket handlers (subscribe_logs, log_stream_request, log_stream_line, fc_log_progress, firmware_progress, diagnostics)
 *   6. Database schema (fcLogs, firmwareUpdates, systemDiagnostics tables)
 *   7. Database helpers (logsOtaDb.ts functions)
 *   8. Companion script structure (logs_ota_service.py)
 *   9. Systemd service file (logs-ota.service)
 *  10. Install script (install_logs_ota.sh)
 *  11. Frontend component (LogsOtaApp.tsx)
 */

// ─── App Store Integration ──────────────────────────────────────────────────

describe("Logs & OTA Updates - App Store", () => {
  const source = fs.readFileSync("./client/src/components/apps/AppStore.tsx", "utf-8");

  it("is listed in the AppStore storeApps array", () => {
    expect(source).toContain('"logs-ota"');
    expect(source).toContain("Logs & OTA Updates");
  });

  it("has correct category and description in AppStore", () => {
    expect(source).toContain("Maintenance");
    expect(source).toContain("over-the-air firmware updates");
  });

  it("uses ScrollText icon in AppStore", () => {
    expect(source).toContain("ScrollText");
    expect(source).toContain("icon: ScrollText");
  });
});

// ─── App Management Integration ─────────────────────────────────────────────

describe("Logs & OTA Updates - App Management", () => {
  const source = fs.readFileSync("./client/src/pages/AppManagement.tsx", "utf-8");

  it("is defined in BUILT_IN_APP_INFO", () => {
    expect(source).toContain('"logs-ota"');
    expect(source).toContain("Logs & OTA Updates");
  });

  it("has features list in App Management", () => {
    expect(source).toContain("Real-time log streaming from companion computer");
    expect(source).toContain("Over-the-air firmware update deployment");
  });

  it("has data streams defined", () => {
    expect(source).toContain("system_logs");
    expect(source).toContain("ota_status");
  });
});

// ─── Home.tsx Integration ───────────────────────────────────────────────────

describe("Logs & OTA Updates - Home.tsx Integration", () => {
  const source = fs.readFileSync("./client/src/pages/Home.tsx", "utf-8");

  it("is in builtInAppMetadata in Home.tsx", () => {
    expect(source).toContain('"logs-ota"');
    expect(source).toContain("Logs & OTA Updates");
  });

  it("imports LogsOtaApp component", () => {
    expect(source).toContain('import LogsOtaApp from "@/components/apps/LogsOtaApp"');
  });

  it("renders LogsOtaApp in the switch statement (not Coming Soon)", () => {
    expect(source).toContain('case "logs-ota"');
    expect(source).toContain("<LogsOtaApp />");
  });
});

// ─── Server Router ──────────────────────────────────────────────────────────

describe("Logs & OTA Updates - Server Router", () => {
  const source = fs.readFileSync("./server/routers.ts", "utf-8");

  it("is included in the builtInApps list", () => {
    expect(source).toContain('"logs-ota"');
    expect(source).toMatch(/builtInApps\s*=\s*\[.*"logs-ota".*\]/);
  });

  it("has fcLogs tRPC router with list, get, requestScan, requestDownload, delete", () => {
    expect(source).toContain("fcLogs: router({");
    expect(source).toContain("list: protectedProcedure");
    expect(source).toContain("requestScan: protectedProcedure");
    expect(source).toContain("requestDownload: protectedProcedure");
    // delete is also a protectedProcedure mutation
    expect(source).toMatch(/delete:\s*protectedProcedure/);
  });

  it("has firmware tRPC router with list, get, upload, requestFlash", () => {
    expect(source).toContain("firmware: router({");
    expect(source).toContain("upload: protectedProcedure");
    expect(source).toContain("requestFlash: protectedProcedure");
  });

  it("has diagnostics tRPC router with latest and history", () => {
    expect(source).toContain("diagnostics: router({");
    expect(source).toContain("latest: protectedProcedure");
    expect(source).toContain("history: protectedProcedure");
  });

  it("creates drone jobs for scan_fc_logs, download_fc_log, flash_firmware", () => {
    expect(source).toContain('"scan_fc_logs"');
    expect(source).toContain('"download_fc_log"');
    expect(source).toContain('"flash_firmware"');
  });
});

// ─── REST API Endpoints ─────────────────────────────────────────────────────

describe("Logs & OTA Updates - REST API Endpoints", () => {
  const source = fs.readFileSync("./server/rest-api.ts", "utf-8");

  it("has POST /logs/fc-list endpoint", () => {
    expect(source).toContain('"/logs/fc-list"');
    expect(source).toContain("router.post");
  });

  it("has POST /logs/fc-progress endpoint", () => {
    expect(source).toContain('"/logs/fc-progress"');
  });

  it("has POST /logs/fc-upload endpoint", () => {
    expect(source).toContain('"/logs/fc-upload"');
  });

  it("has POST /firmware/progress endpoint", () => {
    expect(source).toContain('"/firmware/progress"');
  });

  it("has POST /diagnostics/report endpoint", () => {
    expect(source).toContain('"/diagnostics/report"');
  });

  it("validates api_key and drone_id in REST endpoints", () => {
    expect(source).toContain("api_key");
    expect(source).toContain("drone_id");
  });
});

// ─── WebSocket Handlers ─────────────────────────────────────────────────────

describe("Logs & OTA Updates - WebSocket Handlers", () => {
  const source = fs.readFileSync("./server/websocket.ts", "utf-8");

  it("handles subscribe_logs event", () => {
    expect(source).toContain("subscribe_logs");
  });

  it("handles unsubscribe_logs event", () => {
    expect(source).toContain("unsubscribe_logs");
  });

  it("handles log_stream_request event", () => {
    expect(source).toContain("log_stream_request");
  });

  it("handles log_stream_line event from companion", () => {
    expect(source).toContain("log_stream_line");
  });

  it("broadcasts fc_log_progress events", () => {
    expect(source).toContain("fc_log_progress");
  });

  it("broadcasts firmware_progress events", () => {
    expect(source).toContain("firmware_progress");
  });

  it("broadcasts diagnostics events", () => {
    expect(source).toContain("diagnostics");
  });

  it("uses logs: room prefix for log subscriptions", () => {
    expect(source).toMatch(/logs:/);
  });
});

// ─── Database Schema ────────────────────────────────────────────────────────

describe("Logs & OTA Updates - Database Schema", () => {
  const source = fs.readFileSync("./drizzle/schema.ts", "utf-8");

  it("defines fcLogs table with required columns", () => {
    expect(source).toContain('fcLogs = mysqlTable("fcLogs"');
    expect(source).toContain("droneId");
    expect(source).toContain("remotePath");
    expect(source).toContain("filename");
    expect(source).toContain("fileSize");
    expect(source).toContain("storageKey");
    expect(source).toContain("discoveredAt");
    expect(source).toContain("downloadedAt");
  });

  it("defines fcLogs status enum with correct values", () => {
    expect(source).toMatch(/mysqlEnum.*"discovered".*"downloading".*"uploading".*"completed".*"failed"/);
  });

  it("defines firmwareUpdates table with required columns", () => {
    expect(source).toContain('firmwareUpdates = mysqlTable("firmwareUpdates"');
    expect(source).toContain("flashStage");
    expect(source).toContain("initiatedBy");
  });

  it("defines firmwareUpdates status enum with correct values", () => {
    expect(source).toMatch(/mysqlEnum.*"uploaded".*"queued".*"transferring".*"flashing".*"verifying".*"completed".*"failed"/);
  });

  it("defines systemDiagnostics table with required columns", () => {
    expect(source).toContain('systemDiagnostics = mysqlTable("systemDiagnostics"');
    expect(source).toContain("cpuPercent");
    expect(source).toContain("memoryPercent");
    expect(source).toContain("diskPercent");
    expect(source).toContain("cpuTempC");
    expect(source).toContain("uptimeSeconds");
    expect(source).toContain("services");
    expect(source).toContain("network");
  });

  it("exports type aliases for all tables", () => {
    expect(source).toContain("export type FcLog");
    expect(source).toContain("export type FirmwareUpdate");
    expect(source).toContain("export type SystemDiagnostic");
  });
});

// ─── Database Helpers ───────────────────────────────────────────────────────

describe("Logs & OTA Updates - Database Helpers", () => {
  const source = fs.readFileSync("./server/logsOtaDb.ts", "utf-8");

  it("exports getFcLogsForDrone", () => {
    expect(source).toContain("export async function getFcLogsForDrone");
  });

  it("exports getFcLogById", () => {
    expect(source).toContain("export async function getFcLogById");
  });

  it("exports upsertFcLog", () => {
    expect(source).toContain("export async function upsertFcLog");
  });

  it("exports updateFcLog", () => {
    expect(source).toContain("export async function updateFcLog");
  });

  it("exports deleteFcLog", () => {
    expect(source).toContain("export async function deleteFcLog");
  });

  it("exports getFirmwareUpdatesForDrone", () => {
    expect(source).toContain("export async function getFirmwareUpdatesForDrone");
  });

  it("exports createFirmwareUpdate", () => {
    expect(source).toContain("export async function createFirmwareUpdate");
  });

  it("exports updateFirmwareStatus", () => {
    expect(source).toContain("export async function updateFirmwareStatus");
  });

  it("exports getLatestDiagnostics", () => {
    expect(source).toContain("export async function getLatestDiagnostics");
  });

  it("exports getDiagnosticsHistory", () => {
    expect(source).toContain("export async function getDiagnosticsHistory");
  });

  it("exports insertDiagnostics", () => {
    expect(source).toContain("export async function insertDiagnostics");
  });
});

// ─── Frontend Component ─────────────────────────────────────────────────────

describe("Logs & OTA Updates - Frontend Component", () => {
  const source = fs.readFileSync("./client/src/components/apps/LogsOtaApp.tsx", "utf-8");

  it("exports default LogsOtaApp component", () => {
    expect(source).toContain("export default function LogsOtaApp");
  });

  it("uses useDroneSelection hook", () => {
    expect(source).toContain('useDroneSelection("logs-ota")');
  });

  it("has FC Logs tab with FcLogsTab component", () => {
    expect(source).toContain("FcLogsTab");
    expect(source).toContain('value="fc-logs"');
    expect(source).toContain("FC Logs");
  });

  it("has OTA Updates tab with OtaUpdatesTab component", () => {
    expect(source).toContain("OtaUpdatesTab");
    expect(source).toContain('value="ota"');
    expect(source).toContain("OTA Updates");
  });

  it("has Diagnostics tab with DiagnosticsTab component", () => {
    expect(source).toContain("DiagnosticsTab");
    expect(source).toContain('value="diagnostics"');
    expect(source).toContain("Diagnostics");
  });

  it("has Remote Logs tab with RemoteLogsTab component", () => {
    expect(source).toContain("RemoteLogsTab");
    expect(source).toContain('value="remote-logs"');
    expect(source).toContain("Remote Logs");
  });

  it("uses Socket.IO for real-time updates", () => {
    expect(source).toContain('import { io, Socket } from "socket.io-client"');
    expect(source).toContain("subscribe_logs");
    expect(source).toContain("unsubscribe_logs");
  });

  it("uses tRPC for data fetching", () => {
    expect(source).toContain("trpc.fcLogs.list.useQuery");
    expect(source).toContain("trpc.fcLogs.requestScan.useMutation");
    expect(source).toContain("trpc.fcLogs.requestDownload.useMutation");
    expect(source).toContain("trpc.firmware.list.useQuery");
    expect(source).toContain("trpc.firmware.upload.useMutation");
    expect(source).toContain("trpc.firmware.requestFlash.useMutation");
    expect(source).toContain("trpc.diagnostics.latest.useQuery");
    expect(source).toContain("trpc.diagnostics.history.useQuery");
  });

  it("has firmware upload dialog with safety warning", () => {
    expect(source).toContain("Upload Firmware");
    expect(source).toContain("Safety Warning");
    expect(source).toContain(".abin");
  });

  it("has diagnostics gauges for CPU, memory, disk, temperature", () => {
    expect(source).toContain("CPU Usage");
    expect(source).toContain("Memory");
    expect(source).toContain("Disk");
    expect(source).toContain("CPU Temp");
  });

  it("has remote log streaming with service selector", () => {
    expect(source).toContain("log_stream_request");
    expect(source).toContain("logs-ota");
    expect(source).toContain("camera-stream");
    expect(source).toContain("siyi-camera");
    expect(source).toContain("quiver-hub-client");
  });

  it("shows connection status badge", () => {
    expect(source).toContain("ConnectionStatus");
    expect(source).toContain("socketConnected");
  });
});

// ─── Companion Script ───────────────────────────────────────────────────────

describe("Logs & OTA Updates - Companion Script", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("has HubClient class for REST API communication", () => {
    expect(source).toContain("class HubClient:");
  });

  it("has MavFtpClient class for MAVSDK FTP operations", () => {
    expect(source).toContain("class MavFtpClient:");
  });

  it("has LogsOtaJobHandler class for job execution", () => {
    expect(source).toContain("class LogsOtaJobHandler:");
  });

  it("has DiagnosticsCollector class for system health", () => {
    expect(source).toContain("class DiagnosticsCollector:");
  });

  it("has RemoteLogStreamer class for journalctl streaming", () => {
    expect(source).toContain("class RemoteLogStreamer:");
  });

  it("has LogsOtaService main orchestrator class", () => {
    expect(source).toContain("class LogsOtaService:");
  });

  it("handles scan_fc_logs job type", () => {
    expect(source).toContain("handle_scan_fc_logs");
    expect(source).toContain("scan_fc_logs");
  });

  it("handles download_fc_log job type", () => {
    expect(source).toContain("handle_download_fc_log");
    expect(source).toContain("download_fc_log");
  });

  it("handles flash_firmware job type", () => {
    expect(source).toContain("handle_flash_firmware");
    expect(source).toContain("flash_firmware");
  });

  it("monitors ArduPilot flash stages", () => {
    expect(source).toContain("ardupilot.abin");
    expect(source).toContain("ardupilot-verify.abin");
    expect(source).toContain("ardupilot-flash.abin");
    expect(source).toContain("ardupilot-flashed.abin");
  });

  it("has --debug flag for toggleable debug output", () => {
    expect(source).toContain("--debug");
    expect(source).toContain("logging.DEBUG");
  });

  it("has --no-fc flag for diagnostics-only mode", () => {
    expect(source).toContain("--no-fc");
    expect(source).toContain("diagnostics + log streaming only");
  });

  it("uses Socket.IO for real-time events", () => {
    expect(source).toContain("socketio");
    expect(source).toContain("register_companion");
    expect(source).toContain("log_stream_line");
  });

  it("collects CPU, memory, disk, temperature diagnostics", () => {
    expect(source).toContain("cpu_percent");
    expect(source).toContain("memory_percent");
    expect(source).toContain("disk_percent");
    expect(source).toContain("cpu_temp_c");
  });

  it("monitors systemd service statuses", () => {
    expect(source).toContain("MONITORED_SERVICES");
    expect(source).toContain("systemctl");
    expect(source).toContain("is-active");
  });
});

// ─── Systemd Service File ───────────────────────────────────────────────────

describe("Logs & OTA Updates - Systemd Service", () => {
  const source = fs.readFileSync("./companion_scripts/logs-ota.service", "utf-8");

  it("has correct service description", () => {
    expect(source).toContain("Quiver Hub");
    expect(source).toContain("Logs & OTA Service");
  });

  it("runs after network-online.target", () => {
    expect(source).toContain("After=network-online.target");
  });

  it("has restart policy", () => {
    expect(source).toContain("Restart=always");
    expect(source).toContain("RestartSec=5");
  });

  it("sets PYTHONUNBUFFERED for real-time logging", () => {
    expect(source).toContain("PYTHONUNBUFFERED=1");
  });

  it("uses SyslogIdentifier for journalctl filtering", () => {
    expect(source).toContain("SyslogIdentifier=logs-ota");
  });
});

// ─── Install Script ─────────────────────────────────────────────────────────

describe("Logs & OTA Updates - Install Script", () => {
  const source = fs.readFileSync("./companion_scripts/install_logs_ota.sh", "utf-8");

  it("installs required Python packages with --break-system-packages", () => {
    expect(source).toContain("pip3 install --break-system-packages");
    expect(source).toContain("mavsdk");
    expect(source).toContain("requests");
    expect(source).toContain("psutil");
    expect(source).toContain("python-socketio");
  });

  it("prompts for Hub URL, drone ID, API key", () => {
    expect(source).toContain("Hub URL");
    expect(source).toContain("Drone ID");
    expect(source).toContain("API Key");
  });

  it("supports serial, UDP, and no-FC connection modes", () => {
    expect(source).toContain("Serial");
    expect(source).toContain("Ethernet/UDP");
    expect(source).toContain("No FC");
    expect(source).toContain("--no-fc");
  });

  it("creates systemd service and enables it", () => {
    expect(source).toContain("systemctl daemon-reload");
    expect(source).toContain("systemctl enable ${SERVICE_NAME}.service");
    expect(source).toContain("systemctl start ${SERVICE_NAME}.service");
  });

  it("shows useful commands after installation", () => {
    expect(source).toContain("systemctl status ${SERVICE_NAME}");
    expect(source).toContain("journalctl -u ${SERVICE_NAME} -f");
  });
});

// ─── FC Log Download Proxy Endpoint ────────────────────────────────────────

describe("FC Log Download Proxy - REST API", () => {
  const source = fs.readFileSync("./server/rest-api.ts", "utf-8");

  it("has GET /logs/fc-download/:logId endpoint", () => {
    expect(source).toContain('"/logs/fc-download/:logId"');
    expect(source).toContain("router.get");
  });

  it("authenticates via session cookie using sdk.authenticateRequest", () => {
    expect(source).toContain("sdk.authenticateRequest(req)");
    expect(source).toContain("Authentication required");
  });

  it("validates logId is a number", () => {
    expect(source).toContain('parseInt(req.params.logId, 10)');
    expect(source).toContain("Invalid log ID");
  });

  it("looks up the FC log by ID", () => {
    expect(source).toContain("getFcLogById(logId)");
    expect(source).toContain("FC log not found");
  });

  it("rejects logs that are not yet completed", () => {
    expect(source).toContain('fcLog.status !== "completed"');
    expect(source).toContain("FC log has not been downloaded yet");
  });

  it("sets Content-Disposition: attachment header with filename", () => {
    expect(source).toContain("Content-Disposition");
    expect(source).toContain("attachment");
    expect(source).toContain("safeFilename");
  });

  it("sets Content-Type to application/octet-stream", () => {
    // The download proxy should force binary download
    expect(source).toContain('"application/octet-stream"');
  });

  it("forwards Content-Length from upstream", () => {
    expect(source).toContain('upstream.headers.get("content-length")');
    expect(source).toContain('"Content-Length"');
  });

  it("streams the S3 response body to the browser", () => {
    expect(source).toContain("upstream.body");
    expect(source).toContain("reader.read()");
    expect(source).toContain("res.write(value)");
    expect(source).toContain("res.end()");
  });

  it("sanitizes filename to prevent header injection", () => {
    expect(source).toContain("safeFilename");
    expect(source).toContain(".replace(/[^a-zA-Z0-9._-]/g");
  });

  it("has a 2 minute timeout for large file downloads", () => {
    expect(source).toContain("AbortSignal.timeout(120_000)");
  });

  it("handles upstream S3 errors gracefully", () => {
    expect(source).toContain("upstream.ok");
    expect(source).toContain("Storage returned");
  });

  it("imports sdk from _core/sdk", () => {
    expect(source).toContain('import { sdk } from "./_core/sdk"');
  });
});

// ─── Frontend Download-to-PC Flow ──────────────────────────────────────────

describe("FC Log Download to PC - Frontend", () => {
  const source = fs.readFileSync("./client/src/components/apps/LogsOtaApp.tsx", "utf-8");

  it("has triggerBrowserDownload function using the proxy endpoint", () => {
    expect(source).toContain("triggerBrowserDownload");
    expect(source).toContain("/api/rest/logs/fc-download/");
  });

  it("tracks pending browser downloads with a ref", () => {
    expect(source).toContain("pendingBrowserDownloads");
    expect(source).toContain("useRef<Set<number>>");
  });

  it("tracks savingToPc state for UI feedback", () => {
    expect(source).toContain("savingToPc");
    expect(source).toContain("setSavingToPc");
  });

  it("has separate handleDownloadFromFC for discovered logs", () => {
    expect(source).toContain("handleDownloadFromFC");
    expect(source).toContain("downloadMutation.mutate");
  });

  it("has handleSaveToPC for completed logs", () => {
    expect(source).toContain("handleSaveToPC");
    expect(source).toContain("triggerBrowserDownload(log.id, log.filename)");
  });

  it("auto-triggers browser download when companion finishes", () => {
    expect(source).toContain('data.status === "completed"');
    expect(source).toContain("pendingBrowserDownloads.current.has(data.logId)");
    expect(source).toContain("triggerBrowserDownload(data.logId");
  });

  it("shows toast when download from FC starts", () => {
    expect(source).toContain("Downloading log from FC...");
    expect(source).toContain("auto-save to your PC when ready");
  });

  it("shows toast when log is ready for browser download", () => {
    expect(source).toContain("saving to PC");
    expect(source).toContain("prompt a file download");
  });

  it("uses Save icon for the save-to-PC button", () => {
    expect(source).toContain("Save");
    expect(source).toContain("Save to PC");
  });

  it("shows spinner for in-progress downloads", () => {
    expect(source).toContain("Download in progress...");
  });

  it("shows Download from FC tooltip for discovered logs", () => {
    expect(source).toContain("Download from FC & save to PC");
  });

  it("marks pending downloads in the downloadMutation onSuccess", () => {
    expect(source).toContain("pendingBrowserDownloads.current.add(variables.logId)");
  });
});
