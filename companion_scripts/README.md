# Quiver Hub Companion Suite

This folder contains the Raspberry Pi companion services for Quiver Hub: Hub jobs, telemetry, Logs & OTA, the SIYI gimbal controller, and WebRTC camera streaming.

All installers use **one shared configuration file**: `INSTALL_DIR/.env`. The first installer asks for the service user and installation folder. Later installers must be run from the same downloaded folder and select the same answers so every service reads the same `.env`.

> The installers do **not** install DHCP, modify an interface, or change any host network configuration. Assign the documented reserved addresses through your normal network/image provisioning process before installing services.

## Install sequence

### 1. Install the Hub client

The Hub client bootstrap installer downloads the complete `companion_scripts` suite. Normally run it without `sudo`; it requests elevation for package/service setup. Running with `sudo` is also supported, and the real service account is still selected at the prompt:

```bash
bash install_hub_client.sh
```

When prompted, it uses this source by default:

```text
https://github.com/Pan-Robotics/Arrow-Quiver-Hub/tree/main/companion_scripts
```

Press Enter to use the default, or supply another complete-suite source when a controlled release/artifact is required. Record the downloaded folder chosen by the installer.

If you have already received a complete local suite bundle (for example, before the default GitHub folder has been updated), bootstrap from that delivered folder instead:

```bash
bash install_hub_client.sh --local
```

`--local` avoids the GitHub suite download only. The installer may still require network access for operating-system and Python packages.

### 2. Install the other services as root

Run each desired installer from the downloaded suite, selecting the same service user and installation folder. For example:

```bash
sudo bash /chosen/folder/install_telemetry_forwarder.sh
sudo bash /chosen/folder/install_camera_services.sh
sudo bash /chosen/folder/install_logs_ota.sh
```

Install only the services needed on a particular companion. A typical order is Hub client, telemetry, camera, then Logs & OTA.

## Shared configuration

The canonical configuration is:

```text
INSTALL_DIR/.env
```

`INSTALL_DIR` is selected during the first installer run; it is not hard-coded to a particular login name. The common installer resolves the selected account's home directory with the system account database and stores these installation facts in the shared file:

```dotenv
INSTALL_DIR=/absolute/chosen/path
SERVICE_USER=chosen-user
SERVICE_GROUP=chosen-group
```

The common installer can migrate a legacy adjacent `forwarder.env` to `.env` **only when `.env` does not already exist**. It retains the original file and does not overwrite existing `.env` secrets. The file is treated as data—installers do not `source` or `eval` its contents.

Important shared settings include:

```dotenv
HUB_URL=https://hub.example
WEB_SERVER_URL=https://hub.example
DRONE_ID=quiver_001
API_KEY=replace-with-the-drone-api-key

COMPANION_IP=192.168.144.49
FC_IP=192.168.144.51
SIYI_CAMERA_IP=192.168.144.25
NETWORK_SUBNET=192.168.144.0/24

GO2RTC_API_HOST=127.0.0.1
GO2RTC_API_PORT=1984
GO2RTC_WEBRTC_PORT=8555
TAILSCALE_FUNNEL_PORT=443
FIRMWARE_SERVER_PORT=8070
FC_WEBSERVER_PORT=8080
```

Use the supplied `companion-config.example` as the complete key/default reference after the initial installer places it in `INSTALL_DIR`. Keep `API_KEY` private; the actual `.env` is permission-restricted.

### Precedence and changes

1. Installer controls `QUIVER_ENV_FILE` and `QUIVER_INSTALL_DIR`, when supplied, choose the configuration-file location and initial installation-directory default before prompts.
2. Values already in `.env` are shown as prompt defaults. A blank prompt keeps the existing resolved value.
3. Production systemd units read their values from the shared `.env` at each start. They do not contain Hub URLs, API keys, camera URLs, or a developer-specific home directory.
4. When manually invoking a runtime program, an explicit CLI option takes precedence over that program's environment/default value. Use `.env` rather than adding credentials to a systemd `ExecStart` line.

After editing `.env`, restart only the affected services so systemd reloads its `EnvironmentFile`:

```bash
sudo systemctl restart quiver-hub-client
sudo systemctl restart telemetry-forwarder
sudo systemctl restart logs-ota
sudo systemctl restart go2rtc tailscale-funnel camera-stream siyi-camera
```

The `go2rtc` service regenerates `go2rtc.yaml` from `.env` before it starts. Therefore an RTSP host, RTSP port, stream type, or go2rtc-port update takes effect after `sudo systemctl restart go2rtc` (and restart `tailscale-funnel`/`camera-stream` when their endpoint settings changed).

`RTSP_URL` is an optional explicit source override. Leave it absent/commented to derive the source from `SIYI_CAMERA_IP`, `SIYI_RTSP_PORT`, and `STREAM_TYPE`; if an old explicit `RTSP_URL` prevents a camera-address change taking effect, remove that override and restart `go2rtc`.

## Reserved companion network plan

Use the following static reservations on the dedicated payload LAN. They are design-time values; the installers do not configure them for you.

| Role | Address / range | Notes |
|---|---:|---|
| Payload LAN | `192.168.144.0/24` | `/24` subnet |
| Siyi air unit | `192.168.144.11` | `SIYI_AIR_IP` |
| Siyi ground unit | `192.168.144.12` | `SIYI_GROUND_IP` |
| Android GCS | `192.168.144.20` | `ANDROID_GCS_IP` (Siyi reserved) |
| Companion Pi | `192.168.144.49` | `COMPANION_IP` |
| Flight controller | `192.168.144.51` | `FC_IP` |
| CubeNode | `192.168.144.50` | `CUBENODE_IP` |
| SIYI camera | `192.168.144.25` | `SIYI_CAMERA_IP` |
| Siyi camera reserved | `192.168.144.60` | `SIYI_CAMERA_RESERVED_IP` |
| Developer payload range | `192.168.144.100`–`192.168.144.199` | `PAYLOAD_IP_START` / `PAYLOAD_IP_END` |
| Bottom J31 | `192.168.144.100` | `PAYLOAD_BOTTOM_IP` |
| Side 1 J29 | `192.168.144.101` | `PAYLOAD_SIDE1_IP` |
| Side 2 J30 | `192.168.144.102` | `PAYLOAD_SIDE2_IP` |

Do not reuse any reserved equipment address for a payload. No DHCP runs on the Pi because of Siyi firmware conflicts; this network policy is not an action the install scripts perform.

### Service ports

| Function | Port | Transport / endpoint |
|---|---:|---|
| SIYI gimbal SDK | `37260` | UDP to `SIYI_CAMERA_IP` |
| SIYI RTSP | `8554` | RTSP to `SIYI_CAMERA_IP` |
| go2rtc API / Web UI | `1984` | HTTP on `GO2RTC_API_HOST` |
| go2rtc WebRTC media | `8555` | UDP |
| Tailscale Funnel signaling | `443` by default | HTTPS; alternatives supported by the runtime are `8443` and `10000` |
| MAVLink telemetry default | `14540` | UDP input, configurable |
| Firmware server | `8070` | HTTP from FC to `COMPANION_IP` |
| FC web server | `8080` | HTTP at `FC_IP` |

## Service operations

```bash
# Status
sudo systemctl status quiver-hub-client telemetry-forwarder logs-ota \
  go2rtc tailscale-funnel camera-stream siyi-camera

# Logs
sudo journalctl -u telemetry-forwarder -f
sudo journalctl -u camera-stream -f
sudo journalctl -u logs-ota -f

# Validate a rendered unit
sudo systemd-analyze verify /etc/systemd/system/camera-stream.service
```

### Repair “bad unit file setting” from an earlier installer

The earlier portable installers wrapped `WorkingDirectory` and `EnvironmentFile` in double quotes. Both directives take one literal path, not a word list: directory quotes cause a fatal non-absolute-path error, while configuration-file quotes can make systemd ignore the file. This affects paths with and without spaces. Corrected installers emit unquoted, validated single paths for these directives and retain word quoting for `ExecStart`, `Environment`, and `ReadWritePaths`.

Use the corrected suite's standalone repair script on an existing installation:

```bash
# Optional read-only validation of the proposed corrected units
sudo bash /path/to/corrected-suite/repair_companion_services.sh --check

# Back up and repair installed companion units; reload definitions only
sudo bash /path/to/corrected-suite/repair_companion_services.sh

# Start only the Hub client when you are ready
sudo systemctl reset-failed quiver-hub-client
sudo systemctl enable --now quiver-hub-client
sudo systemctl status quiver-hub-client --no-pager -l
```

The script validates corrected installed units and drop-ins with `systemd-analyze verify --recursive-errors=one` **before** replacing any file. It retains `.service.pre-working-directory-fix` backups, repairs both quoted directives, skips unrelated generic go2rtc/Funnel units, and retries reload on rerun. It never edits `.env`, downloads packages, changes enablement, or starts/restarts a service. If validation finds another error, no units are replaced. The screenshots alone do not identify your installed rejected directive.

For an exact, credential-redacted diagnostic report (no service changes):

```bash
bash /path/to/corrected-suite/diagnose_companion.sh --install-dir /your/installed/quiver
```

The output includes installed source hashes/manifest, unit paths/directories, exact parser errors, and read-only service states. Do not paste your `.env` or API key into support messages.

### Dependency and safety changes in the audited suite

All Python installs use `--break-system-packages -r requirements-companion.txt`. MAVSDK is pinned to **3.17.4** because native MAVSDK v4 has a different API; installers run the actual `System()`/FTP import preflight before unit enablement. Units are staged, parsed, and backed up before replacement. Generated source code is installer-owned; operational data stays in dedicated writable directories. A downloaded suite includes a commit/hash manifest; the diagnostic script distinguishes stale or locally modified source.

New installations default `ENABLE_UAVCAN=false`, with an explicitly configured unique `UAVCAN_NODE_ID` for opt-in active CAN participation. Remote file/config jobs default `ALLOW_REMOTE_FILE_WRITES=false`; opt-in writes are bounded, atomic, and confined to data roots, never service code or `.env`. Existing `.env` values are preserved, so review these flags manually when upgrading. HTTPS is required unless an explicitly allowed loopback-only development mode is used.

Do not treat parser/import/stub tests as flight clearance. Camera protocol/control-byte behavior, CAN privileges/traffic, and firmware staging/promotion must be verified on a non-operational bench. Server-side Socket.IO/job authorization and per-transfer cryptographic capability remain separate unresolved audit items; do not expose control endpoints to an untrusted network.

The installed definitions are under `/etc/systemd/system/`. Editing a `.service` file in your companion source/install folder alone does not change the definition systemd uses. Do not copy an unrendered source template directly into `/etc/systemd/system/`.

## Camera services

`install_camera_services.sh` installs the camera runtime, a local `go2rtc` binary under the selected `INSTALL_DIR`, and these services:

- `go2rtc.service` — RTSP ingest and WebRTC server; its config is generated from `.env` before startup.
- `tailscale-funnel.service` — exposes go2rtc signaling with runtime values from `.env`.
- `siyi-camera.service` — SIYI gimbal control bridge.
- `camera-stream.service` — stream health and Hub registration.

The installer sets `GO2RTC_EXTERNAL=true` and `SKIP_FUNNEL_SETUP=true`: the camera manager monitors the existing systemd-managed go2rtc instance rather than launching a duplicate listener or reconfiguring the Funnel. Standalone use can leave these options false.

Install Tailscale from its official signed OS repository first, then authenticate with `sudo tailscale up`. The camera installer requires that prerequisite and does not pipe a mutable remote installer into a root shell; Tailscale credentials are never stored in `.env`.

## Firmware puller: Pi configuration is not readable by FC Lua

**Current safety blocker:** firmware promotion is disabled (`RENAME_SUPPORTED=false`) because no atomic rename API was established in the inspected ArduPilot Lua sandbox. Do not enable OTA on an aircraft; see [Audited Upgrade Notes](AUDITED_UPGRADE_NOTES.md). Parameter generation remains available for a qualified non-operational bench implementation.

The flight controller cannot read the Pi's `.env`. The Hub-client bootstrap or Logs & OTA installer generates `INSTALL_DIR/firmware_puller.param` from `COMPANION_IP` and `FIRMWARE_SERVER_PORT`; import the file through your GCS only as part of that controlled FC setup. `FWPULL_ENABLE=1` alone does not bypass the blocked promotion gate.

The generated file sets `FWPULL_PI_IP0` through `FWPULL_PI_IP3` to the four octets of `COMPANION_IP` (`192`, `168`, `144`, `49` for the reserved plan) and `FWPULL_PORT` to `FIRMWARE_SERVER_PORT` (`8070` by default). If either `.env` setting changes, regenerate the file before importing it again:

```bash
python3 /chosen/folder/companion_config.py render-fc-params \
  /absolute/path/.env /absolute/path/firmware_puller.param
```

This is an explicit FC parameter import, not a Lua read of the Pi configuration file. See [OTA_Setup_Guide.md](OTA_Setup_Guide.md) for the complete firmware workflow.
