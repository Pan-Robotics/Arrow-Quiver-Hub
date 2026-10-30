#!/usr/bin/env bash
# Shared companion installers. .env is data; never execute it as shell code.

quiver_privileged() {
    if [ "${EUID}" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

quiver_get() {
    quiver_privileged python3 "$SCRIPT_DIR/companion_config.py" get "$ENV_FILE" "$1"
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

quiver_path() {
    python3 "$SCRIPT_DIR/installer_support.py" path "$1"
}

quiver_systemd_path() {
    # Only word-list directives: ExecStart arguments, Environment, ReadWritePaths.
    python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
if any(ord(c) < 32 for c in value):
    raise SystemExit('Unit values cannot contain control characters')
value = value.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"')
print('"' + value + '"')
PY
}

quiver_systemd_directory() {
    # BOTH WorkingDirectory and EnvironmentFile take a literal single path.
    local path
    path=$(quiver_path "$1") || return $?
    printf '%s\n' "${path//%/%%}"
}

quiver_systemd_environment_file() {
    quiver_systemd_directory "$1"
}

quiver_copy() {
    local name="$1" source="$SCRIPT_DIR/$1" target="$INSTALL_DIR/$1"
    [ -f "$source" ] || { echo "Missing $source; download the complete updated suite." >&2; return 1; }
    quiver_privileged python3 "$SCRIPT_DIR/installer_support.py" copy "$source" "$target"
    # Source code remains installer-owned. Only dedicated data roots are writable.
    if [ "${EUID}" -eq 0 ]; then
        chown root:root "$target"
    fi
}

quiver_install_helpers() {
    quiver_copy installer_support.py
    quiver_copy companion_config.py
    quiver_copy companion-config.example
    quiver_copy installer_common.sh
}

quiver_validate_config() {
    quiver_privileged python3 "$SCRIPT_DIR/companion_config.py" validate "$ENV_FILE"
}

quiver_install_units() {
    quiver_privileged python3 "$SCRIPT_DIR/installer_support.py" install-units "$1" "$SYSTEMD_DIR"
}

quiver_data_directory() {
    local value="$1" path owner
    path=$(quiver_path "$value")
    # Never transfer ownership of an unrelated existing root/system directory.
    case "$path" in "$INSTALL_DIR"/*|/var/lib/quiver/*) ;;
        *)
            if [ -e "$path" ]; then
                owner=$(stat -c %U "$path")
                [ "$owner" = "$SERVICE_USER" ] || { echo "Refusing ownership change of unrelated directory $path ($owner)." >&2; return 1; }
            else
                local parent
                parent=$(dirname "$path")
                while [ ! -d "$parent" ]; do parent=$(dirname "$parent"); done
                [ "$(stat -c %U "$parent")" = "$SERVICE_USER" ] || {
                    echo "Place data under $INSTALL_DIR, /var/lib/quiver, or a user-owned data volume." >&2; return 1;
                }
            fi ;;
    esac
    quiver_privileged mkdir -p -- "$path"
    quiver_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$path"
    printf '%s\n' "$path"
}

quiver_configure() {
    local default_user default_dir answer probe config_dir parsers_dir uploads_dir
    default_user=${SUDO_USER:-$(id -un)}
    probe=${QUIVER_ENV_FILE:-${QUIVER_CONFIG_PROBE:-$SCRIPT_DIR/.env}}
    if [ -f "$probe" ]; then
        answer=$(quiver_privileged python3 "$SCRIPT_DIR/companion_config.py" get "$probe" SERVICE_USER)
        default_user=${answer:-$default_user}
    fi
    read -r -p "Service user [$default_user]: " answer
    SERVICE_USER=${answer:-$default_user}
    id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Create service user '$SERVICE_USER' first." >&2; return 1; }
    SERVICE_GROUP=$(id -gn "$SERVICE_USER")
    SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    default_dir=${QUIVER_INSTALL_DIR:-$SERVICE_HOME/quiver}
    if [ -f "$probe" ]; then
        answer=$(quiver_privileged python3 "$SCRIPT_DIR/companion_config.py" get "$probe" INSTALL_DIR)
        default_dir=${QUIVER_INSTALL_DIR:-${answer:-$default_dir}}
    fi
    read -r -p "Install directory [$default_dir]: " answer
    INSTALL_DIR=${answer:-$default_dir}
    case "$INSTALL_DIR" in '~/'*) INSTALL_DIR="$SERVICE_HOME/${INSTALL_DIR:2}" ;; esac
    INSTALL_DIR=$(quiver_path "$INSTALL_DIR")
    case "$INSTALL_DIR" in /etc|/etc/*|/usr|/usr/*|/bin|/sbin|/lib|/var|/home|/opt|/srv)
        echo "Choose a dedicated companion folder, not a system directory." >&2; return 1 ;;
    esac
    ENV_FILE=$(quiver_path "${QUIVER_ENV_FILE:-$INSTALL_DIR/.env}")
    SYSTEMD_DIR=$(quiver_path "${SYSTEMD_DIR:-/etc/systemd/system}")
    case "$ENV_FILE" in "$INSTALL_DIR"/*|/etc/quiver/*) ;;
        *) echo "Configuration must be inside the chosen install folder or /etc/quiver." >&2; return 1 ;;
    esac
    quiver_privileged mkdir -p -- "$INSTALL_DIR" "$(dirname "$ENV_FILE")"
    if [ "$EUID" -eq 0 ]; then chown root:root "$INSTALL_DIR"; chmod 755 "$INSTALL_DIR"; fi
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
    config_dir=$(quiver_get CONFIG_DIR); config_dir=${config_dir:-$INSTALL_DIR/config}
    parsers_dir=$(quiver_get PARSERS_DIR); parsers_dir=${parsers_dir:-$INSTALL_DIR/parsers}
    uploads_dir=$(quiver_get UPLOAD_DIR); uploads_dir=${uploads_dir:-$INSTALL_DIR/uploads}
    config_dir=$(quiver_data_directory "$config_dir")
    parsers_dir=$(quiver_data_directory "$parsers_dir")
    uploads_dir=$(quiver_data_directory "$uploads_dir")
    quiver_set CONFIG_DIR "$config_dir" PARSERS_DIR "$parsers_dir" UPLOAD_DIR "$uploads_dir"
    echo "Shared configuration: $ENV_FILE"
}
