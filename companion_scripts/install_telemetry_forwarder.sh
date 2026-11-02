#!/usr/bin/env bash
# Install telemetry from a complete, current suite. No network-interface changes.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SYSTEMD_DIR=${QUIVER_SYSTEMD_DIR:-/etc/systemd/system}
TEST_RUN=false
TEST_SECONDS=30
NO_START=false
DISABLE_CAN=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --test-run) TEST_RUN=true ;;
        --test-seconds)
            [ "$#" -ge 2 ] || { echo "--test-seconds needs 1..300 seconds." >&2; exit 2; }
            TEST_SECONDS=$2; shift ;;
        --no-start) NO_START=true ;;
        --disable-uavcan) DISABLE_CAN=true ;;
        --help)
            echo "Usage: sudo bash install_telemetry_forwarder.sh [--test-run] [--test-seconds 1..300] [--no-start] [--disable-uavcan]"
            echo "--test-run requires live FC data plus acknowledged Hub ingest before starting the service."
            echo "--disable-uavcan explicitly persists CAN disabled; no interface is configured."
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
case "$TEST_SECONDS" in ''|*[!0-9]*) echo "Test duration must be 1..300 seconds." >&2; exit 2 ;; esac
[ "$TEST_SECONDS" -ge 1 ] && [ "$TEST_SECONDS" -le 300 ] || { echo "Test duration must be 1..300 seconds." >&2; exit 2; }
if [ "$EUID" -ne 0 ]; then
    echo "Run with sudo: sudo bash $SCRIPT_DIR/install_telemetry_forwarder.sh" >&2
    exit 1
fi
for required in installer_common.sh installer_support.py companion_config.py companion-config.example requirements-companion.txt telemetry_forwarder.py; do
    [ -f "$SCRIPT_DIR/$required" ] || { echo "Missing $required. Download the complete current suite, not just this installer." >&2; exit 2; }
done
if [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.executable))')" != "$(readlink -f /usr/bin/python3)" ]; then
    echo "PATH python3 is not the telemetry service's /usr/bin/python3. Use the system Python PATH for installation." >&2
    exit 2
fi
source "$SCRIPT_DIR/installer_common.sh"
printf '\nQuiver Telemetry Forwarder installer\n\n'
quiver_configure
quiver_prompt WEB_SERVER_URL "Quiver Hub URL"
quiver_prompt DRONE_ID "Drone ID"
quiver_prompt API_KEY "API key" secret
if [ -z "$(quiver_get API_KEY)" ]; then echo "API_KEY is required." >&2; exit 1; fi
quiver_prompt MAVLINK_URL "MAVLink connection URL"
if [ "$DISABLE_CAN" = true ]; then
    quiver_set ENABLE_UAVCAN false
    echo "DroneCAN explicitly disabled by --disable-uavcan."
else
    quiver_prompt ENABLE_UAVCAN "Enable DroneCAN battery monitoring (true/false)"
fi
quiver_prompt CAN_INTERFACE "CAN interface"
quiver_prompt UPDATE_RATE_HZ "Telemetry rate (Hz)"
quiver_validate_config
CAN_ENABLED=$(quiver_get ENABLE_UAVCAN)
CAN_DEVICE=$(quiver_get CAN_INTERFACE)
case "${CAN_ENABLED,,}" in
    true|1|yes|on)
        if [ ! -d "/sys/class/net/$CAN_DEVICE" ]; then
            echo "Configured CAN interface '$CAN_DEVICE' is missing. No CAN setup will be attempted."
            read -r -p "Disable DroneCAN in .env and use FC-only telemetry? [y/N]: " ANSWER
            case "$ANSWER" in
                y|Y|yes|YES) quiver_set ENABLE_UAVCAN false ;;
                *) echo "Aborted before packages/service changes. Configure CAN separately, or explicitly disable it." >&2; exit 2 ;;
            esac
        fi ;;
esac
printf '\nConfiguration: %s\nService user: %s\nInstall directory: %s\n' "$ENV_FILE" "$SERVICE_USER" "$INSTALL_DIR"
echo "The existing telemetry worker will be stopped before packages are repaired. Other services are not restarted."
if [ "$TEST_RUN" = true ]; then
    echo "A ${TEST_SECONDS}s foreground bench test will read FC telemetry and POST it to the configured Hub."
    echo "No arm/start-flight commands are sent. Enabled CAN is active participation with your configured node ID."
    echo "On any failure telemetry remains stopped; success is not inferred from systemd 'running'."
fi
read -r -p "Proceed with installation? [Y/n]: " CONFIRM
case "${CONFIRM:-Y}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac

# Stop only telemetry before replacing its imported packages/source, and never
# launch a foreground test alongside its UDP/CAN consumers.
if systemctl is-active --quiet telemetry-forwarder.service; then
    systemctl stop telemetry-forwarder.service
fi
if systemctl is-active --quiet telemetry-forwarder.service; then
    echo "Telemetry did not stop; refusing a second telemetry process." >&2
    exit 2
fi
apt-get update
apt-get install -y python3 python3-pip
python3 -m pip install --break-system-packages --upgrade -r "$SCRIPT_DIR/requirements-companion.txt"
if ! python3 "$SCRIPT_DIR/installer_support.py" sdk-preflight; then
    echo "Repairing the exact legacy SDK package once (no native v4 migration)."
    python3 -m pip install --break-system-packages --force-reinstall --no-deps mavsdk==3.17.4
    python3 "$SCRIPT_DIR/installer_support.py" sdk-preflight
fi
quiver_copy telemetry_forwarder.py
quiver_copy install_telemetry_forwarder.sh
quiver_copy requirements-companion.txt
quiver_install_helpers

service_python() {
    runuser --user "$SERVICE_USER" -- /usr/bin/python3 -s "$INSTALL_DIR/installer_support.py" \
        service-run "$ENV_FILE" /usr/bin/python3 -s "$INSTALL_DIR/telemetry_forwarder.py" "$@"
}
# A service-user ~/.local MAVSDK4 cannot shadow the system dependency: both this
# check and the actual unit disable user site packages with the same interpreter.
service_python --check

mkdir -p -- "$SYSTEMD_DIR"
UNIT_STAGING=$(mktemp -d)
trap 'rm -rf -- "$UNIT_STAGING"' EXIT
cat > "$UNIT_STAGING/telemetry-forwarder.service" <<EOF
[Unit]
Description=Quiver Hub Telemetry Forwarder
Documentation=https://github.com/Pan-Robotics/Arrow-Quiver-Hub
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$(quiver_systemd_directory "$INSTALL_DIR")
EnvironmentFile=$(quiver_systemd_environment_file "$ENV_FILE")
Environment=$(quiver_systemd_path "QUIVER_ENV_FILE=$ENV_FILE")
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONNOUSERSITE=1
ExecStart=/usr/bin/python3 $(quiver_systemd_path "$INSTALL_DIR/telemetry_forwarder.py")
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=telemetry-forwarder
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$(quiver_systemd_path "$INSTALL_DIR")

[Install]
WantedBy=multi-user.target
EOF
# Parse the proposed unit against installed drop-ins before test/start changes.
python3 "$SCRIPT_DIR/installer_support.py" install-units "$UNIT_STAGING" "$SYSTEMD_DIR"
systemctl daemon-reload
if [ "$TEST_RUN" = true ]; then
    if ! service_python --test-run --test-seconds "$TEST_SECONDS"; then
        echo "Telemetry bench test FAILED. Service remains stopped. Check FC/MAVLINK_URL, CAN and Hub errors." >&2
        exit 2
    fi
    echo "Telemetry bench test PASSED with live pipeline evidence."
fi
if [ "$NO_START" = true ]; then
    echo "Installed and checked; telemetry intentionally left stopped (--no-start)."
else
    systemctl enable telemetry-forwarder.service
    systemctl restart telemetry-forwarder.service
    if ! systemctl is-active --quiet telemetry-forwarder.service; then
        echo "Telemetry service failed to stay running; inspect journalctl. This is not a healthy install." >&2
        exit 2
    fi
    echo "Telemetry service is running. Runtime logs, not process status alone, show pipeline readiness."
fi
printf '\nTelemetry installed. Settings are read from %s at each start.\n' "$ENV_FILE"
printf 'Logs: sudo journalctl -u telemetry-forwarder -f\n'
