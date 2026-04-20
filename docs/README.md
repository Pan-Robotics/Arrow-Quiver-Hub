# Quiver Hub — Documentation Index

This directory contains all architecture documents, pipeline references, and specification files for the Quiver Hub project.

---

## Architecture

| Document | Description |
|---|---|
| [quiver-hub-architecture.md](architecture/quiver-hub-architecture.md) | Master architecture document — full system overview, all endpoints, database schema, companion scripts, frontend apps, and deployment topology |
| [Quiver_Camera_Feed_Architecture.md](architecture/Quiver_Camera_Feed_Architecture.md) | Camera feed pipeline — SIYI A8 Mini, go2rtc, Tailscale funnel, WebRTC signaling, gimbal control protocol |
| [flight-analytics-integration-analysis.md](architecture/flight-analytics-integration-analysis.md) | Integration analysis mapping the Flight-Log-Analyser tool to Quiver Hub infrastructure — parser reuse, chart rendering, storage, and implementation phases |

## Setup Guides

| Document | Description |
|---|---|
| [ARDUPILOT_WEBSERVER_SETUP.md](ARDUPILOT_WEBSERVER_SETUP.md) | ArduPilot `net_webserver.lua` setup guide — enabling Lua scripting, configuring `WEB_BIND_PORT`, network setup, verification steps, Quiver Hub integration, and troubleshooting |

## Pipeline References

| Document | Description |
|---|---|
| [LOGS_OTA_PIPELINE.md](LOGS_OTA_PIPELINE.md) | Logs & OTA Updates pipeline — FC log scan/download via HTTP (`net_webserver.lua`) with MAVFTP fallback, multipart upload, download-to-PC proxy, OTA firmware flash, system diagnostics, remote log streaming, and "Send to Flight Analytics" integration |

## Specifications

| Document | Description |
|---|---|
| [PARSER_OUTPUT_FORMAT.md](PARSER_OUTPUT_FORMAT.md) | Parser output format specification — required data structure for custom payload parsers |
| [UI_SCHEMA_SPEC.md](UI_SCHEMA_SPEC.md) | UI Schema specification — JSON schema for custom app widget layouts and data bindings |
| [QUIVER_DEPLOYMENT_TEMPLATE.md](QUIVER_DEPLOYMENT_TEMPLATE.md) | Edge deployment template — Flask/FastAPI service template for running custom parsers on Quiver devices |

## Reference Materials

| Document | Description |
|---|---|
| [reference/siyi_sdk_findings.md](reference/siyi_sdk_findings.md) | SIYI A8 Mini SDK reverse-engineering findings — binary protocol, CRC16, command IDs |
| [reference/SIYIA8MiniCameraServices.md](reference/SIYIA8MiniCameraServices.md) | SIYI A8 Mini camera services design document |
| [reference/LARGE_FILES_CDN.md](reference/LARGE_FILES_CDN.md) | CDN links for large reference files (PDFs, diagrams) that exceed the project size limit |
| [reference/Flight-Log-Analyser/](reference/Flight-Log-Analyser/) | Reference copy of the original Flight-Log-Analyser Flask application |
| [reference/sample-logs/](reference/sample-logs/) | Sample ArduPilot flight log files for testing |

## Companion Scripts

Companion script documentation is consolidated in a single file:

| Document | Description |
|---|---|
| [companion_scripts/COMPANION_SERVICES.md](../companion_scripts/COMPANION_SERVICES.md) | All 5 companion services — Hub Client, Telemetry Forwarder, Logs & OTA, Camera Stream, SIYI Camera Controller — with CLI args, install steps, troubleshooting, and security |

## Archive

Historical documents from earlier development phases are stored in [archive/](archive/).
