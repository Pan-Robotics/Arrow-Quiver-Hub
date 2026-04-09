# Logs & OTA Updates Pipeline

**Quiver Hub — Companion Computer to Cloud**

This document describes the full architecture of the Logs & OTA Updates pipeline, covering the companion Python script that runs on the Raspberry Pi, the server-side endpoints and WebSocket handlers on Quiver Hub, the database schema, and the browser-based frontend UI. All components are designed to work together over the internet via Tailscale, with no requirement that the drone and the user's PC share a local network.

---

## Architecture Overview

The pipeline connects three layers: the **flight controller** (ArduPilot running on a Cube Orange or similar), the **companion computer** (Raspberry Pi 4/5 on the drone), and the **Quiver Hub** cloud server. The companion script bridges the FC and the Hub, while the browser connects directly to the Hub for real-time monitoring and control.

```
┌─────────────────────┐     MAVFTP/MAVLink      ┌──────────────────────┐
│   Flight Controller  │◄──────────────────────►│   Raspberry Pi       │
│   (ArduPilot)        │   Serial or Ethernet    │   (Companion)        │
│                      │                          │                      │
│  • SD card logs      │                          │  logs_ota_service.py │
│  • Firmware flash    │                          │  • MAVSDK/MAVFTP     │
│  • ardupilot.abin    │                          │  • Job polling       │
└─────────────────────┘                          │  • Diagnostics       │
                                                  │  • Log streaming     │
                                                  └──────────┬───────────┘
                                                             │
                                                   REST API + Socket.IO
                                                   (via Tailscale/Internet)
                                                             │
                                                  ┌──────────▼───────────┐
                                                  │   Quiver Hub         │
                                                  │   (Cloud Server)     │
                                                  │                      │
                                                  │  • tRPC routers      │
                                                  │  • REST endpoints    │
                                                  │  • WebSocket server  │
                                                  │  • MySQL database    │
                                                  │  • S3 storage        │
                                                  └──────────┬───────────┘
                                                             │
                                                        WebSocket
                                                             │
                                                  ┌──────────▼───────────┐
                                                  │   Browser            │
                                                  │   (LogsOtaApp.tsx)   │
                                                  │                      │
                                                  │  • FC Logs tab       │
                                                  │  • OTA Updates tab   │
                                                  │  • Diagnostics tab   │
                                                  │  • Remote Logs tab   │
                                                  └──────────────────────┘
```

---

## Data Flow by Feature

### 1. FC Log Scanning and Download

The user clicks **Scan FC Logs** in the browser. This triggers a tRPC mutation that creates a `scan_fc_logs` job in the `droneJobs` queue. The companion script polls for pending jobs every 5 seconds, picks up the scan job, and uses MAVSDK's FTP plugin to list the `/APM/LOGS/` directory on the FC's SD card. The discovered `.BIN` and `.log` files are reported back to the Hub via `POST /api/rest/logs/fc-list`, which upserts them into the `fcLogs` database table.

When the user clicks **Download** on a specific log, a `download_fc_log` job is created. The companion script downloads the file from the FC via MAVFTP to a temporary local file, then uploads the file content (base64-encoded) to the Hub via `POST /api/rest/logs/fc-upload`. The Hub stores the file in S3 and updates the `fcLogs` record with the S3 URL. Throughout this process, progress is reported via `POST /api/rest/logs/fc-progress` and broadcast to the browser over WebSocket as `fc_log_progress` events.

| Step | Actor | Endpoint / Protocol | Direction |
|------|-------|---------------------|-----------|
| User clicks "Scan FC Logs" | Browser | `trpc.fcLogs.requestScan` | Browser → Hub |
| Hub creates job | Hub | `droneJobs` table | Internal |
| Pi polls for jobs | Pi | `trpc.droneJobs.getPendingJobs` | Pi → Hub |
| Pi scans FC SD card | Pi | MAVSDK FTP `list_directory` | Pi → FC |
| Pi reports discovered logs | Pi | `POST /api/rest/logs/fc-list` | Pi → Hub |
| Hub broadcasts to browser | Hub | WebSocket `fc_log_progress` | Hub → Browser |
| User clicks "Download" | Browser | `trpc.fcLogs.requestDownload` | Browser → Hub |
| Pi downloads from FC | Pi | MAVSDK FTP `download` | Pi ← FC |
| Pi uploads to Hub | Pi | `POST /api/rest/logs/fc-upload` | Pi → Hub |
| Hub stores in S3 | Hub | `storagePut()` | Internal |

### 2. OTA Firmware Flash

The user uploads a firmware file (`.abin` or `.apj`, max 50 MB) through the OTA Updates tab. The file is base64-encoded and sent to `trpc.firmware.upload`, which stores it in S3 and creates a `firmwareUpdates` record with status `uploaded`. When the user clicks **Flash to FC**, a `flash_firmware` job is created containing the S3 URL.

The companion script picks up the job, downloads the firmware from S3, removes any existing `ardupilot*.abin` files from the FC's `/APM/` directory, and uploads the new firmware as `ardupilot.abin` via MAVFTP. ArduPilot then processes the firmware through a well-defined rename sequence that the script monitors by polling for file existence:

| Stage File | Meaning | Progress |
|------------|---------|----------|
| `ardupilot.abin` | Firmware uploaded, waiting for FC to process | 65% |
| `ardupilot-verify.abin` | FC is verifying CRC integrity | 70% |
| `ardupilot-flash.abin` | FC is writing firmware to internal flash | 80% |
| `ardupilot-flashed.abin` | Flash complete, FC will reboot | 100% |

Each stage transition is reported via `POST /api/rest/firmware/progress` and broadcast to the browser as `firmware_progress` WebSocket events. If the FC reboots during the flash stage (connection lost at stage index >= 2), the script assumes success. The entire process has a 5-minute timeout.

### 3. System Diagnostics

The companion script collects system health metrics every 10 seconds using `psutil` (with a fallback to `/proc` and `sysfs` if psutil is unavailable). The collected data includes CPU usage percentage, memory usage percentage, disk usage percentage, CPU temperature (from `cpu_thermal` or `coretemp` sensors), system uptime, network interface statistics (IP, RX/TX bytes), and the status of monitored systemd services.

The diagnostics snapshot is sent to `POST /api/rest/diagnostics/report`, which inserts it into the `systemDiagnostics` table and broadcasts it to the browser via WebSocket. The frontend Diagnostics tab displays live gauges for CPU, memory, disk, and temperature, along with a services status grid and a network interfaces table. Historical data is available via `trpc.diagnostics.history` for charting.

| Metric | Source | Collection Method |
|--------|--------|-------------------|
| CPU % | `psutil.cpu_percent(interval=1)` | 1-second sample |
| Memory % | `psutil.virtual_memory().percent` | Instant read |
| Disk % | `psutil.disk_usage("/").percent` | Instant read |
| CPU Temp | `psutil.sensors_temperatures()` | Thermal zone |
| Uptime | `time.time() - psutil.boot_time()` | Calculated |
| Network | `psutil.net_io_counters(pernic=True)` | Per-interface |
| Services | `systemctl is-active <service>` | Subprocess call |

### 4. Remote Log Streaming

The Remote Logs tab provides a live terminal view of journalctl output from any systemd service running on the companion computer. When the user selects a service (e.g., `logs-ota`, `camera-stream`, `siyi-camera`, `quiver-hub-client`) and clicks **Start Streaming**, the browser emits a `subscribe_logs` Socket.IO event followed by a `log_stream_request` event with `action: "start"`.

The Hub relays the request to the companion script via Socket.IO. The companion spawns `journalctl -f -u <service> -n <lines> --no-pager -o short-iso` as an async subprocess and reads lines in a buffered loop (flushing every 500ms or every 20 lines). Lines are emitted back to the Hub as `log_stream_line` events, which the Hub broadcasts to the browser's `logs:<droneId>` room as `log_stream` events. The browser renders them in a scrollable terminal-style container with auto-scroll.

---

## Server-Side Components

### Database Schema

Three tables support the pipeline, all defined in `drizzle/schema.ts`:

**`fcLogs`** — Tracks flight controller log files discovered on the FC SD card and their download status.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `int` (PK, auto) | Surrogate key |
| `droneId` | `varchar(64)` | Drone identifier |
| `remotePath` | `varchar(512)` | Path on FC SD card (e.g., `/APM/LOGS/00000042.BIN`) |
| `filename` | `varchar(255)` | Original filename |
| `fileSize` | `int` | File size in bytes |
| `status` | `enum` | `discovered` → `downloading` → `uploading` → `completed` / `failed` |
| `progress` | `int` | Download progress (0–100) |
| `storageKey` | `varchar(512)` | S3 storage key |
| `url` | `varchar(1024)` | Public S3 URL |
| `errorMessage` | `text` | Error details if failed |
| `discoveredAt` | `timestamp` | When the log was first seen |
| `downloadedAt` | `timestamp` | When download completed |

**`firmwareUpdates`** — Tracks firmware files uploaded by the user and their flash status.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `int` (PK, auto) | Surrogate key |
| `droneId` | `varchar(64)` | Target drone |
| `filename` | `varchar(255)` | Firmware filename (e.g., `arducopter.abin`) |
| `fileSize` | `int` | File size in bytes |
| `storageKey` | `varchar(512)` | S3 storage key |
| `url` | `varchar(1024)` | S3 download URL |
| `status` | `enum` | `uploaded` → `queued` → `transferring` → `flashing` → `verifying` → `completed` / `failed` |
| `flashStage` | `varchar(64)` | ArduPilot rename stage (e.g., `ardupilot-verify.abin`) |
| `progress` | `int` | Flash progress (0–100) |
| `errorMessage` | `text` | Error details if failed |
| `initiatedBy` | `int` | User ID who uploaded |
| `createdAt` | `timestamp` | Upload time |
| `startedAt` | `timestamp` | Flash start time |
| `completedAt` | `timestamp` | Flash completion time |

**`systemDiagnostics`** — Stores periodic health snapshots from the companion computer.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `int` (PK, auto) | Surrogate key |
| `droneId` | `varchar(64)` | Companion identifier |
| `cpuPercent` | `int` | CPU usage % |
| `memoryPercent` | `int` | Memory usage % |
| `diskPercent` | `int` | Disk usage % |
| `cpuTempC` | `int` | CPU temperature in Celsius |
| `uptimeSeconds` | `int` | System uptime |
| `services` | `json` | `{serviceName: "active"\|"inactive"\|"failed"}` |
| `network` | `json` | `{interface: {ip, rx_bytes, tx_bytes}}` |
| `timestamp` | `timestamp` | Snapshot time |

### REST API Endpoints

These endpoints are used by the companion script (not the browser). All require `api_key` and `drone_id` in the request body for authentication.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/rest/logs/fc-list` | POST | Report discovered FC log files (upserts into `fcLogs`) |
| `/api/rest/logs/fc-progress` | POST | Update download progress for an FC log |
| `/api/rest/logs/fc-upload` | POST | Upload downloaded FC log content (base64) to S3 |
| `/api/rest/firmware/progress` | POST | Update firmware flash progress and stage |
| `/api/rest/diagnostics/report` | POST | Submit a system diagnostics snapshot |

### tRPC Routers

These are used by the browser frontend. All require authentication (`protectedProcedure`).

| Router | Procedure | Type | Purpose |
|--------|-----------|------|---------|
| `fcLogs` | `list` | Query | List FC logs for a drone |
| `fcLogs` | `get` | Query | Get a single FC log by ID |
| `fcLogs` | `requestScan` | Mutation | Create a `scan_fc_logs` job |
| `fcLogs` | `requestDownload` | Mutation | Create a `download_fc_log` job |
| `fcLogs` | `delete` | Mutation | Delete an FC log record |
| `firmware` | `list` | Query | List firmware updates for a drone |
| `firmware` | `get` | Query | Get a single firmware update |
| `firmware` | `upload` | Mutation | Upload firmware file (base64) to S3 |
| `firmware` | `requestFlash` | Mutation | Create a `flash_firmware` job |
| `diagnostics` | `latest` | Query | Get latest diagnostics snapshot |
| `diagnostics` | `history` | Query | Get diagnostics history for charts |

### WebSocket Events

All events use the `logs:<droneId>` Socket.IO room for scoping.

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `subscribe_logs` | Browser → Hub | `droneId` | Join the logs room |
| `unsubscribe_logs` | Browser → Hub | `droneId` | Leave the logs room |
| `fc_log_progress` | Hub → Browser | `{drone_id, logId, status, progress, ...}` | FC log download progress |
| `firmware_progress` | Hub → Browser | `{drone_id, updateId, status, flashStage, progress, ...}` | Firmware flash progress |
| `diagnostics` | Hub → Browser | `{drone_id, cpuPercent, memoryPercent, ...}` | Live diagnostics update |
| `log_stream_request` | Browser → Hub → Pi | `{droneId, service, action, lines}` | Start/stop remote log stream |
| `log_stream_line` | Pi → Hub | `{drone_id, service, lines[]}` | Buffered log lines from journalctl |
| `log_stream` | Hub → Browser | `{drone_id, service, lines[], timestamp}` | Relayed log lines for display |

---

## Companion Script (`logs_ota_service.py`)

The companion script is a single-file Python 3 asyncio application (~1200 lines) organized into six classes:

**`HubClient`** handles all REST and tRPC communication with the Hub server, including job polling, job acknowledgment/completion, FC log reporting, firmware progress reporting, and diagnostics submission.

**`MavFtpClient`** wraps the MAVSDK FTP plugin for file operations on the flight controller's SD card. It provides `list_directory()`, `download_file()`, `upload_file()`, `file_exists()`, and `remove_file()` methods. The connection string supports both serial (`serial:///dev/ttyAMA1:921600`) and Ethernet/UDP (`udp://:14540`) transports.

**`LogsOtaJobHandler`** implements the three job types: `handle_scan_fc_logs()` lists the FC log directory and reports results; `handle_download_fc_log()` downloads a log file to a temp file and uploads it to the Hub; `handle_flash_firmware()` downloads firmware from S3, uploads it to the FC as `ardupilot.abin`, and polls for the ArduPilot rename stage sequence.

**`DiagnosticsCollector`** gathers system health metrics using `psutil` (CPU, memory, disk, temperature, network) and checks the status of monitored systemd services via `systemctl is-active`.

**`RemoteLogStreamer`** manages `journalctl -f` subprocess streams. When the browser requests a log stream for a service, the streamer spawns the subprocess and reads lines in a buffered async loop, emitting batches via Socket.IO every 500ms.

**`LogsOtaService`** is the main orchestrator that initializes all components, connects to the FC (with retries), establishes a Socket.IO connection to the Hub, and runs two concurrent async loops: the job polling loop (every 5s) and the diagnostics reporting loop (every 10s).

### CLI Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--hub-url` | (required) | Quiver Hub URL |
| `--drone-id` | (required) | Drone identifier |
| `--api-key` | (required) | API key for authentication |
| `--fc-connection` | `serial:///dev/ttyAMA1:921600` | MAVSDK connection string |
| `--poll-interval` | `5` | Job polling interval (seconds) |
| `--diagnostics-interval` | `10` | Diagnostics reporting interval (seconds) |
| `--no-fc` | `false` | Run without FC (diagnostics + log streaming only) |
| `--debug` | `false` | Enable debug logging |

### Dependencies

```
pip install --break-system-packages mavsdk requests psutil python-socketio[asyncio_client] aiohttp
```

---

## Frontend UI (`LogsOtaApp.tsx`)

The frontend is a single React component (~950 lines) with four tabs, each implemented as a sub-component:

**FC Logs Tab** displays a table of discovered log files with columns for filename, remote path, file size, status, and actions. The "Scan FC Logs" button triggers a scan job. Each log row shows a download button (for `discovered` status), a progress bar (for `downloading`/`uploading`), or a download link (for `completed`). Real-time progress updates arrive via Socket.IO `fc_log_progress` events.

**OTA Updates Tab** shows a table of firmware uploads with status badges reflecting the flash pipeline stages. An "Upload Firmware" dialog accepts `.abin` or `.apj` files (max 50 MB) and includes a safety warning about the risks of OTA firmware updates. The "Flash to FC" button initiates the flash job. Progress is shown via a progress bar that updates in real-time through `firmware_progress` WebSocket events.

**Diagnostics Tab** presents four gauge cards (CPU, Memory, Disk, Temperature) with color-coded thresholds (green < 60%, yellow < 85%, red >= 85%). Below the gauges, a services status grid shows each monitored systemd service with an icon indicating active/inactive/failed state. A network interfaces table displays IP addresses and cumulative RX/TX bytes. Data refreshes every 10 seconds via both tRPC polling and WebSocket `diagnostics` events.

**Remote Logs Tab** provides a terminal-style log viewer. A dropdown selects the target service (`logs-ota`, `camera-stream`, `siyi-camera`, `quiver-hub-client`), and Start/Stop buttons control the stream. Log lines appear in a monospace, dark-background container with auto-scroll. A "Clear" button resets the buffer. Lines arrive via Socket.IO `log_stream` events.

---

## Deployment

### Installation on Raspberry Pi

The `install_logs_ota.sh` script automates the full setup:

```bash
chmod +x install_logs_ota.sh
sudo ./install_logs_ota.sh
```

The installer prompts for the Hub URL, drone ID, API key, and FC connection type (serial, UDP, or no-FC mode). It installs Python dependencies, copies the script, generates a systemd service file with the configured parameters, and enables/starts the service.

### Systemd Service

The service runs as `logs-ota.service` with `Restart=always` and `RestartSec=5`, ensuring automatic recovery from crashes. Logs are available via `journalctl -u logs-ota -f`. The `SyslogIdentifier=logs-ota` tag allows the Remote Logs tab in the browser to stream this service's own output.

### Useful Commands

```bash
sudo systemctl status logs-ota        # Check service status
sudo journalctl -u logs-ota -f        # View live logs
sudo systemctl restart logs-ota       # Restart service
sudo systemctl stop logs-ota          # Stop service
```

---

## File Inventory

| File | Location | Purpose |
|------|----------|---------|
| `logs_ota_service.py` | `companion_scripts/` | Companion Python script (runs on Pi) |
| `logs-ota.service` | `companion_scripts/` | Systemd unit file template |
| `install_logs_ota.sh` | `companion_scripts/` | Interactive install script |
| `LogsOtaApp.tsx` | `client/src/components/apps/` | Frontend React component |
| `logsOtaDb.ts` | `server/` | Database query helpers |
| `rest-api.ts` | `server/` | REST endpoints (fc-list, fc-progress, fc-upload, firmware/progress, diagnostics/report) |
| `websocket.ts` | `server/` | WebSocket broadcast functions |
| `routers.ts` | `server/` | tRPC routers (fcLogs, firmware, diagnostics) |
| `schema.ts` | `drizzle/` | Database table definitions |
| `logs-ota.test.ts` | `server/` | 82 vitest tests covering all components |
