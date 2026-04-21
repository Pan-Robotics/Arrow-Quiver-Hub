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

  it("_http_file_exists uses HEAD request with timeout", () => {
    expect(source).toContain(
      "resp = requests.head(url, timeout=self.HTTP_TIMEOUT)"
    );
  });

  it("_http_file_exists returns True on 200, None on exception", () => {
    expect(source).toContain("return resp.status_code == 200");
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

  it("_http_fc_reachable pings fc_url root with HEAD", () => {
    const reachableMethod = source.substring(
      source.indexOf("def _http_fc_reachable"),
      source.indexOf("def _check_file_exists")
    );
    expect(reachableMethod).toContain(
      "resp = requests.head(self.fc_url, timeout=self.HTTP_TIMEOUT)"
    );
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
      "async def _check_file_exists(self, filename: str) -> bool:"
    );
  });

  it("_check_file_exists tries HTTP first", () => {
    const checkMethod = source.substring(
      source.indexOf("async def _check_file_exists"),
      source.indexOf("async def _verify_fc_reboot")
    );
    expect(checkMethod).toContain(
      "http_result = self._http_file_exists(filename)"
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
    expect(method).toContain("self._http_fc_reachable()");
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

describe("Hybrid OTA flash monitoring - handle_flash_firmware integration", () => {
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
    expect(flashMethod).toContain("self._http_fc_reachable()");
    expect(flashMethod).toContain(
      "FC web server reachable — will use HTTP for flash monitoring"
    );
  });

  it("Step 2 logs fallback to MAVFTP if HTTP unavailable", () => {
    expect(flashMethod).toContain(
      "FC web server not reachable — using MAVFTP for flash monitoring"
    );
  });

  // ── Step 4: Hybrid stage monitoring ──

  it("Step 4 uses _check_file_exists for stage polling (HTTP first, MAVFTP fallback)", () => {
    expect(flashMethod).toContain("await self._check_file_exists(stage_file)");
  });

  it("Step 4 tracks whether HTTP is being used for logging", () => {
    expect(flashMethod).toContain("using_http = self.fc_url is not None");
    expect(flashMethod).toContain(
      'method = "HTTP" if using_http else "MAVFTP"'
    );
  });

  it("Step 4 uses _check_file_exists for consumed-file check too", () => {
    // The ardupilot.abin consumption check also uses the hybrid method
    expect(flashMethod).toContain(
      'await self._check_file_exists("ardupilot.abin")'
    );
  });

  // ── Step 5: Post-reboot verification ──

  it("Step 5 calls _verify_fc_reboot after flash completion", () => {
    expect(flashMethod).toContain("await self._verify_fc_reboot(update_id)");
  });

  it("Step 5 also calls _verify_fc_reboot when FC reboots during flash stage", () => {
    // When current_stage_idx >= 2 and connection lost, also verify reboot
    const rebootSection = flashMethod.substring(
      flashMethod.indexOf("FC likely rebooting with new firmware")
    );
    expect(rebootSection).toContain("await self._verify_fc_reboot(update_id)");
  });

  it("reports flash_stage='rebooting' when connection lost at stage >= 2", () => {
    expect(flashMethod).toContain('flash_stage="rebooting"');
  });

  // ── Flash stages unchanged ──

  it("still monitors all three stage files in order", () => {
    expect(flashMethod).toContain('"ardupilot-verify.abin", "verifying", 70');
    expect(flashMethod).toContain('"ardupilot-flash.abin", "flashing", 80');
    expect(flashMethod).toContain('"ardupilot-flashed.abin", "completed", 100');
  });

  it("still uses MAVFTP for actual firmware upload (ardupilot.abin)", () => {
    expect(flashMethod).toContain(
      'await self.ftp.upload_file(tmp_path, "/APM/"'
    );
  });

  it("still cleans old .abin files via MAVFTP before upload", () => {
    expect(flashMethod).toContain(
      'await self.ftp.file_exists(f"/APM/{old_name}")'
    );
    expect(flashMethod).toContain(
      'await self.ftp.remove_file(f"/APM/{old_name}")'
    );
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

  it("uploads to /APM/ directory (not /APM/ardupilot.abin)", () => {
    expect(flashMethod).toContain('await self.ftp.upload_file(tmp_path, "/APM/"');
  });

  it("does NOT upload to /APM/ardupilot.abin (old bug)", () => {
    expect(flashMethod).not.toContain('upload_file(tmp_path, "/APM/ardupilot.abin"');
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
    expect(logsOtaApp).toContain("via MAVFTP (OTA)");
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

describe("HTTP PUT Firmware Upload - Companion Script", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("has _http_upload_firmware method", () => {
    expect(source).toContain("def _http_upload_firmware(self, local_path: str");
  });

  it("uploads to /APM/ardupilot.abin via HTTP PUT", () => {
    expect(source).toContain('url = f"{self.fc_url}/APM/ardupilot.abin"');
  });

  it("uses requests.put for the upload", () => {
    expect(source).toContain("requests.put(");
  });

  it("sends Content-Length and Content-Type headers", () => {
    expect(source).toContain('"Content-Length": str(file_size)');
    expect(source).toContain('"Content-Type": "application/octet-stream"');
  });

  it("has a ProgressReader class for chunked progress reporting", () => {
    expect(source).toContain("class ProgressReader:");
    expect(source).toContain("def read(self, size=-1):");
    expect(source).toContain("self._callback(self._uploaded, self._total)");
  });

  it("returns True on HTTP 201 Created", () => {
    expect(source).toContain("if resp.status_code == 201:");
    expect(source).toContain("return True");
  });

  it("returns False on HTTP 405 Method Not Allowed (stock webserver)", () => {
    expect(source).toContain("elif resp.status_code == 405:");
    expect(source).toContain("stock net_webserver.lua");
  });

  it("returns False on HTTP 403 Forbidden", () => {
    expect(source).toContain("elif resp.status_code == 403:");
  });

  it("handles ConnectionError gracefully (no PUT support)", () => {
    expect(source).toContain("requests.exceptions.ConnectionError");
  });

  it("has 300 second timeout for large file uploads", () => {
    expect(source).toContain("timeout=300");
  });

  it("returns False when fc_url is not available", () => {
    const methodBlock = source.substring(
      source.indexOf("def _http_upload_firmware"),
      source.indexOf("def _http_fc_reachable") > source.indexOf("def _http_upload_firmware")
        ? source.indexOf("async def _check_file_exists")
        : source.length
    );
    expect(methodBlock).toContain("if not self.fc_url or not requests:");
    expect(methodBlock).toContain("return False");
  });
});

describe("HTTP PUT Upload - Flash Flow Integration", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  // Extract the handle_flash_firmware method
  const flashStart = source.indexOf("async def handle_flash_firmware");
  const nextClass = source.indexOf("\nclass ", flashStart + 1);
  const nextTopLevel = source.indexOf("\n# ═", flashStart + 1);
  const flashEnd = Math.min(
    nextClass > flashStart ? nextClass : source.length,
    nextTopLevel > flashStart ? nextTopLevel : source.length
  );
  const flashMethod = source.substring(flashStart, flashEnd);

  it("tries HTTP PUT upload before MAVFTP", () => {
    const httpPutIdx = flashMethod.indexOf("_http_upload_firmware");
    const mavftpIdx = flashMethod.indexOf("self.ftp.upload_file");
    expect(httpPutIdx).toBeGreaterThan(-1);
    expect(mavftpIdx).toBeGreaterThan(-1);
    expect(httpPutIdx).toBeLessThan(mavftpIdx);
  });

  it("checks FC reachability before attempting HTTP PUT", () => {
    expect(flashMethod).toContain("if self._http_fc_reachable():");
    expect(flashMethod).toContain("Attempting fast HTTP PUT upload");
  });

  it("falls back to MAVFTP when HTTP PUT fails", () => {
    expect(flashMethod).toContain('if upload_method == "MAVFTP":');
    expect(flashMethod).toContain("falling back to MAVFTP");
  });

  it("tracks upload method (HTTP PUT vs MAVFTP)", () => {
    expect(flashMethod).toContain('upload_method = "MAVFTP"');
    expect(flashMethod).toContain('upload_method = "HTTP PUT"');
  });

  it("reports different flash stages for HTTP vs MAVFTP upload", () => {
    expect(flashMethod).toContain('flash_stage="uploading_http"');
    expect(flashMethod).toContain('flash_stage="uploading_mavftp"');
  });

  it("logs which upload method was used", () => {
    expect(flashMethod).toContain("via {upload_method}");
  });

  it("docstring mentions HTTP PUT as primary upload method", () => {
    expect(flashMethod).toContain("HTTP PUT to FC web server (fast, ~650 KB/s");
    expect(flashMethod).toContain("MAVFTP upload (slow fallback, ~5 KB/s");
  });

  it("docstring mentions net_webserver_put.lua requirement", () => {
    expect(flashMethod).toContain("net_webserver_put.lua");
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
    expect(source).toContain("PUT %uKB received");
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

  it("uses 60 second timeout for upload connections", () => {
    expect(source).toContain("60000");
  });

  it("sends GCS messages for upload progress and completion", () => {
    expect(source).toContain("PUT complete");
    expect(source).toContain("PUT timeout");
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

describe("Module Docstring - HTTP PUT Upload", () => {
  const source = fs.readFileSync("./companion_scripts/logs_ota_service.py", "utf-8");

  it("mentions HTTP PUT in the module description", () => {
    expect(source).toContain("HTTP PUT (fast) or MAVFTP (fallback)");
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
