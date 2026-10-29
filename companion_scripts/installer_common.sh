#!/usr/bin/env bash
# Shared by the companion installers. .env is data, never sourced as shell code.

quiver_privileged() {
    if [ "${EUID}" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

quiver_get() {
    python3 "$SCRIPT_DIR/companion_config.py" get "$ENV_FILE" "$1"
}

quiver_set() {
    quiver_privileged python3 "$SCRIPT_DIR/companion_config.py" set "$ENV_FILE" "$@"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$ENV_FILE"
    quiver_privileged chmod 600 "$ENV_FILE"
}

quiver_prompt() {
    local key="$1" label="$2" mode="${3:-}" current answer
    current=$(quiver_get "$key")
    if [ "$mode" = secret ]; then
        read -r -s -p "$label (blank keeps existing): " answer
        printf '\n'
    else
        read -r -p "$label [$current]: " answer
    fi
    answer=${answer:-$current}
    quiver_set "$key" "$answer"
}

quiver_systemd_path() {
    # Quote a word for ExecStart, Environment, EnvironmentFile, or path lists.
    # Do NOT use for WorkingDirectory: that directive takes one literal path.
    python3 - "$1" <<'PY'
import sys
value = sys.argv[1].replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"')
print('"' + value + '"')
PY
}

quiver_systemd_directory() {
    # WorkingDirectory is not a word list. Quotes become part of its path and
    # cause systemd to reject the unit as non-absolute, even without spaces.
    python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
if not value.startswith('/') or any(c in value for c in '\r\n\0'):
    raise SystemExit('WorkingDirectory must be a single absolute path')
print(value.replace('%', '%%'))
PY
}

quiver_copy() {
    local name="$1" source="$SCRIPT_DIR/$1" target="$INSTALL_DIR/$1"
    if [ ! -f "$source" ]; then
        echo "Missing $source. Run the updated hub installer to download the complete suite." >&2
        return 1
    fi
    if [ "$(realpath "$source")" != "$(realpath -m "$target")" ]; then
        quiver_privileged cp -- "$source" "$target"
    fi
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$target"
    case "$name" in *.sh|*.py) quiver_privileged chmod 755 "$target" ;; esac
}

quiver_install_helpers() {
    quiver_copy companion_config.py
    quiver_copy companion-config.example
    quiver_copy installer_common.sh
}

quiver_configure() {
    local default_user default_home default_dir answer probe
    default_user=${SUDO_USER:-$(id -un)}
    probe=${QUIVER_ENV_FILE:-${QUIVER_CONFIG_PROBE:-$SCRIPT_DIR/.env}}
    if [ -f "$probe" ]; then
        answer=$(python3 "$SCRIPT_DIR/companion_config.py" get "$probe" SERVICE_USER)
        default_user=${answer:-$default_user}
    fi
    read -r -p "Service user [$default_user]: " answer
    SERVICE_USER=${answer:-$default_user}
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        echo "Service user '$SERVICE_USER' does not exist. Create that user first." >&2
        return 1
    fi
    SERVICE_GROUP=$(id -gn "$SERVICE_USER")
    SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    default_home="$SERVICE_HOME"
    default_dir=${QUIVER_INSTALL_DIR:-$default_home/quiver}
    if [ -f "$probe" ]; then
        answer=$(python3 "$SCRIPT_DIR/companion_config.py" get "$probe" INSTALL_DIR)
        default_dir=${QUIVER_INSTALL_DIR:-${answer:-$default_dir}}
    fi
    read -r -p "Install directory [$default_dir]: " answer
    INSTALL_DIR=${answer:-$default_dir}
    # Expand a leading ~/ for the selected service user's home, not root's home.
    case "$INSTALL_DIR" in '~/'*) INSTALL_DIR="$SERVICE_HOME/${INSTALL_DIR:2}" ;; esac
    case "$INSTALL_DIR" in /*) ;; *) echo "Use an absolute installation path." >&2; return 1 ;; esac
    if [[ "$INSTALL_DIR" == *$'\n'* || "$INSTALL_DIR" == *$'\r'* ]]; then
        echo "Installation paths cannot contain newlines." >&2; return 1
    fi
    INSTALL_DIR=$(realpath -m "$INSTALL_DIR")
    ENV_FILE=${QUIVER_ENV_FILE:-$INSTALL_DIR/.env}
    case "$ENV_FILE" in /*) ;; *) echo "QUIVER_ENV_FILE must be absolute." >&2; return 1 ;; esac
    quiver_privileged mkdir -p -- "$INSTALL_DIR" "$(dirname "$ENV_FILE")"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
    # Only migrate legacy data when no canonical .env exists. Never overwrite it.
    if [ ! -f "$ENV_FILE" ]; then
        local legacy
        for legacy in "$probe" "$INSTALL_DIR/forwarder.env" "$SCRIPT_DIR/forwarder.env"; do
            if [ -f "$legacy" ]; then
                quiver_privileged install -m 600 "$legacy" "$ENV_FILE"
                echo "Migrated $legacy to $ENV_FILE (original retained)."
                break
            fi
        done
    fi
    quiver_install_helpers
    quiver_privileged python3 "$SCRIPT_DIR/companion_config.py" init "$ENV_FILE"
    quiver_set INSTALL_DIR "$INSTALL_DIR" SERVICE_USER "$SERVICE_USER" SERVICE_GROUP "$SERVICE_GROUP"
    local config_dir parsers_dir
    config_dir=$(quiver_get CONFIG_DIR); config_dir=${config_dir:-$INSTALL_DIR/config}
    parsers_dir=$(quiver_get PARSERS_DIR); parsers_dir=${parsers_dir:-$INSTALL_DIR/parsers}
    quiver_set CONFIG_DIR "$config_dir" PARSERS_DIR "$parsers_dir"
    quiver_privileged mkdir -p -- "$config_dir" "$parsers_dir"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$config_dir" "$parsers_dir"
    echo "Shared configuration: $ENV_FILE"
}
