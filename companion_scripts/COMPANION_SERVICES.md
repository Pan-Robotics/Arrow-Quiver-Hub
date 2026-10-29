# Quiver Hub Companion Services Reference

This reference describes the Raspberry Pi companion suite and its portable, shared configuration model. It applies to any selected service account and installation folder; no service assumes a particular developer username or home directory.

For first-time setup and the network reservation table, start with [README.md](README.md).

## Service inventory

| Service | Runtime | Unit | Installer | Purpose |
|---|---|---|---|---|
| Hub Client | `raspberry_pi_client.py` | `quiver-hub-client.service` | `install_hub_client.sh` | Polls Hub jobs and performs approved companion actions |
| Telemetry Forwarder | `telemetry_forwarder.py` | `telemetry-forwarder.service` | `install_telemetry_forwarder.sh` | Sends MAVLink/UAVCAN telemetry to the Hub |
| Logs & OTA | `logs_ota_service.py` | `logs-ota.service` | `install_logs_ota.sh` | FC logs, firmware jobs, diagnostics, and remote journal streaming |
| Camera Stream | `camera_stream_service.py` | `camera-stream.service` | `install_camera_services.sh` | Stream registration and health monitoring |
| SIYI Controller | `siyi_camera_controller.py` | `siyi-camera.service` | `install_camera_services.sh` | SIYI gimbal command bridge |
| go2rtc | `bin/go2rtc` | `go2rtc.service` | `install_camera_services.sh` | RTSP ingest and WebRTC signaling/media |
| Tailscale Funnel | `tailscale` | `tailscale-funnel.service` | `install_camera_services.sh` | Public HTTPS signaling path for go2rtc |

All units log to journald and are configured to restart after a failure. The template units are rendered by the installers: they visibly contain `INSTALL_DIR_PLACEHOLDER`, `SERVICE_USER_PLACEHOLDER`, `SERVICE_GROUP_PLACEHOLDER`, and `ENV_FILE_PLACEHOLDER` before rendering. Do not copy a template straight into `/etc/systemd/system`.

## Installation model

1. As the intended non-root companion user, run `bash install_hub_client.sh`. It downloads the complete companion suite from the default source `https://github.com/Pan-Robotics/Arrow-Quiver-Hub/tree/main/companion_scripts`; press Enter for that default or provide an approved override.
2. Note the chosen downloaded folder and run other installers from it with `sudo bash /chosen/folder/install_…sh`.
3. At the prompts, use the same service user and installation folder for every installer.
4. The shared installer creates or reuses `INSTALL_DIR/.env`, copies helpers safely even if invoked from an already installed suite, and preserves existing configuration/secrets.

The selected service user's home is resolved from the system account database. A leading `~/` in the install-dir prompt is expanded for that selected user rather than the invoking root account.

### Legacy migration

If the canonical `.env` does not exist, the common installer can import an adjacent legacy `forwarder.env` while retaining its original file. It never overwrites an existing `.env`, never evaluates its contents as shell code, and applies restrictive ownership/mode after a change.

## One shared `.env`

The single shared file holds Hub credentials and all network values. It is not copied into units as literal values.

```dotenv
# Identity and Hub
HUB_URL=https://hub.example
WEB_SERVER_URL=https://hub.example
DRONE_ID=quiver_001
API_KEY=replace-this-secret

# Reserved payload LAN
COMPANION_IP=192.168.144.49
FC_IP=192.168.144.51
SIYI_CAMERA_IP=192.168.144.25
NETWORK_SUBNET=192.168.144.0/24

# Service endpoints
SIYI_SDK_PORT=37260
SIYI_RTSP_PORT=8554
GO2RTC_API_HOST=127.0.0.1
GO2RTC_API_PORT=1984
GO2RTC_WEBRTC_PORT=8555
TAILSCALE_FUNNEL_PORT=443
FIRMWARE_SERVER_PORT=8070
FC_WEBSERVER_PORT=8080
```

The payload LAN reserves `.100` through `.199` for other payload equipment; allocate `.100`, `.101`, and `.102` first when appropriate. The installers do **not** configure an interface, install DHCP, or change host network addressing.

### Resolution and precedence

- `QUIVER_ENV_FILE=/absolute/path` selects a canonical configuration file. `QUIVER_INSTALL_DIR=/absolute/path` supplies the initial install-directory default.
- Existing `.env` values are prompt defaults; a blank response retains the current value.
- Units load `EnvironmentFile` from the resolved shared `.env` each time they start. Edit `.env`, then restart the affected units.
- An explicit command-line option used for a manual runtime invocation takes precedence over that program's environment/default. Production unit files deliberately do not pin credentials or LAN URLs as CLI arguments.

Use the configuration helper through the installer functions, not shell parsing:

```bash
# Read a resolved setting from the actual shared file
python3 /chosen/folder/companion_config.py get /absolute/path/.env HUB_URL

# Safely change settings (the installer wrapper also restores owner/mode)
python3 /chosen/folder/companion_config.py set /absolute/path/.env GO2RTC_API_PORT 1984
```

## Camera service details

### Pipeline

```text
SIYI RTSP -> go2rtc -> WebRTC browser media
                    -> Tailscale Funnel HTTPS signaling
```

`go2rtc.service` runs before the camera stream manager. Its `ExecStartPre` invokes the configuration renderer, which recreates `INSTALL_DIR/go2rtc.yaml` using the current `RTSP_URL`, camera endpoint, and go2rtc port values from the shared `.env`. To change an endpoint, update `.env` and restart the service instead of manually editing the generated YAML:

```bash
sudo systemctl restart go2rtc tailscale-funnel camera-stream
```

`RTSP_URL` is optional. When it is absent/commented, the renderer derives it from `SIYI_CAMERA_IP`, `SIYI_RTSP_PORT`, and `STREAM_TYPE`. A non-empty `RTSP_URL` is intentionally an override; remove it from `.env` if the source should follow a changed camera address, RTSP port, or stream type.

`tailscale-funnel.service` gets its HTTPS funnel port and local go2rtc API host/port from `EnvironmentFile`, so an endpoint edit is picked up on service restart. The camera and SIYI units likewise receive `QUIVER_ENV_FILE` plus the shared environment and do not contain a URL, API key, RTSP URL, or fixed home path.

The installer sets `GO2RTC_EXTERNAL=true` and `SKIP_FUNNEL_SETUP=true`; the camera manager monitors the separately managed go2rtc instance without creating a duplicate listener or changing the persistent Funnel.

### Tailscale

The camera installer keeps the existing behavior: if Tailscale is absent it invokes the vendor installer; if the device is not authenticated it guides an operator through `tailscale up`. This action is performed only on the actual companion host, never as part of a test or documentation example. The Funnel unit persists the configured publishing action over reboots.

## Telemetry and Hub client

The Hub client requires `HUB_URL`, `DRONE_ID`, and `API_KEY`. The telemetry forwarder additionally reads its MAVLink/CAN settings from the shared service environment. Common values include:

```dotenv
MAVLINK_URL=udpin://0.0.0.0:14540
CAN_INTERFACE=can0
UPDATE_RATE_HZ=10
POLL_INTERVAL=5
```

After a change:

```bash
sudo systemctl restart quiver-hub-client telemetry-forwarder
```

## Logs & OTA

The Logs & OTA service uses the same Hub identity and has separate FC/log settings, for example:

```dotenv
FC_CONNECTION=serial:///dev/ttyAMA1:921600
FC_WEBSERVER_PORT=8080
# FC_WEBSERVER_URL=http://192.168.144.51:8080  # Optional whole-URL override
LOG_STORE_DIR=/var/lib/quiver/fc_logs
POLL_INTERVAL=5
DIAGNOSTICS_INTERVAL=10
FIRMWARE_SERVER_PORT=8070
```

For full firmware puller setup, including the FC-side parameters that must match the Pi configuration, see [OTA_Setup_Guide.md](OTA_Setup_Guide.md). The FC Lua script cannot read the companion's `.env`.

## Operations

```bash
# Service state
sudo systemctl status quiver-hub-client telemetry-forwarder logs-ota \
  go2rtc tailscale-funnel camera-stream siyi-camera

# Follow a service log
sudo journalctl -u logs-ota -f

# Restart after a shared .env change
sudo systemctl restart telemetry-forwarder

# Inspect the effective shared configuration with safe helper commands
python3 /chosen/folder/companion_config.py get /absolute/path/.env DRONE_ID
```

## Troubleshooting

### A unit does not start

```bash
sudo systemctl status camera-stream --no-pager
sudo journalctl -u camera-stream -n 100 --no-pager
sudo systemd-analyze verify /etc/systemd/system/camera-stream.service
```

Confirm the rendered unit points to the intended `.env`, that its selected service user exists, and that the Python/runtime files exist in `INSTALL_DIR`.

### No camera video

```bash
sudo systemctl status go2rtc tailscale-funnel camera-stream
curl http://127.0.0.1:1984/api/streams
sudo journalctl -u go2rtc -n 100 --no-pager
```

Check `SIYI_CAMERA_IP`, `SIYI_RTSP_PORT`, `STREAM_TYPE`, `RTSP_URL` (only if intentionally overridden), `GO2RTC_API_PORT`, and `GO2RTC_WEBRTC_PORT` in the shared `.env`; then restart `go2rtc`, Funnel, and camera-stream. Do not edit the generated `go2rtc.yaml` directly.

### FC firmware pull cannot connect

Ensure the companion and FC static addresses are the reserved plan (`.49` and `.51`) or your approved equivalents. The Hub-client bootstrap or Logs & OTA installer generates `INSTALL_DIR/firmware_puller.param` from `COMPANION_IP` and `FIRMWARE_SERVER_PORT`; import that file through the GCS into the FC (including after upgrading an existing FC configuration), then manually set/verify `FWPULL_ENABLE=1`. The generated values use `FWPULL_PI_IP0` … `FWPULL_PI_IP3` and `FWPULL_PORT`.

After changing either source setting in `.env`, regenerate and re-import the parameter file:

```bash
python3 /chosen/folder/companion_config.py render-fc-params \
  /absolute/path/.env /absolute/path/firmware_puller.param
```

If a firewall is in use, allow the FC address to reach the companion firmware server port. See the OTA guide for examples.

## Security practices

- Keep `.env` mode-restricted and never commit a real API key.
- Use HTTPS for Hub communication.
- Unit templates avoid credentials, URLs, and fixed developer paths.
- Generated services use the shared `EnvironmentFile` at runtime, so operational changes do not require credential-bearing unit edits.
- Rotate Hub API keys from the Hub's API-key management workflow.
