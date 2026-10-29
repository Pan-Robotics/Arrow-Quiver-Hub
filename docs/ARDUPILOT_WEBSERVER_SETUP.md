# ArduPilot net_webserver.lua Setup Guide

**Updated:** October 2026 | **Author:** Pan Robotics

Quiver's Logs & OTA service uses the flight controller's `net_webserver.lua` applet for HTTP log discovery and download. The FC runs the Lua applet; the companion computer runs the Python services and reads their configuration from one shared `.env`.

## Prerequisites

Use an ArduPilot flight controller with Lua scripting, a networking interface, an SD card, and enough scripting heap for the applets you enable. The FC and companion must be on the same network segment. Confirm the parameter names and networking support against the firmware installed on your board.

The Quiver network is flat and static. Do not install a DHCP server on the Pi because of Siyi firmware conflicts. The supplied defaults are FC `192.168.144.51`, companion `192.168.144.49`, and CubeNode `192.168.144.50` on `192.168.144.0/24`. Siyi reserves `.11`, `.12`, `.20`, `.25`, and `.60`; do not assign them to the FC or payloads. Payloads use `.100`–`.199`. These are editable defaults in the companion suite's `companion-config.example`, not runtime literals.

## Enable and install the FC applet

Enable Lua scripting with `SCR_ENABLE=1`. Allocate appropriate scripting memory (`SCR_HEAP_SIZE`; 200000 is a starting point for the webserver) and instruction budget (`SCR_VM_I_COUNT`, where supported). Reboot after changing scripting settings.

Download [net_webserver.lua from ArduPilot](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.lua) and copy it to `APM/scripts/` on the FC SD card using the GCS MAVFTP browser or direct SD-card access. Reboot to load the applet. The hub installer downloads the companion suite's Lua files to the Pi only; it does not install anything on the FC.

Configure the applet's `WEB_*` parameters after it loads:

| Parameter | Example value | Purpose |
|---|---|---|
| `WEB_ENABLE` | `1` | Enable HTTP service |
| `WEB_BIND_PORT` | `8080` | Match the companion's `FC_WEBSERVER_PORT` |
| `WEB_BLOCK_SIZE` | `4096` | File read block size; adjust for available memory |
| `WEB_TIMEOUT` | `10` | Inactive client timeout, in seconds |

Configure the FC's Ethernet interface for the selected static address and `/24` mask using the networking parameters provided by your ArduPilot firmware. Configure the Pi's host interface separately for the matching `COMPANION_IP`. The companion installers do not assign interface addresses, gateways, or firewall rules. Reboot the FC after applying its settings.

## Configure the companion

Run `bash install_hub_client.sh` first. It downloads the complete companion folder from the default GitHub path (or another folder you enter), asks for a real service user and preferred installation directory, and creates `.env` there. Existing `forwarder.env` settings are migrated without overwriting an existing `.env`.

The relevant settings are:

```dotenv
FC_IP=192.168.144.51
FC_WEBSERVER_PORT=8080
COMPANION_IP=192.168.144.49
LOG_STORE_DIR=/var/lib/quiver/fc_logs
```

The Python configuration helper derives `FC_WEBSERVER_URL` from the IP and port. Leave that URL unset unless you need a deliberate override. For Ethernet MAVLink, select TCP in the OTA installer or set `FC_CONNECTION=tcp`; it resolves from `FC_IP` and `FC_MAVLINK_TCP_PORT`. Serial connection strings and explicit URLs are still supported.

Install the service from the folder you selected:

```bash
sudo bash install_logs_ota.sh
```

The generated systemd unit loads the same `.env`; it does not embed IP addresses or API keys into `ExecStart`. After changing network settings, restart the service:

```bash
sudo systemctl restart logs-ota
```

If the installation folder or `LOG_STORE_DIR` changes, rerun the installer to regenerate `WorkingDirectory`, script paths, and `ReadWritePaths`.

## Verify using the configured endpoint

From the installation folder, read the endpoint as data with the Python helper. Do not `source` `.env` as shell code:

```bash
FC_URL=$(python3 companion_config.py get .env FC_WEBSERVER_URL)

# GET is intentional: the Lua webserver need not implement HEAD.
curl -s -o /dev/null -w '%{http_code}\n' "$FC_URL/"

# List logs (mount paths vary by FC firmware/board).
curl -s "$FC_URL/mnt/APM/LOGS/"

# Download one known log.
curl -f -o /tmp/test_log.BIN "$FC_URL/mnt/APM/LOGS/00000001.BIN"
ls -l /tmp/test_log.BIN
```

A root HTTP response of `200` confirms reachability. Check the actual listing and mount path on your FC before downloading logs. The Hub FC Logs tab also shows the webserver health status once the companion reports diagnostics.

`FCLogSyncer` periodically scans while disarmed and maintains a local manifest. It does not automatically download every new log. User requests use local cache first, then HTTP, with MAVFTP fallback for log access when HTTP is unavailable.

## Troubleshooting

If `WEB_*` parameters do not appear, inspect the GCS messages for Lua errors. Check the script path, firmware scripting support, and heap allocation, then reboot.

If HTTP times out, compare the actual FC/Pi interface settings with `.env`. Changing `.env` changes connection targets; it does not configure the hardware. Check cables, the subnet mask, firewall rules, `WEB_ENABLE`, and the matching FC/companion HTTP ports.

If a directory listing is empty, inspect the SD card's actual HTTP root and mount paths. If downloads are slow, inspect link speed and scripting resources before changing `WEB_BLOCK_SIZE`.

If you change the FC's `WEB_BIND_PORT`, update `FC_WEBSERVER_PORT` in `.env` and restart `logs-ota`. An explicit `FC_WEBSERVER_URL` overrides that derivation, so update or remove it too.

For Approach C OTA, the FC's `firmware_puller.lua` cannot read the Pi's `.env`. The hub/OTA installers generate `firmware_puller.param` from `COMPANION_IP` and `FIRMWARE_SERVER_PORT` (default 8070). Import it through the GCS to set `FWPULL_PI_IP0`–`FWPULL_PI_IP3` and `FWPULL_PORT`, then verify the values before manually enabling `FWPULL_ENABLE`. Regenerate/reimport after those `.env` settings change. New Lua IP defaults are deliberately unset; existing saved FC parameters persist until changed. This is a different server from the FC log webserver. See `companion_scripts/OTA_Setup_Guide.md` for the full setup.

## References

[1]: https://ardupilot.org/copter/docs/common-lua-scripts.html "ArduPilot Lua Scripts Documentation"
[2]: https://ardupilot.org/copter/docs/common-scripting-step-by-step.html "ArduPilot Script Setup and Use Examples"
[3]: https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.md "ArduPilot Web Server Application"
