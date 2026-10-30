# Audited Companion Upgrade — 2026-10-30

## Start with diagnostics, not repeated restarts

`Unit ... has a bad unit file setting` is a generic systemd load error. Capture the exact rejected directive with the included read-only diagnostic:

```bash
bash /path/to/new-suite/diagnose_companion.sh --install-dir /your/installed/quiver
sudo bash /path/to/new-suite/repair_companion_services.sh --check
```

The diagnostic prints source hashes/version metadata and selected unit directives, not `.env` contents or credentials. Repair fixes historical quoted `WorkingDirectory` **and** `EnvironmentFile`, validates the full corrected set and installed drop-ins, keeps backups, and reloads systemd. It does not restart services or install dependencies. Do not copy unrendered `.service` templates into `/etc/systemd/system`.

## Upgrade the whole suite

Run the new bootstrap, not an old copied secondary installer. Blank source selection uses `Pan-Robotics/Arrow-Quiver-Hub/main/companion_scripts`; download mode pins a single Git commit and records hashes. A local bundle can be installed with:

```bash
sudo bash /path/to/new-suite/install_hub_client.sh --local
# Then use the installers copied into your selected installation directory.
```

All installers use `--break-system-packages -r requirements-companion.txt`. The legacy MAVSDK API is pinned to **3.17.4**, including compatible direct gRPC/protobuf requirements. The same Python used by systemd must pass `System()` and `mavsdk.ftp.FtpResult` preflight before units are enabled. Native `mavsdk>=4` is not interchangeable with this code.

Camera deployment pins **go2rtc v1.9.15** and checks official architecture-specific SHA-256 digests. Install/authenticate Tailscale through its official signed OS repository first; the camera installer no longer pipes a mutable internet shell script into root.

## Review preserved configuration explicitly

Installers retain existing `.env` assignments rather than silently resetting hardware/network choices. New safe defaults are `ENABLE_UAVCAN=false`, `UAVCAN_NODE_ID=111` (must be unused before opt-in), `ALLOW_REMOTE_FILE_WRITES=false`, `ALLOW_INSECURE_HUB=false`, and `GO2RTC_API_HOST=127.0.0.1`. Existing enabled DroneCAN/remote-write settings require your own review. Data directories are distinct from installer-owned source files.

DroneCAN monitoring is active bus participation and may require deliberate raw-socket privilege on the actual Pi. Telemetry is live best-effort data with bounded retry/backoff and drop counters; there is no durable replay guarantee.

## Firmware is fail-closed, not flight-approved

The updated OTA path requires a syntactically valid SHA-256 covering the original downloaded APJ/ABIN, fresh disarmed telemetry before firmware exposure and immediately before reboot, and an exact-size FC acknowledgement rather than bytes merely buffered by the Pi. No-FC mode does not run FC jobs. Reboot absence/timeouts are failures, not successful updates.

The FC's Lua applet cannot read the Pi `.env`; generate/import `firmware_puller.param` through your GCS and verify the configured FC IP/companion IP/port pair. Only the configured FC peer is allowed to use the temporary pull endpoints. IP allow-listing is **not cryptographic authentication**: transfer capability/digest authentication and firewall/network isolation remain required security follow-up for untrusted/shared networks.

Update the Lua scripts on the FC as well as Python on the Pi. New staging/exact-write/error paths depend on the actual ArduPilot Lua filesystem/socket APIs and require non-operational bench validation. Legacy manual HTTP PUT is default-disabled; it is not the supported Approach-C path.

## Known remaining gates

Server-side Socket.IO and job-creation authorization remain a separate control-plane security issue. Client-side remote file writes now fail closed by default, but that does not fix backend authorization. SIYI outbound CTRL-byte interoperability, photo/record function-feedback completion, and physical stop-on-disconnect require bench confirmation. Neither successful systemd parsing nor Python imports/stub tests prove a flight-controller firmware update or camera/CAN behavior safe in the field.
