# ArduPilot net_webserver.lua Setup Guide

**Version:** April 2026
**Author:** Pan Robotics

This guide covers how to enable and configure the ArduPilot [`net_webserver.lua`](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.lua) Lua scripting applet on your flight controller. The Quiver Hub Logs & OTA pipeline uses this web server as the **primary FC log access path** — the `FCLogSyncer` class on the companion computer downloads `.BIN` log files from the FC over HTTP instead of blocking the MAVLink connection with MAVFTP.

---

## 1. Prerequisites

The `net_webserver.lua` applet requires a flight controller with both **Lua scripting support** and a **networking interface** (Ethernet or WiFi). The table below summarizes the hardware and firmware requirements.

| Requirement | Details |
|---|---|
| Firmware | ArduPilot 4.4+ (Copter, Plane, or Rover) with Lua scripting compiled in |
| Processor | STM32H7 or higher recommended (STM32F4 boards lack sufficient RAM for networking + scripting) |
| Networking | Onboard Ethernet (CubeOrange+, CubePilot H7, Pixhawk 6X) or WiFi-capable board |
| SD Card | Required for storing scripts and serving log files |
| RAM | Minimum 80 KB free; `SCR_HEAP_SIZE` of 200 KB+ recommended when running `net_webserver.lua` alongside other applets |

> **Note:** The FC and the companion computer (Raspberry Pi) must be on the **same network segment**. A direct Ethernet cable between the FC and the Pi is the most reliable configuration for field use.

---

## 2. Step-by-Step Setup

### 2.1 Enable Lua Scripting

Connect to the flight controller using Mission Planner, QGroundControl, or MAVProxy and set the following parameters:

| Parameter | Value | Purpose |
|---|---|---|
| `SCR_ENABLE` | `1` | Enable the Lua scripting engine |
| `SCR_VM_I_COUNT` | `1000000` | Increase the VM instruction count for the web server's network I/O loops [1] |
| `SCR_HEAP_SIZE` | `200000` | Allocate 200 KB of heap memory for scripts (adjust upward if running multiple applets) |

After setting these parameters, **reboot the flight controller**. On reboot, ArduPilot creates the `APM/scripts/` directory on the SD card if it does not already exist [2].

### 2.2 Copy the Applet to the SD Card

Download `net_webserver.lua` from the [ArduPilot repository](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.lua) and copy it to the `APM/scripts/` directory on the FC's SD card. There are three ways to do this:

**Option A — MAVFTP (recommended for in-field setup):**
Use Mission Planner's MAVFTP file browser or MAVProxy's `ftp` module to upload the file directly over the MAVLink connection:

```
ftp put net_webserver.lua APM/scripts/net_webserver.lua
```

**Option B — Direct SD card access:**
Remove the SD card from the flight controller, mount it on a computer, and copy `net_webserver.lua` into the `APM/scripts/` folder.

**Option C — Quiver Hub file upload:**
Use the Drone Configuration panel in Quiver Hub to upload `net_webserver.lua` as a file delivery job. The Hub Client on the Pi will download it, and you can then use `scp` to copy it to the FC's SD card mount point.

After copying the file, **reboot the flight controller** again. The scripting engine loads all `.lua` files from `APM/scripts/` on boot.

### 2.3 Configure the Web Server Parameters

After the reboot with `net_webserver.lua` loaded, the `WEB_*` parameters become available [3]. Set the following:

| Parameter | Value | Purpose |
|---|---|---|
| `WEB_ENABLE` | `1` | Enable the web server |
| `WEB_BIND_PORT` | `8080` | TCP port the server listens on (default is 8080; change only if there is a port conflict) |
| `WEB_BLOCK_SIZE` | `4096` | Block size for file read/write operations (larger values improve throughput at the cost of memory) |
| `WEB_TIMEOUT` | `10` | Timeout in seconds for inactive client connections |

**Reboot one final time** to apply the web server configuration.

### 2.4 Configure FC Networking

If your flight controller uses Ethernet (the most common configuration for companion computer setups), ensure the networking parameters are set correctly:

| Parameter | Value | Purpose |
|---|---|---|
| `NET_ENABLE` | `1` | Enable the networking stack |
| `NET_IPADDR0`–`NET_IPADDR3` | e.g., `192.168.144.20` | Static IP address for the FC's Ethernet interface |
| `NET_NETMASK` | `24` | Subnet mask (255.255.255.0) |
| `NET_GWADDR0`–`NET_GWADDR3` | e.g., `192.168.144.1` | Default gateway (optional for direct Pi connection) |

The companion computer (Raspberry Pi) should be configured with a static IP on the same subnet — for example, `192.168.144.10` with a `/24` netmask.

---

## 3. Verification

After completing the setup and rebooting, verify the web server is running by performing these checks from the companion computer.

### 3.1 HTTP Connectivity Test

From the Raspberry Pi, run:

```bash
curl -s -o /dev/null -w "%{http_code}" http://192.168.144.20:8080/
```

A response of `200` confirms the web server is serving the SD card root. If the connection times out, check the Ethernet cable, IP addresses, and firewall rules.

### 3.2 Log Directory Listing

Verify that the FC's log directory is accessible:

```bash
curl -s http://192.168.144.20:8080/mnt/APM/LOGS/
```

This should return an HTML directory listing of `.BIN` and/or `.log` files. The `FCLogSyncer` class parses this HTML listing to discover new log files.

### 3.3 Log File Download

Test downloading a specific log file:

```bash
curl -s -o /tmp/test_log.BIN http://192.168.144.20:8080/mnt/APM/LOGS/00000001.BIN
ls -la /tmp/test_log.BIN
```

If the file downloads successfully, the web server is fully operational and ready for the Quiver Hub pipeline.

### 3.4 Quiver Hub Health Indicator

Once the Logs & OTA companion service is running, the Quiver Hub dashboard displays an **FC Web Server** health indicator in the FC Logs tab. This indicator shows:

| Status | Meaning |
|---|---|
| **Reachable** (green) | HTTP ping to the FC web server succeeded; latency is displayed |
| **Unreachable** (red) | HTTP ping failed; check network connectivity and `WEB_ENABLE` parameter |
| **Unknown** (gray) | No health check data received yet (companion may not be connected) |

---

## 4. Quiver Hub Integration

The Quiver Hub `logs_ota_service.py` companion script uses the FC web server as follows:

The `FCLogSyncer` class runs a 60-second background sync loop (only when the drone is **disarmed**) that parses the HTML directory listing from `http://<fc_ip>:8080/mnt/APM/LOGS/`, compares file sizes and modification times against a local JSON manifest, and downloads new or changed `.BIN` files using `If-Modified-Since` headers to a local cache directory (`/var/lib/quiver/fc_logs/` by default).

When the user triggers a **scan** or **download** from the Quiver Hub dashboard, the job handler uses a three-tier resolution strategy:

| Tier | Source | Speed | Notes |
|---|---|---|---|
| 1 | Local cache | Instant | Files already synced by `FCLogSyncer` |
| 2 | HTTP via `net_webserver.lua` | Fast | Direct HTTP download from FC, also populates the local cache |
| 3 | MAVFTP fallback | Slow | Used only when the web server is unreachable; blocks the MAVLink connection |

### Companion Script Configuration

The `logs_ota_service.py` script accepts two CLI arguments for configuring the FC web server connection:

```bash
python3 logs_ota_service.py \
    --hub-url https://your-hub.manus.space \
    --drone-id quiver_001 \
    --api-key YOUR_API_KEY \
    --fc-connection serial:///dev/ttyAMA1:921600 \
    --fc-webserver-url http://192.168.144.20:8080 \
    --log-store-dir /var/lib/quiver/fc_logs/
```

| Argument | Default | Purpose |
|---|---|---|
| `--fc-webserver-url` | `http://192.168.144.20:8080` | URL of the ArduPilot `net_webserver.lua` HTTP server |
| `--log-store-dir` | `/var/lib/quiver/fc_logs/` | Local directory for cached FC log files |

---

## 5. Troubleshooting

### Script Not Loading

If the `WEB_*` parameters do not appear after reboot, the script failed to load. Check the following:

The GCS messages log (Mission Planner's Messages tab or MAVProxy console) will show scripting errors on boot. Common causes include insufficient `SCR_HEAP_SIZE` (increase to 250000 or higher), the script file being in the wrong directory (must be `APM/scripts/`, not `scripts/` or the SD card root), or a firmware build that does not include the Lua scripting module (`AP_SCRIPTING_ENABLED` must be set in the build).

### Web Server Unreachable

If `curl` to the FC IP times out, verify the physical connection first. For direct Ethernet between the Pi and FC, ensure the cable is connected and both devices have static IPs on the same subnet. Run `ping 192.168.144.20` from the Pi to confirm Layer 3 connectivity. If ping works but HTTP does not, confirm `WEB_ENABLE = 1` and `WEB_BIND_PORT = 8080`, then reboot the FC.

### Empty Directory Listing

If the HTTP request to `/mnt/APM/LOGS/` returns an empty listing but you know logs exist, the SD card may not be mounted at the expected path. The `net_webserver.lua` applet serves the SD card root as `/`, so the logs directory is at `/mnt/APM/LOGS/` relative to the SD card root. On some boards, the mount point differs — check the ArduPilot documentation for your specific hardware.

### Slow Downloads

If log file downloads are significantly slower than expected, try increasing `WEB_BLOCK_SIZE` to `8192` or `16384`. Larger block sizes reduce the number of read/write system calls at the cost of additional memory. Also ensure the Ethernet link is running at full speed (100 Mbps for most FC Ethernet interfaces).

### Port Conflicts

If another service on the FC is using port 8080, change `WEB_BIND_PORT` to an alternative (e.g., `8081`) and update the `--fc-webserver-url` argument in the companion script accordingly:

```bash
--fc-webserver-url http://192.168.144.20:8081
```

---

## References

[1]: https://ardupilot.org/copter/docs/common-lua-scripts.html "ArduPilot Lua Scripts Documentation"
[2]: https://ardupilot.org/copter/docs/common-scripting-step-by-step.html "ArduPilot Script Setup and Use Examples"
[3]: https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Scripting/applets/net_webserver.md "ArduPilot net_webserver.md — Web Server Application"
