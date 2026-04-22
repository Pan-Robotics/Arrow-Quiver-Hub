# Logs & OTA Updates Pipeline

**Quiver Hub — Companion Computer to Cloud**

This document describes the full architecture of the Logs & OTA Updates pipeline, covering the companion Python script that runs on the Raspberry Pi, the server-side endpoints and WebSocket handlers on Quiver Hub, the database schema, and the browser-based frontend UI. All components are designed to work together over the internet via Tailscale, with no requirement that the drone and the user's PC share a local network.

---

## Architecture Overview

The pipeline connects three layers: the **flight controller** (ArduPilot running on a Cube Orange or similar), the **companion computer** (Raspberry Pi 4/5 on the drone), and the **Quiver Hub** cloud server. The companion script bridges the FC and the Hub, while the browser connects directly to the Hub for real-time monitoring and control.

```
┌─────────────────────┐  HTTP (8080) + MAVFTP  ┌──────────────────────┐
│   Flight Controller  │◄──────────────────────►│   Raspberry Pi       │
│   (ArduPilot)        │   Serial or Ethernet    │   (Companion)        │
│                      │                          │                      │
│  • net_webserver.lua │  ◄── HTTP GET (primary)    │  logs_ota_service.py │
│    port 8080         │                          │  • FCLogSyncer       │
│    /mnt/APM/LOGS/    │                          │    (HTTP log sync)  │
│  • SD card logs      │  ◄── MAVFTP (fallback)    │  • MAVSDK/MAVFTP     │
│  • Firmware flash    │                          │  • Job polling       │
│  • ardupilot.abin    │                          │  • Diagnostics       │
└─────────────────────┘                          │  • Log streaming     │
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

The user clicks **Scan FC Logs** in the browser. This triggers a tRPC mutation that creates a `scan_fc_logs` job in the `droneJobs` queue. The companion script polls for pending jobs every 5 seconds, picks up the scan job, and uses a three-tier resolution strategy to list the FC's log files:

1. **Local cache** (instant) — If the `FCLogSyncer` has already synced the FC's `/APM/LOGS/` directory, the manifest is read from disk with no network access.
2. **HTTP via `net_webserver.lua`** (primary) — The companion issues `GET http://<fc_ip>:8080/mnt/APM/LOGS/` to the ArduPilot [`net_webserver.lua`](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.lua) applet running on the FC. This Lua scripting applet serves the SD card over HTTP on port 8080 (configurable via `WEB_BIND_PORT`). The companion parses the HTML directory listing to extract filenames, sizes, and timestamps.
3. **MAVFTP fallback** — If the FC web server is unreachable (`ConnectionError` / `Timeout`), the companion falls back to MAVSDK's FTP plugin to list the directory over MAVLink.

The discovered `.BIN` and `.log` files are reported back to the Hub via `POST /api/rest/logs/fc-list`, which upserts them into the `fcLogs` database table.

When the user clicks **Download** on a specific log, a `download_fc_log` job is created. The companion script uses the same three-tier strategy: it first checks the local cache, then attempts an HTTP download from the FC's `net_webserver.lua` (streaming the `.BIN` file via `GET /mnt/APM/LOGS/<filename>` and caching it locally for future access), and falls back to MAVFTP only if the web server is unreachable. It then uploads the file to the Hub. The companion first attempts a multipart upload via `POST /api/rest/logs/fc-upload-multipart` (no base64 overhead, approximately 33% faster), and falls back to the legacy base64 JSON endpoint `POST /api/rest/logs/fc-upload` if the multipart endpoint is unavailable. The Hub stores the file in S3 and updates the `fcLogs` record with the S3 URL. Throughout this process, progress is reported via `POST /api/rest/logs/fc-progress` and broadcast to the browser over WebSocket as `fc_log_progress` events.

Once a log reaches `completed` status, the user can save it directly to their local PC via the **Save to PC** button. This triggers a browser download through the server-side download proxy at `GET /api/rest/logs/fc-download/:logId`, which authenticates via session cookie, fetches the file from S3, and streams it to the browser with `Content-Disposition: attachment` for a native Save dialog. For logs still on the FC (status `discovered` or `failed`), the **Download from FC** button dispatches the companion job and automatically triggers the browser download once the upload completes.

| Step | Actor | Endpoint / Protocol | Direction |
|------|-------|---------------------|-----------|
| User clicks "Scan FC Logs" | Browser | `trpc.fcLogs.requestScan` | Browser → Hub |
| Hub creates job | Hub | `droneJobs` table | Internal |
| Pi polls for jobs | Pi | `trpc.droneJobs.getPendingJobs` | Pi → Hub |
| Pi reads local cache | Pi | Local manifest JSON | Internal |
| Pi lists FC logs (primary) | Pi | `GET http://<fc>:8080/mnt/APM/LOGS/` (net_webserver.lua) | Pi → FC |
| Pi lists FC logs (fallback) | Pi | MAVSDK FTP `list_directory` | Pi → FC |
| Pi reports discovered logs | Pi | `POST /api/rest/logs/fc-list` | Pi → Hub |
| Hub broadcasts to browser | Hub | WebSocket `fc_log_progress` | Hub → Browser |
| User clicks "Download" | Browser | `trpc.fcLogs.requestDownload` | Browser → Hub |
| Pi serves from local cache | Pi | Local file read | Internal |
| Pi downloads from FC (primary) | Pi | `GET http://<fc>:8080/mnt/APM/LOGS/<file>` (net_webserver.lua) | Pi ← FC |
| Pi downloads from FC (fallback) | Pi | MAVSDK FTP `download` | Pi ← FC |
| Pi uploads to Hub (multipart) | Pi | `POST /api/rest/logs/fc-upload-multipart` | Pi → Hub |
| Pi uploads to Hub (base64 fallback) | Pi | `POST /api/rest/logs/fc-upload` | Pi → Hub |
| Hub stores in S3 | Hub | `storagePut()` | Internal |
| User saves to PC | Browser | `GET /api/rest/logs/fc-download/:logId` | Hub → Browser |

### 2. OTA Firmware Flash

The user uploads a firmware file (`.abin` or `.apj`, max 50 MB) through the OTA Updates tab. The file is base64-encoded and sent to `trpc.firmware.upload`, which stores it in S3, **computes a SHA-256 hash** of the file content, and creates a `firmwareUpdates` record with status `uploaded` and the hash stored in the `sha256Hash` column. When the user clicks **Flash to FC**, a `flash_firmware` job is created containing the S3 URL and the `sha256Hash` in the job payload.

The companion script picks up the job, **acknowledges it with a mutex lock** (sending its companion identifier as `lockedBy` to prevent double-execution), downloads the firmware from S3, **verifies the SHA-256 hash** against the server-provided value (aborting with `hash_verification_failed` if there is a mismatch), and **extracts the git hash** from the `.abin` file header for post-flash verification. After the flash completes (success or failure), the **downloaded temp file is automatically cleaned up** in a `finally` block.

The flash uses **Approach C (FC HTTP Pull)** exclusively. The companion starts a temporary `aiohttp` HTTP server on port 8080 that serves the firmware file at `/firmware.abin`. The FC runs `firmware_puller.lua` (a Lua scripting applet enabled via `FWPULL_ENABLE=1`) which polls the companion's HTTP server, downloads the firmware to the SD card as `ardupilot.abin`, and signals completion. The companion monitors the pull via download request activity, with a 30-second early-exit if no FC pull activity is detected (indicating `firmware_puller.lua` is not installed or `FWPULL_ENABLE` is disabled).

| Step | What Happens | Progress |
|------|-------------|----------|
| **Step 1: Download** | Companion downloads `.abin` from Hub S3, verifies SHA-256, extracts git hash from header | 0–10% |
| **Step 2: Pre-upload cleanup** | HTTP check for existing `ardupilot*.abin` on FC (via `net_webserver.lua`) | 10–15% |
| **Step 3: Serve firmware** | Companion starts aiohttp server on port 8080, FC pulls firmware via `firmware_puller.lua` | 15–60% |
| **Step 4: MAVLink reboot** | Companion sends MAVLink reboot command to FC | 60–65% |
| **Step 5: Wait for FC** | Poll FC web server (`http://<fc>:8080`) for up to 120s until it comes back online | 65–90% |
| **Step 6: Version verify** | Reconnect MAVSDK, query `AUTOPILOT_VERSION`, compare `flight_custom_version` git hash against `.abin` header | 90–100% |

Each stage transition is reported via `POST /api/rest/firmware/progress` (which now accepts an optional `firmware_version` field) and broadcast to the browser as `firmware_progress` WebSocket events. The dashboard displays a green **ShieldCheck** badge for verified flashes (git hash match) or an amber **ShieldAlert** for mismatches. The entire process has a 5-minute timeout.

The OTA Updates tab also provides a **Cancel** button for stuck updates (status `transferring`, `flashing`, `verifying`, or `queued`) and a **Clear Failed & Stuck** bulk action that removes all failed and stuck records.

### Job Reliability

The job pipeline includes several reliability mechanisms managed by the Hub server:

| Mechanism | Description |
|-----------|-------------|
| **Mutex Lock** | Job acknowledgement uses an atomic compare-and-swap — only the first companion to acknowledge a pending job acquires the lock. The `lockedBy` column records the companion identifier (e.g., `logs_ota@raspberrypi`). |
| **Timeout Reaper** | A server-side interval (every 60s) checks for `in_progress` jobs that have exceeded their `timeoutSeconds` window. Stuck jobs are reset to `pending` with an incremented `retryCount`. |
| **Retry Counting** | Each job has `retryCount` / `maxRetries` (default 3). If retries are exhausted, the job is permanently marked as `failed`. |
| **Expiry** | Jobs can have an `expiresAt` timestamp. Pending jobs past their expiry are marked as `expired` by the reaper. |
| **Artefact Cleanup** | Downloaded firmware files are deleted in a `finally` block after flash completes or fails, preventing temp file accumulation on the Pi. |

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

The Remote Logs tab provides a live terminal view of journalctl output from any systemd service running on the companion computer. When the user selects a service (e.g., `telemetry-forwarder`, `logs-ota`, `camera-stream`, `siyi-camera`, `quiver-hub-client`) and clicks **Start Streaming**, the browser emits a `subscribe_logs` Socket.IO event followed by a `log_stream_request` event with `action: "start"`.

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
| `sha256Hash` | `varchar(128)` | SHA-256 hash of log file |
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
| `flashStage` | `varchar(64)` | Current flash stage (e.g., `downloading`, `serving`, `rebooting`, `waiting_for_fc`, `verifying_version`, `reboot_verified`) |
| `progress` | `int` | Flash progress (0–100) |
| `errorMessage` | `text` | Error details if failed |
| `initiatedBy` | `int` | User ID who uploaded |
| `createdAt` | `timestamp` | Upload time |
| `startedAt` | `timestamp` | Flash start time |
| `sha256Hash` | `varchar(128)` | SHA-256 hash of firmware file (computed at upload, verified before flash) |
| `firmwareVersion` | `varchar(128)` | Confirmed firmware version after flash (e.g., git hash from `AUTOPILOT_VERSION`) |
| `completedAt` | `timestamp` | Flash completion time |

**`droneJobs`** — The job queue table now includes reliability columns:

| Column | Type | Description |
|--------|------|-------------|
| `retryCount` | `int` (default 0) | Number of times this job has been retried |
| `maxRetries` | `int` (default 3) | Maximum retry attempts before permanent failure |
| `expiresAt` | `timestamp` (nullable) | Job expiry time — pending jobs past this time are marked expired |
| `lockedBy` | `varchar(128)` (nullable) | Companion identifier that holds the mutex lock |
| `lockedAt` | `timestamp` (nullable) | When the lock was acquired |
| `timeoutSeconds` | `int` (default varies) | Maximum execution time before the reaper resets the job |

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
| `/api/rest/logs/fc-upload-multipart` | POST | Upload downloaded FC log file (multipart/form-data, preferred) |
| `/api/rest/logs/fc-download/:logId` | GET | Download proxy — streams FC log from S3 to browser (session cookie auth) |
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
| `fcLogs` | `sendToAnalytics` | Mutation | Create a flightLogs record from a completed FC log (reuses S3 URL) |
| `firmware` | `list` | Query | List firmware updates for a drone |
| `firmware` | `get` | Query | Get a single firmware update |
| `firmware` | `upload` | Mutation | Upload firmware file (base64) to S3 |
| `firmware` | `requestFlash` | Mutation | Create a `flash_firmware` job |
| `firmware` | `delete` | Mutation | Delete a firmware update record |
| `firmware` | `clearFailed` | Mutation | Remove all failed and stuck firmware update records |
| `diagnostics` | `latest` | Query | Get latest diagnostics snapshot |
| `diagnostics` | `history` | Query | Get diagnostics history for charts |

### WebSocket Events

All events use the `logs:<droneId>` Socket.IO room for scoping.

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `subscribe_logs` | Browser → Hub | `droneId` | Join the logs room |
| `unsubscribe_logs` | Browser → Hub | `droneId` | Leave the logs room |
| `fc_log_progress` | Hub → Browser | `{drone_id, logId, status, progress, ...}` | FC log download progress |
| `firmware_progress` | Hub → Browser | `{drone_id, updateId, status, flashStage, progress, firmwareVersion?, ...}` | Firmware flash progress (includes confirmed version after verification) |
| `diagnostics` | Hub → Browser | `{drone_id, cpuPercent, memoryPercent, ...}` | Live diagnostics update |
| `log_stream_request` | Browser → Hub → Pi | `{droneId, service, action, lines}` | Start/stop remote log stream |
| `log_stream_line` | Pi → Hub | `{drone_id, service, lines[]}` | Buffered log lines from journalctl |
| `log_stream` | Hub → Browser | `{drone_id, service, lines[], timestamp}` | Relayed log lines for display |

---

## Companion Script (`logs_ota_service.py`)

The companion script is a single-file Python 3 asyncio application (~1900 lines) organized into seven classes:

**`HubClient`** handles all REST and tRPC communication with the Hub server, including job polling, job acknowledgment/completion, FC log reporting, firmware progress reporting, and diagnostics submission.

**`MavFtpClient`** wraps the MAVSDK FTP plugin for file operations on the flight controller's SD card. It provides `connect()`, `ensure_ready()` (health check + reconnect with settling delay), `list_directory()`, `download_file()`, `upload_file()`, `file_exists()`, and `remove_file()` methods. The connection string supports both serial (`serial:///dev/ttyAMA1:921600`) and Ethernet/UDP (`udp://:14540`) transports. The `ensure_ready()` method performs a `list_directory("/")` health check and, if it fails, reconnects with a 3-second settling delay between attempts (up to 3 retries). This is used after FC reboot to ensure the FTP plugin is initialized before querying `AUTOPILOT_VERSION`.

**`FCLogSyncer`** is a background syncer that downloads FC log files from the ArduPilot [`net_webserver.lua`](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.lua) applet over HTTP and stores them locally on the companion computer at `/var/lib/quiver/fc_logs/`. The `net_webserver.lua` script is a Lua scripting applet that runs inside ArduPilot on boards with networking support (e.g., Cube Orange with Ethernet). It serves the FC's SD card over HTTP on port 8080 (configurable via the `WEB_BIND_PORT` parameter), providing an HTML directory listing at `/mnt/APM/LOGS/` and direct file downloads at `/mnt/APM/LOGS/<filename>`. The syncer runs a 60-second background loop (only when the drone is **disarmed**, verified via MAVSDK telemetry) that parses the HTML directory listing, compares against a local JSON manifest, and downloads new or changed files using `If-Modified-Since` headers for incremental sync. This approach avoids blocking the MAVLink TCP connection (which MAVFTP does) and provides fast local access for the dashboard. The default FC web server URL is `http://192.168.144.10:8080`, configurable via the `--fc-webserver-url` CLI argument.

**`LogsOtaJobHandler`** implements the three job types using a three-tier resolution strategy for log operations (local cache → HTTP via `net_webserver.lua` → MAVFTP fallback): `handle_scan_fc_logs()` reads from the local manifest first, then issues an on-demand HTTP listing, falling back to MAVFTP; `handle_download_fc_log()` serves from the local cache first, then streams via HTTP (also caching locally), falling back to MAVFTP, and uploads to the Hub via multipart form-data (preferred, no base64 overhead) with automatic fallback to base64 JSON; `handle_flash_firmware()` downloads firmware from S3, **verifies the SHA-256 hash**, **extracts the git hash** from the `.abin` header, serves the firmware via a temporary `aiohttp` HTTP server for the FC to pull (Approach C), sends a MAVLink reboot command, waits for the FC web server to come back online, then **queries `AUTOPILOT_VERSION`** via MAVSDK to compare the `flight_custom_version` git hash against the expected value from the `.abin` header. The confirmed firmware version (or mismatch warning) is reported to the Hub. The **temp file is cleaned up** in a `finally` block.

**`DiagnosticsCollector`** gathers system health metrics using `psutil` (CPU, memory, disk, temperature, network) and checks the status of monitored systemd services (`telemetry-forwarder`, `logs-ota`, `camera-stream`, `siyi-camera`, `quiver-hub-client`, `go2rtc`, `tailscale-funnel`) via `systemctl is-active`.

**`RemoteLogStreamer`** manages `journalctl -f` subprocess streams. When the browser requests a log stream for a service, the streamer spawns the subprocess and reads lines in a buffered async loop, emitting batches via Socket.IO every 500ms.

**`LogsOtaService`** is the main orchestrator that initializes all components, connects to the FC (with retries), establishes a Socket.IO connection to the Hub, and runs three concurrent async loops: the job polling loop (every 5s), the diagnostics reporting loop (every 10s), and the FC log background sync loop (every 60s, via `FCLogSyncer`).

### CLI Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--hub-url` | (required) | Quiver Hub URL |
| `--drone-id` | (required) | Drone identifier |
| `--api-key` | (required) | API key for authentication |
| `--fc-connection` | `serial:///dev/ttyAMA1:921600` | MAVSDK connection string |
| `--fc-webserver-url` | `http://192.168.144.10:8080` | ArduPilot `net_webserver.lua` URL for HTTP log access |
| `--log-store-dir` | `/var/lib/quiver/fc_logs/` | Local directory for cached FC log files |
| `--poll-interval` | `5` | Job polling interval (seconds) |
| `--diagnostics-interval` | `10` | Diagnostics reporting interval (seconds) |
| `--no-fc` | `false` | Run without FC (diagnostics + log streaming only) |
| `--allow-non-root` | `false` | Suppress non-root warning (some features may not work) |
| `--debug` | `false` | Enable debug logging |

### Dependencies

```
pip install --break-system-packages mavsdk requests psutil python-socketio[asyncio_client] aiohttp
```

---

## Frontend UI (`LogsOtaApp.tsx`)

The frontend is a single React component (~950 lines) with four tabs, each implemented as a sub-component:

**FC Logs Tab** displays a table of discovered log files with columns for filename, remote path, file size, status, and actions. The "Scan FC Logs" button triggers a scan job. Each log row shows contextual action buttons depending on status: for `discovered` or `failed` logs, a **Download from FC** button dispatches the companion download job and automatically triggers a browser save-to-PC download when the upload completes; for `downloading`/`uploading` logs, a spinner with progress indication; for `completed` logs, a blue **Save to PC** button that streams the file from S3 through the server-side download proxy (`GET /api/rest/logs/fc-download/:logId`) with `Content-Disposition: attachment` for a native browser Save dialog, plus a **Send to Flight Analytics** button. The Send to Flight Analytics button checks whether the Flight Analytics app is installed — if not, a toast prompts the user to install it from the App Store first. If installed, it creates a `flightLogs` record reusing the same S3 URL (zero re-upload), so the log appears immediately in Flight Analytics for parsing. Real-time progress updates arrive via Socket.IO `fc_log_progress` events.

**OTA Updates Tab** shows a table of firmware uploads with status badges reflecting the flash pipeline stages. An "Upload Firmware" dialog accepts `.abin` or `.apj` files (max 50 MB) and includes a safety warning about the risks of OTA firmware updates. The "Flash to FC" button initiates the flash job. Progress is shown via a progress bar that updates in real-time through `firmware_progress` WebSocket events.

**Diagnostics Tab** presents four gauge cards (CPU, Memory, Disk, Temperature) with color-coded thresholds (green < 60%, yellow < 85%, red >= 85%). Below the gauges, a services status grid shows each monitored systemd service with an icon indicating active/inactive/failed state. A network interfaces table displays IP addresses and cumulative RX/TX bytes. Data refreshes every 10 seconds via both tRPC polling and WebSocket `diagnostics` events.

**Remote Logs Tab** provides a terminal-style log viewer. A dropdown selects the target service (`telemetry-forwarder`, `logs-ota`, `camera-stream`, `siyi-camera`, `quiver-hub-client`), and Start/Stop buttons control the stream. Log lines appear in a monospace, dark-background container with auto-scroll. A "Clear" button resets the buffer. Lines arrive via Socket.IO `log_stream` events.

---

## Deployment

### Installation on Raspberry Pi

The `install_logs_ota.sh` script automates the full setup:

```bash
chmod +x install_logs_ota.sh
sudo ./install_logs_ota.sh
```

The installer prompts for the Hub URL, drone ID, API key, FC connection type (serial, UDP, or no-FC mode), and permission level (run as root for full functionality, or as service user with group membership). It installs Python dependencies, copies the script, generates a systemd service file with security hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`), and enables/starts the service.

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
| `telemetry_forwarder.py` | `companion_scripts/` | MAVLink + UAVCAN telemetry forwarder (runs on Pi) |
| `telemetry-forwarder.service` | `companion_scripts/` | Systemd unit file for telemetry forwarder |
| `install_telemetry_forwarder.sh` | `companion_scripts/` | Interactive install script for telemetry forwarder |
| `logs-ota.test.ts` | `server/` | 107 vitest tests covering all components |
