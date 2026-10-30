# SIYI A8 Mini Camera Services

This reference replaces the historical FFmpeg/HLS setup. The supported stack is the SIYI TCP gimbal controller plus **go2rtc RTSP → WebRTC**, with Tailscale Funnel for HTTPS signaling. Do not use old `/video1`, `/video2`, `--port 8080`, or standalone HLS installer commands.

## Install

Run the Hub bootstrap first to obtain the entire companion suite and create your chosen installation directory and shared `.env`. Then install Tailscale using its official signed OS package repository and authenticate the companion. The camera installer no longer executes a mutable remote root-shell installer.

```bash
# Use your actual downloaded/installed companion directory.
sudo bash /chosen/folder/install_camera_services.sh
```

The installer uses `requirements-companion.txt` with `--break-system-packages`, pins go2rtc **v1.9.15** with architecture-specific SHA-256 verification, validates the full staged systemd unit set, and then installs `go2rtc`, `tailscale-funnel`, `camera-stream`, and `siyi-camera` services.

## Configuration

Use the shared `.env` keys `SIYI_CAMERA_IP`, `SIYI_SDK_PORT`, `SIYI_RTSP_PORT`, `STREAM_TYPE=main|sub`, `GO2RTC_API_HOST=127.0.0.1`, `GO2RTC_API_PORT`, `GO2RTC_WEBRTC_PORT`, and `TAILSCALE_FUNNEL_PORT=443|8443|10000`. Leave derived `RTSP_URL` commented unless a deliberate whole-URL override is required. `go2rtc.yaml` is regenerated at startup.

Systemd owns go2rtc/Funnel when `GO2RTC_EXTERNAL=true` and `SKIP_FUNNEL_SETUP=true`; the camera manager health-checks them without launching a second process. Gimbal commands use the current UI/Hub envelope and the controller's typed adapter. Photo/record results indicate command transmission, not confirmed camera completion. SIYI CTRL-byte interoperability and physical link-loss stop behavior still require non-operational bench validation.

## Diagnostics

```bash
bash /chosen/folder/diagnose_companion.sh --install-dir /chosen/folder
sudo bash /chosen/folder/repair_companion_services.sh --check
```

The diagnostic is read-only and redacts credentials. Repair corrects recognized installed `WorkingDirectory`/`EnvironmentFile` quoting only after systemd validation; it does not start services or alter `.env`.

See [Companion README](../../companion_scripts/README.md) and [Companion Service Reference](../../companion_scripts/COMPANION_SERVICES.md) for current setup, network, security limitations, and restart instructions.
