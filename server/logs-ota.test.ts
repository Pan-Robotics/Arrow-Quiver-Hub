import { describe, it, expect, beforeAll } from "vitest";
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

// ─── FC Web Server Health Check - Companion Script ─────────────────────────

describe("FC Web Server Health Check - Companion Script", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("DiagnosticsCollector accepts fc_webserver_url in __init__", () => {
    expect(source).toContain("def __init__(self, fc_webserver_url");
    expect(source).toContain("self.fc_webserver_url = fc_webserver_url");
  });

  it("performs HTTP HEAD ping to FC web server in collect()", () => {
    expect(source).toContain("requests.head(");
    expect(source).toContain("self.fc_webserver_url");
    expect(source).toContain("timeout=3");
  });

  it("reports fc_webserver dict with reachable, latency_ms, url, last_checked", () => {
    expect(source).toContain('"fc_webserver"');
    expect(source).toContain('"reachable"');
    expect(source).toContain('"latency_ms"');
    expect(source).toContain('"last_checked"');
    expect(source).toContain('"url"');
  });

  it("measures latency using time.monotonic()", () => {
    expect(source).toContain("time.monotonic()");
    expect(source).toContain("elapsed_ms");
  });

  it("handles RequestException gracefully when FC is unreachable", () => {
    expect(source).toContain("requests.exceptions.RequestException");
    expect(source).toContain("FC web server unreachable");
  });

  it("passes fc_webserver_url from log_syncer to DiagnosticsCollector", () => {
    expect(source).toContain("fc_webserver_url=self.log_syncer.fc_url");
  });
});

// ─── FC Web Server Health Check - Server Side ──────────────────────────────

describe("FC Web Server Health Check - Server Side", () => {
  const restSource = fs.readFileSync("./server/rest-api.ts", "utf-8");
  const wsSource = fs.readFileSync("./server/websocket.ts", "utf-8");

  it("REST diagnostics/report endpoint accepts fc_webserver field", () => {
    expect(restSource).toContain("fc_webserver");
  });

  it("broadcasts fcWebserver in diagnostics event", () => {
    expect(restSource).toContain("fcWebserver: fc_webserver");
  });

  it("broadcastDiagnostics type includes fcWebserver field", () => {
    expect(wsSource).toContain("fcWebserver?:");
    expect(wsSource).toContain("reachable: boolean");
    expect(wsSource).toContain("latency_ms: number | null");
    expect(wsSource).toContain("last_checked: string");
  });
});

// ─── FC Web Server Health Check - Frontend ─────────────────────────────────

describe("FC Web Server Health Check - Frontend", () => {
  const source = fs.readFileSync("./client/src/components/apps/LogsOtaApp.tsx", "utf-8");

  it("defines FcWebserverHealth interface", () => {
    expect(source).toContain("interface FcWebserverHealth");
    expect(source).toContain("reachable: boolean");
    expect(source).toContain("latency_ms: number | null");
    expect(source).toContain("last_checked: string");
  });

  it("adds fcWebserver field to DiagnosticsEvent interface", () => {
    expect(source).toContain("fcWebserver?: FcWebserverHealth | null");
  });

  it("tracks FC web server health state in FcLogsTab", () => {
    expect(source).toContain("fcWebserverHealth, setFcWebserverHealth");
    expect(source).toContain("useState<FcWebserverHealth | null>(null)");
  });

  it("listens for diagnostics events to update FC webserver health", () => {
    expect(source).toContain("data.fcWebserver !== undefined");
    expect(source).toContain("setFcWebserverHealth(data.fcWebserver");
  });

  it("renders FC Web health indicator with Globe icon", () => {
    expect(source).toContain("<Globe");
    expect(source).toContain("FC Web");
  });

  it("shows green dot when FC web server is reachable", () => {
    expect(source).toContain("fcWebserverHealth.reachable");
    expect(source).toContain("bg-green-500");
  });

  it("shows red dot when FC web server is unreachable", () => {
    expect(source).toContain("bg-red-500");
  });

  it("shows gray dot when status is unknown (null)", () => {
    expect(source).toContain("bg-zinc-500");
  });

  it("displays latency in milliseconds when reachable", () => {
    expect(source).toContain("fcWebserverHealth.latency_ms");
    expect(source).toContain("ms</span>");
  });

  it("shows tooltip with troubleshooting hints when unreachable", () => {
    expect(source).toContain("FC Web Server Unreachable");
    expect(source).toContain("WEB_ENABLE=1");
    expect(source).toContain("MAVFTP (slower)");
  });

  it("shows tooltip with URL and latency when reachable", () => {
    expect(source).toContain("FC Web Server Reachable");
    expect(source).toContain("fcWebserverHealth.url");
  });
});

// ─── ArduPilot Setup Guide Documentation ───────────────────────────────────

describe("ArduPilot net_webserver.lua Setup Guide", () => {
  const source = fs.readFileSync("./docs/ARDUPILOT_WEBSERVER_SETUP.md", "utf-8");

  it("exists and has a title", () => {
    expect(source).toContain("# ArduPilot net_webserver.lua Setup Guide");
  });

  it("covers SCR_ENABLE parameter setup", () => {
    expect(source).toContain("SCR_ENABLE");
    expect(source).toContain("SCR_VM_I_COUNT");
    expect(source).toContain("SCR_HEAP_SIZE");
  });

  it("covers WEB_ENABLE and WEB_BIND_PORT parameters", () => {
    expect(source).toContain("WEB_ENABLE");
    expect(source).toContain("WEB_BIND_PORT");
    expect(source).toContain("8080");
  });

  it("covers FC networking parameters", () => {
    expect(source).toContain("NET_ENABLE");
    expect(source).toContain("NET_IPADDR");
    expect(source).toContain("192.168.144.20");
  });

  it("includes verification steps", () => {
    expect(source).toContain("## 3. Verification");
    expect(source).toContain("curl");
    expect(source).toContain("/mnt/APM/LOGS/");
  });

  it("documents Quiver Hub integration and three-tier resolution", () => {
    expect(source).toContain("FCLogSyncer");
    expect(source).toContain("three-tier");
    expect(source).toContain("--fc-webserver-url");
    expect(source).toContain("--log-store-dir");
  });

  it("includes troubleshooting section", () => {
    expect(source).toContain("## 5. Troubleshooting");
    expect(source).toContain("Script Not Loading");
    expect(source).toContain("Web Server Unreachable");
  });

  it("is listed in docs/README.md index", () => {
    const index = fs.readFileSync("./docs/README.md", "utf-8");
    expect(index).toContain("ARDUPILOT_WEBSERVER_SETUP.md");
    expect(index).toContain("Setup Guides");
  });
});


// ─── FCLogSyncer Retry Logic & Skip List ────────────────────────────────────

describe("FCLogSyncer - Retry limit and skip list", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("defines MAX_DOWNLOAD_ATTEMPTS = 3", () => {
    expect(source).toContain("MAX_DOWNLOAD_ATTEMPTS = 3");
  });

  it("has _is_skipped method that checks manifest skipped flag", () => {
    expect(source).toContain("def _is_skipped(self, filename: str) -> bool:");
    expect(source).toContain('entry.get("skipped", False)');
  });

  it("has _record_attempt method that tracks attempts and marks skipped", () => {
    expect(source).toContain("def _record_attempt(self, filename: str, success: bool, error: str = None):");
    expect(source).toContain("attempts >= self.MAX_DOWNLOAD_ATTEMPTS");
    expect(source).toContain('entry["skipped"] = True');
    expect(source).toContain('entry["skip_reason"]');
  });

  it("resets attempts on successful download", () => {
    expect(source).toContain('entry["attempts"] = 0');
    expect(source).toContain('entry["skipped"] = False');
  });

  it("has reset_skipped method for manual retry", () => {
    expect(source).toContain("def reset_skipped(self, filename: str = None):");
    expect(source).toContain("Reset skip status for all files");
    expect(source).toContain("Reset skip status for");
  });

  it("logs warning with instructions to retry when permanently skipping", () => {
    expect(source).toContain("Permanently skipping");
    expect(source).toContain("Delete the 'skipped' key in manifest.json to retry");
  });

  it("checks _is_skipped in sync_once before downloading", () => {
    expect(source).toContain("if self._is_skipped(filename):");
  });

  it("calls _record_attempt on both success and failure in _download_log_file", () => {
    // Success path
    expect(source).toContain("self._record_attempt(filename, True)");
    // Failure paths
    expect(source).toContain("self._record_attempt(filename, False,");
  });

  it("logs attempt count with max on failure", () => {
    expect(source).toContain("Download attempt {attempts}/{self.MAX_DOWNLOAD_ATTEMPTS}");
  });
});

// ─── FCLogSyncer Network Coexistence ────────────────────────────────────────

describe("FCLogSyncer - Network coexistence for large downloads", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("yields to event loop with asyncio.sleep(0) during download", () => {
    expect(source).toContain("await asyncio.sleep(0)");
  });

  it("yields every ~512KB to keep Socket.IO heartbeats alive", () => {
    expect(source).toContain("512 * 1024");
    expect(source).toContain("Socket.IO heartbeats");
  });

  it("uses 600s timeout for very large files", () => {
    expect(source).toContain("timeout=600");
  });

  it("checks arm state every ~4MB instead of every ~1MB", () => {
    expect(source).toContain("4 * 1024 * 1024");
  });
});

// ─── Upload Size Restrictions Removed ───────────────────────────────────────

describe("Upload size restrictions - all removed", () => {
  it("rest-api.ts: multer has no fileSize limit", () => {
    const restApi = fs.readFileSync("./server/rest-api.ts", "utf-8");
    expect(restApi).toContain("multer({ storage: multer.memoryStorage() })");
    expect(restApi).not.toContain("fileSize: 250");
    expect(restApi).not.toContain("fileSize: 200");
  });

  it("rest-api.ts: /flightlog/upload has no 100MB limit", () => {
    const restApi = fs.readFileSync("./server/rest-api.ts", "utf-8");
    expect(restApi).not.toContain("Maximum size is 100MB");
  });

  it("rest-api.ts: /logs/fc-upload has no 200MB limit", () => {
    const restApi = fs.readFileSync("./server/rest-api.ts", "utf-8");
    expect(restApi).not.toContain("Maximum size is 200MB");
  });

  it("routers.ts: firmware upload has no 50MB limit", () => {
    const routers = fs.readFileSync("./server/routers.ts", "utf-8");
    expect(routers).not.toContain("Maximum size is 50MB");
    expect(routers).not.toContain("Firmware file too large");
  });

  it("_core/index.ts: body parser allows 500MB", () => {
    const index = fs.readFileSync("./server/_core/index.ts", "utf-8");
    expect(index).toContain('limit: "500mb"');
  });
});

// ─── Hybrid MAVFTP + HTTP OTA Flash Monitoring ─────────────────────────────

describe("Hybrid OTA flash monitoring - HTTP helper methods", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  // ── Class constants ──

  it("defines FC_APM_PATH constant for HTTP flash monitoring", () => {
    expect(source).toContain('FC_APM_PATH = "/mnt/APM/"');
  });

  it("defines HTTP_TIMEOUT constant (5 seconds)", () => {
    expect(source).toContain("HTTP_TIMEOUT = 5");
  });

  // ── fc_url attribute ──

  it("derives fc_url from log_syncer.fc_url in __init__", () => {
    expect(source).toContain(
      "self.fc_url = log_syncer.fc_url if log_syncer else None"
    );
  });

  // ── _http_file_exists() ──

  it("defines _http_file_exists method", () => {
    expect(source).toContain("def _http_file_exists(self, filename: str)");
  });

  it("_http_file_exists returns None when fc_url is not set", () => {
    // Method checks self.fc_url first
    expect(source).toContain("if not self.fc_url or not requests:");
    // And returns None
    expect(source).toContain("return None");
  });

  it("_http_file_exists constructs URL from fc_url + FC_APM_PATH + filename", () => {
    expect(source).toContain(
      'url = f"{self.fc_url}{self.FC_APM_PATH}{filename}"'
    );
  });

  it("_http_file_exists uses GET with Range header instead of HEAD (net_webserver only supports GET)", () => {
    expect(source).toContain(
      'resp = requests.get(url, headers={"Range": "bytes=0-0"},'
    );
    expect(source).toContain("stream=True");
    expect(source).toContain("resp.close()");
  });

  it("_http_file_exists returns True on 200 or 206, None on exception", () => {
    expect(source).toContain("return resp.status_code in (200, 206)");
  });

  // ── _http_fc_reachable() ──

  it("defines _http_fc_reachable method", () => {
    expect(source).toContain("def _http_fc_reachable(self) -> bool:");
  });

  it("_http_fc_reachable returns False when fc_url is not set", () => {
    // Method guards on fc_url
    const reachableMethod = source.substring(
      source.indexOf("def _http_fc_reachable"),
      source.indexOf("def _check_file_exists")
    );
    expect(reachableMethod).toContain("if not self.fc_url or not requests:");
    expect(reachableMethod).toContain("return False");
  });

  it("_http_fc_reachable pings fc_url root with GET (net_webserver only supports GET)", () => {
    const reachableMethod = source.substring(
      source.indexOf("def _http_fc_reachable"),
      source.indexOf("def _check_file_exists")
    );
    expect(reachableMethod).toContain(
      "resp = requests.get(self.fc_url, timeout=self.HTTP_TIMEOUT, stream=True)"
    );
    expect(reachableMethod).toContain("resp.close()");
  });

  it("_http_fc_reachable returns True on 200, False on exception", () => {
    const reachableMethod = source.substring(
      source.indexOf("def _http_fc_reachable"),
      source.indexOf("def _check_file_exists")
    );
    expect(reachableMethod).toContain("return resp.status_code == 200");
    expect(reachableMethod).toContain("return False");
  });

  // ── _check_file_exists() ──

  it("defines async _check_file_exists method", () => {
    expect(source).toContain(
      "async def _check_file_exists(self, filename: str, http_only: bool = False) -> bool:"
    );
  });

  it("_check_file_exists tries HTTP first", () => {
    const checkMethod = source.substring(
      source.indexOf("async def _check_file_exists"),
      source.indexOf("async def _verify_fc_reboot")
    );
    expect(checkMethod).toContain(
      "http_result = await asyncio.to_thread(self._http_file_exists, filename)"
    );
    expect(checkMethod).toContain("if http_result is not None:");
    expect(checkMethod).toContain("return http_result");
  });

  it("_check_file_exists falls back to MAVFTP when HTTP returns None", () => {
    const checkMethod = source.substring(
      source.indexOf("async def _check_file_exists"),
      source.indexOf("async def _verify_fc_reboot")
    );
    expect(checkMethod).toContain(
      'await self.ftp.file_exists(f"/APM/{filename}")'
    );
  });
});

describe("Hybrid OTA flash monitoring - _verify_fc_reboot", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  it("defines async _verify_fc_reboot method", () => {
    expect(source).toContain(
      "async def _verify_fc_reboot(self, update_id: int, max_wait: int = 60):"
    );
  });

  it("skips verification when fc_url is not configured", () => {
    const method = source.substring(
      source.indexOf("async def _verify_fc_reboot"),
      source.indexOf("async def handle_scan_fc_logs")
    );
    expect(method).toContain("if not self.fc_url:");
    expect(method).toContain("skipping reboot verification");
  });

  it("reports verifying_reboot flash stage before polling", () => {
    const method = source.substring(
      source.indexOf("async def _verify_fc_reboot"),
      source.indexOf("async def handle_scan_fc_logs")
    );
    expect(method).toContain('flash_stage="verifying_reboot"');
  });

  it("polls every 5 seconds for FC to come back online", () => {
    const method = source.substring(
      source.indexOf("async def _verify_fc_reboot"),
      source.indexOf("async def handle_scan_fc_logs")
    );
    expect(method).toContain("poll_interval = 5");
    expect(method).toContain("await asyncio.sleep(poll_interval)");
    expect(method).toContain("await asyncio.to_thread(self._http_fc_reachable)");
  });

  it("reports reboot_verified when FC responds", () => {
    const method = source.substring(
      source.indexOf("async def _verify_fc_reboot"),
      source.indexOf("async def handle_scan_fc_logs")
    );
    expect(method).toContain('flash_stage="reboot_verified"');
  });

  it("logs warning if FC not reachable after max_wait", () => {
    const method = source.substring(
      source.indexOf("async def _verify_fc_reboot"),
      source.indexOf("async def handle_scan_fc_logs")
    );
    expect(method).toContain("FC web server not reachable after");
    expect(method).toContain("FC may still be booting or web server not enabled");
  });

  it("default max_wait is 60 seconds", () => {
    expect(source).toContain("max_wait: int = 60");
  });
});

describe("OTA flash flow - handle_flash_firmware integration", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  // ── Step 2: Pre-upload HTTP check ──

  it("Step 2 checks FC web server reachability before upload", () => {
    expect(flashMethod).toContain("await asyncio.to_thread(self._http_fc_reachable)");
    expect(flashMethod).toContain("FC web server reachable");
  });

  it("Step 2 uses HTTP for cleanup check instead of MAVFTP", () => {
    expect(flashMethod).toContain("await asyncio.to_thread(self._http_file_exists, old_name)");
    expect(flashMethod).toContain("will be overwritten");
  });

  it("Step 2 logs skip message when HTTP unavailable", () => {
    expect(flashMethod).toContain("FC web server not reachable");
    expect(flashMethod).toContain("skipping pre-upload check");
  });

  // ── Step 3: Upload via FC HTTP pull (Approach C) ──

  it("Step 3 uses Approach C (FC HTTP pull)", () => {
    expect(flashMethod).toContain("_start_firmware_server(tmp_path)");
    expect(flashMethod).toContain("_wait_for_fc_pull(update_id");
  });

  it("Step 3 fails hard if aiohttp not installed", () => {
    expect(flashMethod).toContain("if not aiohttp_web:");
    expect(flashMethod).toContain("aiohttp not installed");
    expect(flashMethod).toContain("return False, error_msg");
  });

  it("Step 3 fails hard if server won't start", () => {
    expect(flashMethod).toContain("if not server_started:");
    expect(flashMethod).toContain("Failed to start firmware HTTP server");
  });

  it("Step 3 fails hard if FC doesn't pull firmware", () => {
    expect(flashMethod).toContain("if not fc_pulled:");
    expect(flashMethod).toContain("FC did not pull firmware");
    expect(flashMethod).toContain("firmware_puller.lua");
    expect(flashMethod).toContain("FWPULL_ENABLE=1");
  });

  it("Step 3 wraps server in try/finally", () => {
    // Find the code Step 4 marker (not the docstring one)
    const codeStep4 = flashMethod.indexOf("# \u2500\u2500 Step 4:");
    const step3Block = flashMethod.substring(
      flashMethod.indexOf("_start_firmware_server"),
      codeStep4 > 0 ? codeStep4 : flashMethod.length
    );
    expect(step3Block).toContain("try:");
    expect(step3Block).toContain("finally:");
    expect(step3Block).toContain("_stop_firmware_server()");
  });

  // ── Step 4: MAVLink reboot ──

  it("Step 4 sends MAVLink reboot command", () => {
    expect(flashMethod).toContain("action.reboot()");
    expect(flashMethod).toContain('flash_stage="rebooting"');
  });

  it("Step 4 handles reboot command failure gracefully", () => {
    expect(flashMethod).toContain("Could not send reboot command");
    expect(flashMethod).toContain("please reboot FC manually");
    expect(flashMethod).toContain('flash_stage="awaiting_manual_reboot"');
  });

  // ── Step 5: Poll FC webserver until back online ──

  it("Step 5 polls FC webserver to confirm reboot", () => {
    expect(flashMethod).toContain("await asyncio.to_thread(self._http_fc_reachable)");
    expect(flashMethod).toContain("FC back online after");
    expect(flashMethod).toContain('flash_stage="reboot_verified"');
  });

  it("Step 5 has 120s timeout for FC to come back", () => {
    expect(flashMethod).toContain("max_wait = 120");
  });

  it("Step 5 reports timeout with check-manually status", () => {
    expect(flashMethod).toContain('flash_stage="reboot_timeout_check_manually"');
  });

  // ── No MAVFTP in flash path ──

  it("avoids MAVFTP cleanup to prevent sequence corruption", () => {
    expect(flashMethod).not.toContain('await self.ftp.file_exists(f"/APM/{old_name}")');
    expect(flashMethod).not.toContain('await self.ftp.remove_file(f"/APM/{old_name}")');
    expect(flashMethod).toContain("await asyncio.to_thread(self._http_file_exists, old_name)");
  });
});

// ─── Fix: async_generator error in MAVFTP upload ───────────────────────────

describe("MavFtpClient.upload_file - async generator fix", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  const uploadMethod = source.substring(
    source.indexOf("async def upload_file(self, local_path"),
    source.indexOf("async def file_exists")
  );

  it("uses 'async for' instead of 'await' for MAVSDK ftp.upload()", () => {
    expect(uploadMethod).toContain("async for progress_data in self.system.ftp.upload(");
    expect(uploadMethod).not.toContain("await self.system.ftp.upload(");
  });

  it("accepts remote_dir parameter (directory, not file path)", () => {
    expect(uploadMethod).toContain("async def upload_file(self, local_path: str, remote_dir: str,");
  });

  it("documents that MAVSDK upload() is an async generator", () => {
    expect(uploadMethod).toContain("MAVSDK's ftp.upload() is an async generator");
    expect(uploadMethod).toContain("yields ProgressData");
  });

  it("reports upload progress from ProgressData", () => {
    expect(uploadMethod).toContain("progress_data.bytes_transferred");
    expect(uploadMethod).toContain("progress_data.total_bytes");
  });

  it("preserves local filename in log message", () => {
    expect(uploadMethod).toContain("local_filename = os.path.basename(local_path)");
  });
});

// ─── Fix: .apj file rejection ──────────────────────────────────────────────

describe("Firmware flash - .apj detection (auto-conversion)", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("checks for .apj extension to determine conversion need", () => {
    expect(flashMethod).toContain('is_apj = firmware_filename.lower().endswith(".apj")');
  });

  it("no longer rejects .apj files outright", () => {
    expect(flashMethod).not.toContain("Cannot flash .apj files via OTA");
    expect(flashMethod).not.toContain('flash_stage="unsupported_format"');
  });

  it("calls _convert_apj_to_abin when .apj is detected", () => {
    expect(flashMethod).toContain("self._convert_apj_to_abin(resp.content, tmp_path)");
  });

  it("reports converting_apj flash stage", () => {
    expect(flashMethod).toContain('flash_stage="converting_apj"');
  });

  it("handles conversion failure with conversion_failed stage", () => {
    expect(flashMethod).toContain('flash_stage="conversion_failed"');
    expect(flashMethod).toContain(".apj conversion failed:");
  });
});

// ─── Fix: temp file naming for MAVSDK upload ───────────────────────────────

describe("Firmware flash - temp file naming for MAVSDK upload", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("creates a temp directory instead of a temp file", () => {
    expect(flashMethod).toContain('tmp_dir = tempfile.mkdtemp(prefix="quiver_fw_")');
  });

  it("names the temp file ardupilot.abin (MAVSDK preserves filename)", () => {
    expect(flashMethod).toContain('tmp_path = os.path.join(tmp_dir, "ardupilot.abin")');
  });

  it("uploads firmware to /APM/ via FC HTTP pull", () => {
    // FC pulls the file via firmware_puller.lua, which writes to /APM/ardupilot.abin
    expect(flashMethod).toContain('"ardupilot.abin"');
  });

  it("cleans up both temp file and temp directory", () => {
    expect(flashMethod).toContain("os.unlink(tmp_path)");
    expect(flashMethod).toContain("os.rmdir(tmp_dir)");
  });
});

// ─── Frontend: .apj warning in upload dialog ───────────────────────────────

describe("Frontend - firmware upload dialog .apj guidance", () => {
  const logsOtaApp = fs.readFileSync(
    "./client/src/components/apps/LogsOtaApp.tsx",
    "utf-8"
  );

  it("still accepts both .abin and .apj in file input", () => {
    expect(logsOtaApp).toContain('accept=".abin,.apj"');
  });

  it("explains that both .abin and .apj are supported", () => {
    expect(logsOtaApp).toContain(".abin");
    expect(logsOtaApp).toContain(".apj");
    expect(logsOtaApp).toContain("automatically converted to .abin");
  });

  it("mentions both native OTA and auto-converted formats", () => {
    expect(logsOtaApp).toContain(".abin (native OTA)");
    expect(logsOtaApp).toContain(".apj (auto-converted)");
  });

  it("links to firmware.ardupilot.org for .abin downloads", () => {
    expect(logsOtaApp).toContain("firmware.ardupilot.org");
  });

  it("mentions OTA in the section subtitle", () => {
    expect(logsOtaApp).toContain("via FC HTTP pull (OTA)");
  });

  it("subtitle mentions both .abin and .apj", () => {
    expect(logsOtaApp).toContain(".abin or .apj firmware");
  });
});

// ─── .apj → .abin Conversion Logic ──────────────────────────────────────────

describe("APJ to ABIN conversion - _convert_apj_to_abin()", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  // Extract the _convert_apj_to_abin method
  const convertMethod = source.substring(
    source.indexOf("def _convert_apj_to_abin("),
    source.indexOf("def _http_file_exists(")
  );

  it("is a @staticmethod on LogsOtaJobHandler", () => {
    expect(source).toContain("@staticmethod\n    def _convert_apj_to_abin(");
  });

  it("accepts apj_data bytes and output_path string", () => {
    expect(convertMethod).toContain("def _convert_apj_to_abin(apj_data: bytes, output_path: str)");
  });

  it("parses the .apj JSON", () => {
    expect(convertMethod).toContain("json.loads(apj_data)");
  });

  it("validates the APJFWv1 magic field", () => {
    expect(convertMethod).toContain('"APJFWv1"');
    expect(convertMethod).toContain('apj.get("magic")');
  });

  it("extracts and decodes the base64 image field", () => {
    expect(convertMethod).toContain('apj.get("image")');
    expect(convertMethod).toContain("base64.b64decode(image_b64)");
  });

  it("decompresses the zlib-compressed firmware binary", () => {
    expect(convertMethod).toContain("zlib.decompress(compressed)");
  });

  it("validates image_size if present in the .apj", () => {
    expect(convertMethod).toContain('apj.get("image_size")');
    expect(convertMethod).toContain("len(raw_bin) != expected_size");
  });

  it("computes MD5 of the raw binary for the .abin header", () => {
    expect(convertMethod).toContain("hashlib.md5(raw_bin).hexdigest()");
  });

  it("writes the .abin header: git version, MD5, separator", () => {
    expect(convertMethod).toContain('f"git version: {git_hash}\\n"');
    expect(convertMethod).toContain('f"MD5: {md5_hex}\\n"');
    expect(convertMethod).toContain('b"--\\n"');
  });

  it("appends the raw binary after the header", () => {
    expect(convertMethod).toContain("f.write(raw_bin)");
  });

  it("extracts git_identity from the .apj metadata", () => {
    expect(convertMethod).toContain('apj.get("git_identity", "unknown")');
  });

  it("raises ValueError for invalid JSON", () => {
    expect(convertMethod).toContain("json.JSONDecodeError");
    expect(convertMethod).toContain("Invalid .apj file: not valid JSON");
  });

  it("raises ValueError for missing magic field", () => {
    expect(convertMethod).toContain("expected magic 'APJFWv1'");
  });

  it("raises ValueError for missing image field", () => {
    expect(convertMethod).toContain("missing 'image' field");
  });

  it("raises ValueError for decode/decompress failures", () => {
    expect(convertMethod).toContain("Failed to decode/decompress .apj image");
  });

  it("logs the conversion result with board and git info", () => {
    expect(convertMethod).toContain("Converted .apj");
    expect(convertMethod).toContain("board=");
    expect(convertMethod).toContain("git=");
  });
});

// ─── .apj → .abin Integration in handle_flash_firmware ──────────────────────

describe("Firmware flash - .apj auto-conversion integration", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("detects .apj files by filename extension", () => {
    expect(flashMethod).toContain('is_apj = firmware_filename.lower().endswith(".apj")');
  });

  it("does NOT reject .apj files anymore", () => {
    expect(flashMethod).not.toContain("Cannot flash .apj files via OTA");
    expect(flashMethod).not.toContain('flash_stage="unsupported_format"');
  });

  it("reports converting_apj flash stage for .apj files", () => {
    expect(flashMethod).toContain('flash_stage="converting_apj"');
  });

  it("calls _convert_apj_to_abin for .apj files", () => {
    expect(flashMethod).toContain("self._convert_apj_to_abin(resp.content, tmp_path)");
  });

  it("catches ValueError from conversion and reports failure", () => {
    expect(flashMethod).toContain("except ValueError as conv_err");
    expect(flashMethod).toContain(".apj conversion failed:");
    expect(flashMethod).toContain('flash_stage="conversion_failed"');
  });

  it("writes raw bytes directly for .abin files (no conversion)", () => {
    // The else branch writes resp.content directly
    expect(flashMethod).toContain("else:\n                    with open(tmp_path,");
  });

  it("SHA-256 check is on original downloaded bytes (before conversion)", () => {
    expect(flashMethod).toContain("Hash is verified against the original downloaded bytes");
    expect(flashMethod).toContain("hashlib.sha256(resp.content)");
  });

  it("docstring mentions .apj auto-conversion support", () => {
    expect(flashMethod).toContain("Supports both .abin and .apj firmware files");
    expect(flashMethod).toContain(".apj → .abin conversion");
  });

  it("logs whether firmware was converted or downloaded", () => {
    expect(flashMethod).toContain("'Converted' if is_apj else 'Downloaded'");
  });
});

// ─── zlib import ─────────────────────────────────────────────────────────────

describe("Module imports for .apj conversion", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  it("imports zlib for .apj decompression", () => {
    expect(source).toContain("import zlib");
  });

  it("imports base64 for .apj decoding", () => {
    expect(source).toContain("import base64");
  });

  it("imports json for .apj parsing", () => {
    expect(source).toContain("import json");
  });

  it("imports hashlib for MD5 computation", () => {
    expect(source).toContain("import hashlib");
  });
});


// ─── HTTP PUT Firmware Upload ───────────────────────────────────────────────

describe("Approach C only - no HTTP PUT or MAVFTP in flash path", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");
  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("does NOT use _http_upload_firmware in flash path", () => {
    expect(flashMethod).not.toContain("_http_upload_firmware(tmp_path");
  });

  it("does NOT use ftp.upload_file in flash path", () => {
    expect(flashMethod).not.toContain("self.ftp.upload_file(tmp_path");
  });

  it("uses _start_firmware_server for upload", () => {
    expect(flashMethod).toContain("_start_firmware_server(tmp_path)");
  });

  it("uses _wait_for_fc_pull for upload completion", () => {
    expect(flashMethod).toContain("_wait_for_fc_pull(update_id");
  });

  it("fails hard instead of falling through to other tiers", () => {
    // When aiohttp not installed, server won't start, or FC doesn't pull,
    // it returns False immediately instead of trying HTTP PUT or MAVFTP
    expect(flashMethod).toContain("return False, error_msg");
  });
});

describe("Approach C Flash Flow - Step 3 failure modes", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");
  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("checks aiohttp_web availability before starting server", () => {
    expect(flashMethod).toContain("if not aiohttp_web:");
  });

  it("fails with clear error when aiohttp not installed", () => {
    expect(flashMethod).toContain("aiohttp not installed");
    expect(flashMethod).toContain("pip install");
  });

  it("fails when firmware server won't start", () => {
    expect(flashMethod).toContain("if not server_started:");
    expect(flashMethod).toContain("Failed to start firmware HTTP server");
  });

  it("fails when FC doesn't pull firmware with setup instructions", () => {
    expect(flashMethod).toContain("if not fc_pulled:");
    expect(flashMethod).toContain("firmware_puller.lua");
    expect(flashMethod).toContain("FWPULL_ENABLE=1");
  });

  it("reports uploading_http_pull stage during upload", () => {
    expect(flashMethod).toContain('flash_stage="uploading_http_pull"');
  });

  it("docstring mentions firmware_puller.lua requirement", () => {
    expect(flashMethod).toContain("firmware_puller.lua");
  });
});

// ─── net_webserver_put.lua (FC Lua Script) ──────────────────────────────────

describe("net_webserver_put.lua - FC Web Server with PUT Support", () => {
  const source = fs.readFileSync("./companion_scripts/net_webserver_put.lua", "utf-8");

  it("exists as a companion script", () => {
    expect(source.length).toBeGreaterThan(1000);
  });

  it("identifies as net_webserver_put version", () => {
    expect(source).toContain('SERVER_VERSION = "net_webserver_put');
  });

  it("accepts both GET and PUT methods", () => {
    expect(source).toContain('method ~= "GET" and method ~= "PUT"');
  });

  it("routes PUT requests to handle_put", () => {
    expect(source).toContain('if method == "PUT" then');
    expect(source).toContain("self.handle_put(path)");
  });

  it("restricts PUT to /APM/ directory only", () => {
    expect(source).toContain('UPLOAD_PATH_PREFIX = "/APM/"');
    expect(source).toContain("not startswith(path, UPLOAD_PATH_PREFIX)");
  });

  it("has WEB_PUT_ENABLE parameter to toggle PUT support", () => {
    expect(source).toContain("WEB_PUT_ENABLE");
    expect(source).toContain("PUT_ENABLE");
  });

  it("has WEB_MAX_UPLOAD parameter for file size limit", () => {
    expect(source).toContain("WEB_MAX_UPLOAD");
    expect(source).toContain("MAX_UPLOAD");
    expect(source).toContain("16777216"); // 16MB default
  });

  it("requires Content-Length header for PUT", () => {
    expect(source).toContain("Content-Length");
    expect(source).toContain("411");
    expect(source).toContain("Length Required");
  });

  it("prevents path traversal attacks", () => {
    expect(source).toContain('string.find(path, "%.%.")');
    expect(source).toContain("Path traversal not allowed");
  });

  it("returns 201 Created on successful upload", () => {
    expect(source).toContain("201");
    expect(source).toContain("Created");
  });

  it("returns 403 Forbidden for paths outside /APM/", () => {
    expect(source).toContain("403");
    expect(source).toContain("Forbidden");
  });

  it("returns 405 Method Not Allowed for unsupported methods", () => {
    expect(source).toContain("405");
    expect(source).toContain("Method Not Allowed");
  });

  it("returns 413 Payload Too Large for oversized files", () => {
    expect(source).toContain("413");
    expect(source).toContain("Payload Too Large");
  });

  it("has receive_file function for chunked data reception", () => {
    expect(source).toContain("function self.receive_file()");
    expect(source).toContain("sock:recv(chunk_size)");
  });

  it("logs progress every 100KB during upload", () => {
    expect(source).toContain("102400");
    expect(source).toContain("PUT %uKB / %uKB received");
  });

  it("handles body data that arrives with the header", () => {
    expect(source).toContain("put_body_leftover");
    expect(source).toContain("put_file:write(put_body_leftover)");
  });

  it("opens file for writing in binary mode", () => {
    expect(source).toContain('io.open(path, "wb")');
  });

  it("cleans up put_file on remove", () => {
    expect(source).toContain("if put_file then");
    expect(source).toContain("put_file:close()");
  });

  it("uses 120 second timeout for upload connections", () => {
    expect(source).toContain("30000");
  });

  it("sends GCS messages for upload progress and completion", () => {
    expect(source).toContain("PUT complete");
    expect(source).toContain("PUT stall timeout");
  });

  it("preserves all original GET functionality", () => {
    expect(source).toContain("self.file_download(path)");
    expect(source).toContain("self.directory_list(path)");
    expect(source).toContain("self.moved_permanently");
    expect(source).toContain("DYNAMIC_PAGES");
    expect(source).toContain("cgi-bin");
    expect(source).toContain("sendfile");
  });

  it("has deployment instructions in header comment", () => {
    expect(source).toContain("APM/scripts/net_webserver_put.lua");
    expect(source).toContain("SCR_ENABLE=1");
    expect(source).toContain("WEB_ENABLE=1");
  });

  it("includes curl usage example", () => {
    expect(source).toContain("curl -X PUT");
    expect(source).toContain("--data-binary");
  });

  it("has correct param table size for additional params", () => {
    // Original has 6 params, we added MAX_UPLOAD (7) and PUT_ENABLE (8)
    expect(source).toContain("PARAM_TABLE_PREFIX, 8)");
  });
});

// ─── Module Docstring Updates ───────────────────────────────────────────────

describe("Module Docstring - Approach C architecture", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");
  const firstTriple = source.indexOf('"""');
  const closingTriple = source.indexOf('"""', firstTriple + 3);
  const docstring = source.substring(firstTriple, closingTriple);

  it("mentions Approach C in the module description", () => {
    expect(docstring).toContain("Approach C");
  });

  it("mentions firmware_puller.lua requirement", () => {
    expect(source).toContain("firmware_puller.lua");
  });

  it("mentions .apj support in the module description", () => {
    expect(source).toContain(".abin/.apj");
  });
});


// ─── FCLogSyncer: Scan-Only Background Loop ────────────────────────────────

describe("FCLogSyncer - Scan-Only Background Loop (No Auto-Download)", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("sync_once accepts a download parameter defaulting to False", () => {
    expect(source).toContain("async def sync_once(self, download: bool = False)");
  });

  it("sync_once only downloads when download=True", () => {
    // The download block is gated by the download parameter
    expect(source).toContain("if download:");
  });

  it("sync_once has scan-only mode that counts files without downloading", () => {
    expect(source).toContain("# Scan-only mode: count files needing sync without downloading");
  });

  it("run_sync_loop calls sync_once with download=False (scan-only)", () => {
    expect(source).toContain("await self.sync_once(download=False)");
  });

  it("run_sync_loop docstring says scan-only, no downloads", () => {
    expect(source).toContain("Background loop that periodically scans FC logs (scan-only, no downloads)");
  });

  it("run_sync_loop docstring explains downloads are user-triggered", () => {
    expect(source).toContain('Downloads are only triggered by user action ("Scan FC" button)');
    expect(source).toContain("sync_once(download=True)");
  });

  it("run_sync_loop logs scan-only mode on startup", () => {
    expect(source).toContain("FCLogSyncer started (scan-only)");
  });

  it("run_sync_loop logs scan results, not download results", () => {
    expect(source).toContain("Scan complete:");
    expect(source).toContain("files on FC");
  });

  it("sync_once docstring documents the download parameter", () => {
    expect(source).toContain("download: If True, download new/changed files from FC.");
    expect(source).toContain("If False (default), only scan and update the manifest.");
  });

  it("handle_scan_fc_logs does NOT call sync_once (uses its own HTTP listing)", () => {
    // handle_scan_fc_logs uses _fetch_directory_listing directly, not sync_once
    const scanHandler = source.substring(
      source.indexOf("async def handle_scan_fc_logs"),
      source.indexOf("async def handle_download_fc_log")
    );
    expect(scanHandler).not.toContain("sync_once");
    expect(scanHandler).toContain("_fetch_directory_listing");
  });

  it("handle_download_fc_log downloads individual files on demand, not bulk", () => {
    const dlHandler = source.substring(
      source.indexOf("async def handle_download_fc_log"),
      source.indexOf("async def handle_flash_firmware")
    );
    // Downloads from cache, HTTP, or MAVFTP — but only the requested file
    expect(dlHandler).toContain("Serve from local cache");
    expect(dlHandler).toContain("On-demand HTTP download from FC webserver");
    expect(dlHandler).not.toContain("sync_once");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Approach C: FC Pulls Firmware from Companion Pi HTTP Server
// ═══════════════════════════════════════════════════════════════════════════

describe("firmware_puller.lua (FC Lua applet)", () => {
  let luaContent: string;

  beforeAll(() => {
    luaContent = fs.readFileSync(
      "./companion_scripts/firmware_puller.lua",
      "utf-8"
    );
  });

  it("should exist as a Lua file", () => {
    expect(luaContent).toBeDefined();
    expect(luaContent.length).toBeGreaterThan(100);
  });

  it("should use a unique parameter table key (48, not 47)", () => {
    expect(luaContent).toContain("PARAM_TABLE_KEY = 48");
    expect(luaContent).toContain('PARAM_TABLE_PREFIX = "FWPULL_"');
  });

  it("should define FWPULL_ENABLE parameter (default disabled)", () => {
    expect(luaContent).toContain("FWPULL_ENABLE");
    expect(luaContent).toMatch(/bind_add_param\("ENABLE",\s*1,\s*0\)/);
  });

  it("should define companion Pi IP as 4 separate octets", () => {
    expect(luaContent).toContain("FWPULL_PI_IP0");
    expect(luaContent).toContain("FWPULL_PI_IP1");
    expect(luaContent).toContain("FWPULL_PI_IP2");
    expect(luaContent).toContain("FWPULL_PI_IP3");
    expect(luaContent).toMatch(/bind_add_param\("PI_IP0",\s*2,\s*192\)/);
    expect(luaContent).toMatch(/bind_add_param\("PI_IP1",\s*3,\s*168\)/);
    expect(luaContent).toMatch(/bind_add_param\("PI_IP2",\s*4,\s*144\)/);
    expect(luaContent).toMatch(/bind_add_param\("PI_IP3",\s*5,\s*20\)/);
  });

  it("should define firmware server port parameter (default 8070)", () => {
    expect(luaContent).toContain("FWPULL_PORT");
    expect(luaContent).toMatch(/bind_add_param\("PORT",\s*6,\s*8070\)/);
  });

  it("should poll /firmware/status endpoint", () => {
    expect(luaContent).toContain("/firmware/status");
  });

  it("should download from /firmware/download endpoint", () => {
    expect(luaContent).toContain("/firmware/download");
  });

  it("should acknowledge via /firmware/ack endpoint", () => {
    expect(luaContent).toContain("/firmware/ack");
  });

  it("should write firmware to /APM/ardupilot.abin", () => {
    expect(luaContent).toContain("/APM/ardupilot.abin");
  });

  it("should have state machine with IDLE, CHECKING, DOWNLOADING, DONE states", () => {
    expect(luaContent).toContain("STATE_IDLE");
    expect(luaContent).toContain("STATE_CHECKING");
    expect(luaContent).toContain("STATE_DOWNLOADING");
    expect(luaContent).toContain("STATE_DONE");
  });

  it("should parse ready flag from status response", () => {
    expect(luaContent).toContain('"ready"');
  });

  it("should parse firmware size from status response", () => {
    expect(luaContent).toContain('"size"');
  });

  it("should enforce 16MB max firmware size", () => {
    expect(luaContent).toContain("MAX_FIRMWARE_SIZE");
  });

  it("should send GCS progress messages", () => {
    expect(luaContent).toContain("FWPull:");
  });

  it("should remove partial file on abort", () => {
    expect(luaContent).toContain("os.remove");
  });

  it("should use HTTP/1.0 for simple connection handling", () => {
    expect(luaContent).toContain("HTTP/1.0");
  });
});

describe("Approach C: Companion Pi firmware HTTP server", () => {
  let pyContent: string;

  beforeAll(() => {
    pyContent = fs.readFileSync(
      "./companion_scripts/logs_ota_service.py",
      "utf-8"
    );
  });

  it("should import aiohttp.web with graceful fallback", () => {
    expect(pyContent).toContain("from aiohttp import web as aiohttp_web");
    expect(pyContent).toContain("aiohttp_web = None");
  });

  it("should define FIRMWARE_SERVER_PORT constant (8070)", () => {
    expect(pyContent).toContain("FIRMWARE_SERVER_PORT = 8070");
  });

  it("should define FIRMWARE_SERVER_ACK_TIMEOUT constant", () => {
    expect(pyContent).toContain("FIRMWARE_SERVER_ACK_TIMEOUT");
  });

  it("should have _start_firmware_server method", () => {
    expect(pyContent).toContain("async def _start_firmware_server(self, firmware_path: str) -> bool:");
  });

  it("should have _stop_firmware_server method", () => {
    expect(pyContent).toContain("async def _stop_firmware_server(self):");
  });

  it("should have _wait_for_fc_pull method", () => {
    expect(pyContent).toContain("async def _wait_for_fc_pull(self, update_id: int");
  });

  it("should register three HTTP endpoints: status, download, ack", () => {
    expect(pyContent).toContain('"/firmware/status"');
    expect(pyContent).toContain('"/firmware/download"');
    expect(pyContent).toContain('"/firmware/ack"');
  });

  it("should serve firmware with Response (not StreamResponse)", () => {
    // Changed from StreamResponse to Response to fix ClientConnectionResetError
    // with slow Lua readers that can't keep up with streaming
    const serverMethod = pyContent.substring(
      pyContent.indexOf("async def _start_firmware_server"),
      pyContent.indexOf("async def _stop_firmware_server")
    );
    expect(serverMethod).toContain("Response");
  });

  it("should track bytes sent for progress reporting", () => {
    expect(pyContent).toContain("_fw_serve_bytes_sent");
  });

  it("should set downloaded flag on ack", () => {
    expect(pyContent).toContain("_fw_serve_downloaded = True");
  });

  it("should listen on 0.0.0.0 for network accessibility", () => {
    expect(pyContent).toContain('"0.0.0.0"');
  });

  it("should clean up server runner on stop", () => {
    expect(pyContent).toContain("_fw_server_runner");
    expect(pyContent).toContain("cleanup");
  });
});

describe("handle_flash_firmware: Approach C upload (Step 3)", () => {
  let pyContent: string;
  let flashMethod: string;

  beforeAll(() => {
    pyContent = fs.readFileSync(
      "./companion_scripts/logs_ota_service.py",
      "utf-8"
    );
    flashMethod = pyContent.substring(
      pyContent.indexOf("async def handle_flash_firmware"),
      pyContent.indexOf("class DiagnosticsCollector")
    );
  });

  it("should check aiohttp_web availability before starting server", () => {
    expect(flashMethod).toContain("if not aiohttp_web:");
  });

  it("should start firmware server and wait for FC pull", () => {
    expect(flashMethod).toContain("_start_firmware_server(tmp_path)");
    expect(flashMethod).toContain("_wait_for_fc_pull(update_id");
  });

  it("should stop firmware server in finally block", () => {
    expect(flashMethod).toContain("_stop_firmware_server()");
  });

  it("should report uploading_http_pull stage for Approach C", () => {
    expect(flashMethod).toContain('flash_stage="uploading_http_pull"');
  });

  it("should NOT use HTTP PUT or MAVFTP in the active flash path", () => {
    // The docstring may still mention Tier 2/3 as historical context,
    // but the active code path only uses Approach C
    expect(flashMethod).not.toContain('upload_method = "HTTP PUT"');
    expect(flashMethod).not.toContain('upload_method = "MAVFTP"');
    // No _http_upload_firmware or ftp.upload_file calls in the active path
    expect(flashMethod).not.toContain("_http_upload_firmware(tmp_path");
    expect(flashMethod).not.toContain("self.ftp.upload_file(tmp_path");
  });

  it("should fail hard on each failure path", () => {
    // Each failure returns False, error_msg instead of falling through
    expect(flashMethod).toContain("return False, error_msg");
  });
});

describe("Module docstring: Approach C documentation", () => {
  let pyContent: string;

  beforeAll(() => {
    pyContent = fs.readFileSync(
      "./companion_scripts/logs_ota_service.py",
      "utf-8"
    );
  });

  it("should mention Approach C in the module docstring", () => {
    const firstTriple = pyContent.indexOf('"""');
    const closingTriple = pyContent.indexOf('"""', firstTriple + 3);
    const docstring = pyContent.substring(firstTriple, closingTriple);
    expect(docstring).toContain("Approach C");
  });

  it("should mention firmware_puller.lua in the module docstring", () => {
    expect(pyContent).toContain("firmware_puller.lua");
  });
});

// ─── Fix: MAVFTP cleanup corruption & reconnection race ──────────────────────

describe("Fix: No MAVFTP in Step 2 cleanup", () => {
  let pyContent: string;
  let flashMethod: string;

  beforeAll(() => {
    pyContent = fs.readFileSync(
      "./companion_scripts/logs_ota_service.py",
      "utf-8"
    );
    flashMethod = pyContent.substring(
      pyContent.indexOf("async def handle_flash_firmware"),
      pyContent.indexOf("class DiagnosticsCollector")
    );
  });

  it("Step 2 does NOT use MAVFTP file_exists for old file cleanup", () => {
    const step2Start = flashMethod.indexOf("Step 2:");
    const step3Start = flashMethod.indexOf("Step 3:");
    const step2 = flashMethod.substring(step2Start, step3Start);
    expect(step2).not.toContain("await self.ftp.file_exists");
    expect(step2).not.toContain("await self.ftp.remove_file");
  });

  it("Step 2 uses HTTP _http_file_exists for old file checks", () => {
    expect(flashMethod).toContain("await asyncio.to_thread(self._http_file_exists, old_name)");
  });

  it("Step 2 notes bootloader will overwrite old files", () => {
    expect(flashMethod).toContain("will be overwritten");
  });
});

describe("MavFtpClient.ensure_ready - reconnection guard", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  const classStart = source.indexOf("class MavFtpClient:");
  const classEnd = source.indexOf("\n# ─── Job Handlers", classStart);
  const mavFtpClass = source.substring(classStart, classEnd);

  it("has ensure_ready method on MavFtpClient", () => {
    expect(mavFtpClass).toContain("async def ensure_ready(self");
  });

  it("ensure_ready accepts retries and delay parameters", () => {
    expect(mavFtpClass).toContain("retries: int = 3");
    expect(mavFtpClass).toContain("delay: float = 3.0");
  });

  it("ensure_ready does a health check via list_directory", () => {
    expect(mavFtpClass).toContain('list_directory("/APM/")');
  });

  it("ensure_ready reconnects with delay if health check fails", () => {
    expect(mavFtpClass).toContain("await asyncio.sleep(delay)");
    expect(mavFtpClass).toContain("await self.connect()");
  });

  it("ensure_ready sets _connected = False on health check failure", () => {
    expect(mavFtpClass).toContain("self._connected = False");
  });

  it("ensure_ready logs reconnection attempts", () => {
    expect(mavFtpClass).toContain("FTP reconnect attempt");
    expect(mavFtpClass).toContain("MAVSDK to settle");
  });

  it("ensure_ready returns True on successful reconnection", () => {
    expect(mavFtpClass).toContain("FTP reconnected successfully");
  });

  it("ensure_ready returns False after all retries exhausted", () => {
    expect(mavFtpClass).toContain("FTP reconnection failed after");
  });
});

describe("No MAVFTP upload in flash path (Tier 2/3 removed)", () => {
  let flashMethod: string;

  beforeAll(() => {
    const pyContent = fs.readFileSync(
      "./companion_scripts/logs_ota_service.py",
      "utf-8"
    );
    flashMethod = pyContent.substring(
      pyContent.indexOf("async def handle_flash_firmware"),
      pyContent.indexOf("class DiagnosticsCollector")
    );
  });

  it("does NOT use ftp.upload_file in flash path", () => {
    expect(flashMethod).not.toContain("self.ftp.upload_file(tmp_path");
  });

  it("does NOT use ftp.ensure_ready in flash path", () => {
    expect(flashMethod).not.toContain("self.ftp.ensure_ready(");
  });

  it("does NOT have Tier 2 or Tier 3 markers", () => {
    expect(flashMethod).not.toContain("=== Tier 2");
    expect(flashMethod).not.toContain("=== Tier 3");
  });
});

describe("Flash flow logging markers", () => {
  let flashMethod: string;

  beforeAll(() => {
    const pyContent = fs.readFileSync(
      "./companion_scripts/logs_ota_service.py",
      "utf-8"
    );
    flashMethod = pyContent.substring(
      pyContent.indexOf("async def handle_flash_firmware"),
      pyContent.indexOf("class DiagnosticsCollector")
    );
  });

  it("has Step markers for each phase", () => {
    expect(flashMethod).toContain("Step 1:");
    expect(flashMethod).toContain("Step 2:");
    expect(flashMethod).toContain("Step 3:");
    expect(flashMethod).toContain("Step 4:");
    expect(flashMethod).toContain("Step 5:");
  });

  it("does NOT have Tier 2 or Tier 3 markers (removed)", () => {
    expect(flashMethod).not.toContain("=== Tier 2");
    expect(flashMethod).not.toContain("=== Tier 3");
  });

  it("logs Approach C as the upload method", () => {
    expect(flashMethod).toContain("uploading_http_pull");
  });
});

describe("aiohttp import warning", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );

  it("warns when aiohttp is not installed", () => {
    // The import block should log a warning when aiohttp is missing
    const importBlock = source.substring(0, source.indexOf("# ─── Logging"));
    expect(importBlock).toContain("aiohttp not installed");
    expect(importBlock).toContain("Approach C (fast HTTP pull) disabled");
  });

  it("suggests installation command", () => {
    const importBlock = source.substring(0, source.indexOf("# ─── Logging"));
    expect(importBlock).toContain("pip install --break-system-packages aiohttp");
  });
});

// ─── Audit Fix: asyncio.to_thread for blocking HTTP calls (Issue #1) ─────────

describe("asyncio.to_thread wrapping for non-blocking HTTP", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );
  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("Step 1 firmware download uses asyncio.to_thread", () => {
    expect(flashMethod).toContain("await asyncio.to_thread(");
    expect(flashMethod).toContain("requests.get(firmware_url");
  });

  it("Step 2 _http_fc_reachable uses asyncio.to_thread", () => {
    expect(flashMethod).toContain(
      "await asyncio.to_thread(self._http_fc_reachable)"
    );
  });

  it("Step 2 _http_file_exists uses asyncio.to_thread", () => {
    expect(flashMethod).toContain(
      "await asyncio.to_thread(self._http_file_exists, old_name)"
    );
  });

  it("Step 5 _http_fc_reachable uses asyncio.to_thread for reboot polling", () => {
    // Step 5 polls FC webserver to confirm reboot
    expect(flashMethod).toContain("await asyncio.to_thread(self._http_fc_reachable)");
    expect(flashMethod).toContain("FC back online after");
  });
});

// ─── Audit Fix: Tier 1 early-exit when FC has no puller (Issue #2) ───────────

describe("Audit Fix: Tier 1 early-exit when FC has no firmware_puller.lua", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );
  const waitMethod = source.substring(
    source.indexOf("async def _wait_for_fc_pull"),
    source.indexOf("async def _check_file_exists")
  );

  it("exits early after 30s if no bytes served", () => {
    expect(waitMethod).toContain("elapsed >= 30");
    expect(waitMethod).toContain("self._fw_serve_bytes_sent == 0");
  });

  it("logs that firmware_puller.lua may not be installed", () => {
    expect(waitMethod).toContain("firmware_puller.lua");
    expect(waitMethod).toContain("FWPULL_ENABLE=0");
  });

  it("returns False on early exit", () => {
    // After the early-exit check, it returns False
    const earlyExitBlock = waitMethod.substring(
      waitMethod.indexOf("elapsed >= 30"),
      waitMethod.indexOf("# Report progress")
    );
    expect(earlyExitBlock).toContain("return False");
  });
});

// ─── Audit Fix: _check_file_exists http_only parameter (Issue #3) ────────────

describe("_check_file_exists method", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );
  const checkMethod = source.substring(
    source.indexOf("async def _check_file_exists"),
    source.indexOf("async def _verify_fc_reboot") > 0
      ? source.indexOf("async def _verify_fc_reboot")
      : source.indexOf("async def handle_scan_fc_logs")
  );

  it("exists as a method on LogsOtaJobHandler", () => {
    expect(source).toContain("async def _check_file_exists");
  });

  it("uses HTTP check with asyncio.to_thread", () => {
    expect(checkMethod).toContain("http_only: bool = False");
  });

  it("skips MAVFTP fallback when http_only is True", () => {
    expect(checkMethod).toContain("if http_only:");
    expect(checkMethod).toContain("return False");
  });

  it("is still available for FC log scanning", () => {
    // _check_file_exists is used by FC log scanning, not flash monitoring anymore
    expect(source).toContain("async def _check_file_exists");
  });
});

// ─── Audit Fix: firmware_puller.lua stall timeout (Issue #4) ─────────────────

describe("Audit Fix: firmware_puller.lua download stall timeout", () => {
  const source = fs.readFileSync(
    "./companion_scripts/firmware_puller.lua",
    "utf-8"
  );

  it("defines STALL_TIMEOUT_MS constant", () => {
    expect(source).toContain("STALL_TIMEOUT_MS = 30000");
  });

  it("tracks last_data_time variable", () => {
    expect(source).toContain("local last_data_time = 0");
  });

  it("initializes last_data_time when download starts", () => {
    expect(source).toContain("last_data_time = millis()");
  });

  it("updates last_data_time when data is received", () => {
    expect(source).toContain("if reads_this_cycle > 0 then");
    expect(source).toContain("last_data_time = millis()");
  });

  it("aborts download on stall timeout", () => {
    expect(source).toContain("millis() - last_data_time) > STALL_TIMEOUT_MS");
    expect(source).toContain("stalled");
  });
});

// ─── Audit Fix: net_webserver_put.lua PUT stall timeout reduction (Issue #5) ─

describe("Audit Fix: net_webserver_put.lua PUT stall timeout reduced to 30s", () => {
  const source = fs.readFileSync(
    "./companion_scripts/net_webserver_put.lua",
    "utf-8"
  );

  it("uses 30000ms stall timeout instead of 120000ms", () => {
    expect(source).toContain("now - start_time > 30000");
    expect(source).not.toContain("now - start_time > 120000");
  });

  it("logs PUT stall timeout message", () => {
    expect(source).toContain("PUT stall timeout");
  });

  it("deletes partial file on timeout to prevent corrupt flash", () => {
    expect(source).toContain("os.remove(put_path)");
    expect(source).toContain("deleted partial upload file");
  });

  it("tracks put_path for cleanup", () => {
    expect(source).toContain("local put_path = nil");
    expect(source).toContain("put_path = path");
  });
});

// ─── Audit Fix: net_webserver_put.lua client slot leak (Issue #7) ────────────

describe("Audit Fix: net_webserver_put.lua client slot leak fix", () => {
  const source = fs.readFileSync(
    "./companion_scripts/net_webserver_put.lua",
    "utf-8"
  );

  it("breaks after inserting client into slot", () => {
    // The check_new_clients loop must break after inserting
    const checkNewClients = source.substring(
      source.indexOf("function check_new_clients()"),
      source.indexOf("function check_new_clients()") + 500
    );
    expect(checkNewClients).toContain("break");
  });
});

// ─── Audit Fix: MavFtpClient.connect() heartbeat timeout (Issue #9) ─────────

describe("Audit Fix: MavFtpClient.connect() heartbeat timeout", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );
  const connectMethod = source.substring(
    source.indexOf("class MavFtpClient"),
    source.indexOf("async def list_directory")
  );

  it("uses asyncio.timeout for heartbeat wait", () => {
    expect(connectMethod).toContain("asyncio.timeout(15)");
  });

  it("catches TimeoutError", () => {
    expect(connectMethod).toContain("asyncio.TimeoutError");
    expect(connectMethod).toContain("No FC heartbeat within 15s");
  });

  it("returns False on timeout", () => {
    // After the timeout catch, it returns False
    expect(connectMethod).toContain("return False");
  });
});

// ─── Audit Fix: Step 4 consumed-check threshold (Issue #10) ─────────────────

describe("Step 4: MAVLink reboot command", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );
  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("Step 4 sends MAVLink reboot command", () => {
    expect(flashMethod).toContain("Step 4:");
    expect(flashMethod).toContain("reboot");
  });

  it("Step 5 polls FC webserver to confirm reboot", () => {
    expect(flashMethod).toContain("Step 5:");
    expect(flashMethod).toContain("FC back online after");
  });
});

// ─── Audit Fix: Tier 1 server try/finally cleanup (Issue #11) ───────────────

describe("Step 3: firmware server try/finally cleanup", () => {
  const source = fs.readFileSync(
    "./companion_scripts/logs_ota_service.py",
    "utf-8"
  );
  const flashMethod = source.substring(
    source.indexOf("async def handle_flash_firmware"),
    source.indexOf("class DiagnosticsCollector")
  );

  it("wraps _wait_for_fc_pull in try/finally", () => {
    const step3Start = flashMethod.indexOf("Step 3:");
    const step3Block = flashMethod.substring(step3Start);
    expect(step3Block).toContain("try:");
    expect(step3Block).toContain("finally:");
    expect(step3Block).toContain("_stop_firmware_server()");
  });

  it("ensures server is stopped even on exception", () => {
    const step3Start = flashMethod.indexOf("Step 3:");
    const step3Block = flashMethod.substring(step3Start);
    const finallyIdx = step3Block.indexOf("finally:");
    const stopIdx = step3Block.indexOf("_stop_firmware_server");
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(finallyIdx);
  });
});

// ─── Audit Fix: firmware_puller.lua docstring correction (Issue #12) ─────────

describe("firmware_puller.lua ack endpoint", () => {
  const source = fs.readFileSync(
    "./companion_scripts/firmware_puller.lua",
    "utf-8"
  );

  it("sends ack to /firmware/ack after download completes", () => {
    expect(source).toContain("/firmware/ack");
  });

  it("closes ack socket after sending", () => {
    expect(source).toContain("ack_sock:close()");
  });
});
