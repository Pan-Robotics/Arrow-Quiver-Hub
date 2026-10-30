# Quiver OTA Firmware Update — Setup Guide

> **2026-10-30 safety gate:** the audited Lua scripts currently disable firmware promotion (`RENAME_SUPPORTED=false`). The current ArduPilot sandbox source does not establish an atomic rename API. Do not enable this flow on an aircraft until a target-specific staged-promotion implementation passes a non-operational bench test. The architecture below describes the intended flow, not a verified working transfer in this revision. See [Audited Upgrade Notes](AUDITED_UPGRADE_NOTES.md).

This guide configures firmware delivery from Quiver Hub through a Raspberry Pi companion to an ArduPilot flight controller. It uses the companion suite's portable shared `.env` and FC-side ArduPilot parameters; the FC cannot read files from the Pi.

## Architecture

```text
Quiver Hub -- HTTPS --> companion downloads firmware
                         companion HTTP server (:8070 by default)
Flight controller -- HTTP GET --> firmware_puller.lua pulls firmware
                         stages an inert .part file; promotion currently blocked
companion -- MAVLink --> request reboot
flight controller bootloader flashes firmware
```

The Logs & OTA service also provides FC-log synchronization, diagnostics, and remote journal streaming.

## Install the companion service

First install the Hub-client bootstrap as the chosen non-root account:

```bash
bash install_hub_client.sh
```

It downloads the complete companion suite from the default source:

```text
https://github.com/Pan-Robotics/Arrow-Quiver-Hub/tree/main/companion_scripts
```

Press Enter to accept that source or enter an approved override. Then install Logs & OTA from the downloaded folder, selecting the same service user and installation directory used by the other companion services:

```bash
sudo bash /chosen/folder/install_logs_ota.sh
```

The installer uses the shared `INSTALL_DIR/.env`; it should not create a separate credential file. It may migrate legacy `forwarder.env` only when canonical `.env` does not exist, and it does not overwrite existing API credentials.

### Shared configuration

The Pi configuration includes:

```dotenv
COMPANION_IP=192.168.144.49
FC_IP=192.168.144.51
NETWORK_SUBNET=192.168.144.0/24

HUB_URL=https://hub.example
DRONE_ID=quiver_001
API_KEY=replace-this-secret

FIRMWARE_SERVER_PORT=8070
FC_WEBSERVER_PORT=8080
# FC_WEBSERVER_URL=http://192.168.144.51:8080  # Optional whole-URL override
FC_CONNECTION=serial:///dev/ttyAMA1:921600
```

Use your provisioned static addresses if they differ, but keep the Pi configuration and FC parameters synchronized. The companion installers do **not** set DHCP, configure an interface, or change host network addressing. On the standard payload LAN, reserve `192.168.144.0/24`, the companion at `.49`, the FC at `.51`, SIYI at `.25`, and `.100`–`.199` for additional payload devices (start allocations at `.100`, `.101`, `.102`).

After modifying the file, restart the service:

```bash
sudo systemctl restart logs-ota
```

## Flight-controller configuration

Copy `firmware_puller.lua` to the flight controller SD card under `APM/scripts/`. The Hub-client bootstrap or Logs & OTA installer generates `INSTALL_DIR/firmware_puller.param` from the shared `.env`; import that file through your GCS into the FC, including after upgrading an installation with existing saved FC parameters. The parameters are consumed by the firmware puller script; they are not environment variables.

### Enable Lua scripting

| Parameter | Value | Notes |
|---|---:|---|
| `SCR_ENABLE` | `1` | Enables Lua scripting; reboot after changing it. |
| `SCR_HEAP_SIZE` | `204800` | 200 KB heap for the Lua VM; adjust if several scripts need more memory. |

### Firmware puller parameters

| Parameter | Standard reservation | Meaning |
|---|---:|---|
| `FWPULL_ENABLE` | `1` | Enables firmware polling. |
| `FWPULL_PI_IP0` | `192` | First octet of `COMPANION_IP`. |
| `FWPULL_PI_IP1` | `168` | Second octet of `COMPANION_IP`. |
| `FWPULL_PI_IP2` | `144` | Third octet of `COMPANION_IP`. |
| `FWPULL_PI_IP3` | `49` | Fourth octet of `COMPANION_IP`. |
| `FWPULL_PORT` | `8070` | Must match `FIRMWARE_SERVER_PORT` in the Pi `.env`. |

> `firmware_puller.lua` runs on the flight controller. It cannot load the Pi's `.env`. Import the generated `firmware_puller.param`, then manually set/verify `FWPULL_ENABLE=1`. If `COMPANION_IP` or `FIRMWARE_SERVER_PORT` changes, regenerate and import the file again:
>
> ```bash
> python3 /chosen/folder/companion_config.py render-fc-params \
>   /absolute/path/.env /absolute/path/firmware_puller.param
> ```

### FC web server

Logs & OTA uses the FC HTTP server for log synchronization and verification. Configure the appropriate web-server/Lua settings for your ArduPilot firmware, typically including:

| Parameter | Value | Notes |
|---|---:|---|
| `NET_ENABLE` | `1` | Enables FC networking. |
| `WEB_ENABLE` | `1` | Enables the installed HTTP web server. |
| `WEB_BIND_PORT` | `8080` | Matches `FC_WEBSERVER_PORT` in the companion configuration. |

Confirm the FC web server address agrees with `FC_IP` and `FC_WEBSERVER_PORT` in `.env`.

## Firewall and network checks

If UFW or another firewall is enabled on the companion, allow the FC to reach the firmware server. With the standard reservations:

```bash
cd /your/chosen/install-folder
FC_IP=$(python3 companion_config.py get .env FC_IP)
FW_PORT=$(python3 companion_config.py get .env FIRMWARE_SERVER_PORT)
sudo ufw allow from "$FC_IP" to any port "$FW_PORT" proto tcp
```

Adapt both address and port to `FC_IP` and `FIRMWARE_SERVER_PORT` when using a different approved network plan.

Verify from the companion:

```bash
# Shared configuration should contain the expected values
python3 /chosen/folder/companion_config.py get /absolute/path/.env COMPANION_IP
python3 /chosen/folder/companion_config.py get /absolute/path/.env FIRMWARE_SERVER_PORT

# Check Logs & OTA
sudo systemctl status logs-ota --no-pager
sudo journalctl -u logs-ota -f
```

## Python dependencies

The service installer handles dependencies. If troubleshooting an isolated Python environment manually, use the same package-management flag as the installers:

```bash
python3 -m pip install --break-system-packages mavsdk aiohttp 'python-socketio[asyncio_client]' psutil requests
```

## Firmware update flow

1. An authorized operator uploads/selects firmware in Quiver Hub.
2. Logs & OTA downloads the artifact and verifies its SHA-256 hash.
3. The companion makes the artifact available from its firmware HTTP endpoint.
4. `firmware_puller.lua` polls `http://<companion-ip>:<firmware-port>/firmware/status` and obtains the download when it is ready.
5. The puller writes `/APM/ardupilot.abin` and acknowledges completion.
6. The companion requests a MAVLink reboot and observes the FC returning online.
7. The service reports completion/failure back to Hub and removes temporary artifacts.

## Troubleshooting

### `FWPull: connect failed` or Pi unreachable

- Confirm the imported FC parameters `FWPULL_PI_IP0` … `FWPULL_PI_IP3` equal the four octets of the companion's configured `COMPANION_IP`.
- Confirm `FWPULL_PORT` equals `FIRMWARE_SERVER_PORT`.
- Confirm the companion uses the expected static address; do not expect the installer to configure it.
- Check firewall rules, cable/VLAN configuration, and service status.

### FC has no firmware-puller messages

- Confirm `SCR_ENABLE=1` and reboot the FC.
- Confirm `firmware_puller.lua` is located at `APM/scripts/firmware_puller.lua` on the FC SD card.
- Check GCS messages for Lua load/parameter-table errors.

### Logs & OTA fails to start

```bash
sudo systemctl status logs-ota --no-pager
sudo journalctl -u logs-ota -n 100 --no-pager
```

Verify that the rendered service points to the intended shared `.env`, the Hub URL/Drone ID/API key are present, and the resolved FC connection and web-server URL agree with the network plan.

## Related documentation

- [README.md](README.md) — suite installation order, shared configuration, and network reservations.
- [COMPANION_SERVICES.md](COMPANION_SERVICES.md) — service operations and troubleshooting.
