#!/usr/bin/env bash
# =============================================================================
# Quiver Hub companion bootstrap: the single-command installer.
#
#   curl -fsSL http://<hub-ip>:3000/companion/install.sh | sudo bash -s -- \
#       --hub-url http://<hub-ip>:3000 --drone-id quiver_001 --api-key-prompt
#
# One command on the Raspberry Pi installs (or updates) the whole companion
# suite: nothing is copied over SSH by hand.
#
# Network model: a drone is almost never on the Hub's network. Both are on one
# Tailscale tailnet; the Pi is a tailnet service (HubLink on STREAM_PORT) the
# Hub dials into (pull mode), and the Pi reaches the Hub only for jobs, log
# uploads and the camera registration at the Hub's tailnet address. When the
# Pi has a tailnet identity this script defaults to pull mode, installs HubLink
# and registers the Pi's MagicDNS name with the Hub itself, so nothing has to
# be typed into the Hub UI. --tailscale-authkey joins the tailnet first.
#
# It is designed for a non-virgin Pi:
#   * it never changes network interfaces, DHCP, routes, or Tailscale state;
#   * an existing INSTALL_DIR/.env is kept and only the keys you pass change;
#   * the complete suite is fetched from the Hub itself (or a pinned GitHub
#     commit), verified against a SHA-256 manifest, staged, and only then installed;
#   * every installer runs unattended (prompts take their configured values);
#   * the API key is checked against the Hub before anything is installed.
# Only stdlib Python 3 and bash are needed on the Pi for the bootstrap itself.
# =============================================================================
set -euo pipefail

BOOTSTRAP_VERSION=2
DEFAULT_SERVICES="hub,telemetry,logs-ota"
SUITE_REQUIRED="raspberry_pi_client.py telemetry_forwarder.py logs_ota_service.py siyi_camera_controller.py camera_stream_service.py firmware_puller.lua net_webserver_put.lua install_hub_client.sh install_telemetry_forwarder.sh install_logs_ota.sh install_camera_services.sh installer_common.sh companion_config.py companion-config.example quiver-hub-client.service telemetry-forwarder.service logs-ota.service siyi-camera.service camera-stream.service COMPANION_SERVICES.md OTA_Setup_Guide.md installer_support.py requirements-companion.txt diagnose_companion.sh repair_companion_services.sh update_companion_suite.sh bootstrap_companion.sh hublink_service.py install_hublink.sh"

HUB_URL=""; DRONE_ID=""; API_KEY="${API_KEY:-}"; API_KEY_PROMPT=false; STREAM_PORT_OPT=""
SERVICE_USER=""; INSTALL_DIR=""; SERVICES="$DEFAULT_SERVICES"; SOURCE="hub"
COMPANION_IP=""; declare -a EXTRA_SETTINGS=(); DISABLE_UAVCAN=false; TEST_RUN=false; TEST_SECONDS=30
NO_START=false; DRY_RUN=false; SKIP_HUB_CHECK=false; SKIP_APT=false
MODE="auto"; TS_AUTHKEY="${TS_AUTHKEY:-}"; TS_TAGS="${TS_TAGS:-tag:drone,tag:fleet-quiver}"; TS_HOSTNAME=""; TS_LOGIN_SERVER="${TS_LOGIN_SERVER:-}"
INSTALL_TAILSCALE=false; TS_REJOIN=false

usage() {
    cat <<'USAGE'
Usage: bootstrap_companion.sh [options]

Identity (required on a first install; an existing .env supplies defaults):
  --hub-url URL        Hub base URL as reachable FROM THE PI, e.g. http://<hub-ip-on-drone-subnet>:3000
  --drone-id ID        Drone ID registered on the Hub (Drone Configuration page)
  --api-key KEY        API key for that drone (or export API_KEY=...)
  --api-key-prompt     Read the API key from the terminal (/dev/tty) instead of the command line

Placement:
  --user USER          Service account (default: the sudo login user, or the existing .env)
  --install-dir DIR    Suite folder (default: ~USER/quiver, or the existing .env)
  --companion-ip IP    This Pi's address on the drone subnet (default: existing .env or the suite's COMPANION_IP)
  --set KEY=VALUE      Any other .env setting (repeatable), e.g. --set FC_CONNECTION=tcp

Data plane (how the Hub and this drone exchange telemetry):
  --pull | --push      pull: the Hub dials into HubLink on this Pi over the tailnet (default when the
                       Pi has a Tailscale identity); push: classic companion -> Hub POSTs.
                       Pull installs hublink and registers this Pi's MagicDNS name with the Hub.
  --stream-port N      HubLink port the Hub connects to (default: existing STREAM_PORT or 8765)

Tailscale (never touches an already-connected Pi unless --tailscale-rejoin):
  --tailscale-authkey KEY   Join the tailnet with this auth key (non-ephemeral, single-use, tagged;
                            or TS_AUTHKEY env). Without it an unconnected Pi stays in push mode.
  --tailscale-tags LIST     Tags to advertise (default: tag:drone,tag:fleet-quiver; TS_TAGS env)
  --tailscale-hostname H    Tailnet hostname (default: the drone id with _ -> -)
  --tailscale-login-server URL   Headscale / custom coordination server
  --install-tailscale       Allow installing Tailscale with its official install script if absent
  --tailscale-rejoin        Re-run `tailscale up` with the tags even if already connected

What to install:
  --services LIST      Comma list of hub,telemetry,logs-ota,camera,hublink (default: hub,telemetry,logs-ota;
                       pull mode adds hublink automatically)
  --source hub|URL     Suite source: "hub" (default, from --hub-url) or a GitHub tree URL such as
                       https://github.com/Pan-Robotics/Arrow-Quiver-Hub/tree/<commit>/companion_scripts
  --disable-uavcan     Persist ENABLE_UAVCAN=false (FC-only telemetry) instead of aborting on a missing CAN bus
  --test-run [SECS]    Bench-test telemetry (live FC data + Hub ack) before starting it (default 30 s)
  --no-start           Install and enable nothing; leave services as they are
  --skip-hub-check     Do not verify the API key against the Hub first
  --skip-apt           Do not run apt-get (offline Pi with packages already present)
  --dry-run            Fetch + verify the suite, print the plan, change nothing
  -h, --help           This help

The script never configures network interfaces, DHCP or routes, and changes Tailscale state only
when you pass --tailscale-authkey / --install-tailscale / --tailscale-rejoin.
USAGE
}

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit "${2:-1}"; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --hub-url) HUB_URL=${2:?--hub-url needs a value}; shift ;;
        --drone-id) DRONE_ID=${2:?--drone-id needs a value}; shift ;;
        --api-key) API_KEY=${2:?--api-key needs a value}; shift ;;
        --api-key-prompt) API_KEY_PROMPT=true ;;
        --user) SERVICE_USER=${2:?--user needs a value}; shift ;;
        --install-dir) INSTALL_DIR=${2:?--install-dir needs a value}; shift ;;
        --companion-ip) COMPANION_IP=${2:?--companion-ip needs a value}; shift ;;
        --set) EXTRA_SETTINGS+=("${2:?--set needs KEY=VALUE}"); shift ;;
        --services) SERVICES=${2:?--services needs a list}; shift ;;
        --source) SOURCE=${2:?--source needs hub or a URL}; shift ;;
        --disable-uavcan) DISABLE_UAVCAN=true ;;
        --test-run) TEST_RUN=true; if [ "${2:-}" != "" ] && [[ "${2:-}" =~ ^[0-9]+$ ]]; then TEST_SECONDS=$2; shift; fi ;;
        --no-start) NO_START=true ;;
        --skip-hub-check) SKIP_HUB_CHECK=true ;;
        --skip-apt) SKIP_APT=true ;;
        --dry-run) DRY_RUN=true ;;
        --pull) MODE=pull ;;
        --push) MODE=push ;;
        --stream-port) STREAM_PORT_OPT=${2:?--stream-port needs a value}; shift ;;
        --tailscale-authkey) TS_AUTHKEY=${2:?--tailscale-authkey needs a value}; shift ;;
        --tailscale-tags) TS_TAGS=${2:?--tailscale-tags needs a value}; shift ;;
        --tailscale-hostname) TS_HOSTNAME=${2:?--tailscale-hostname needs a value}; shift ;;
        --tailscale-login-server) TS_LOGIN_SERVER=${2:?--tailscale-login-server needs a value}; shift ;;
        --install-tailscale) INSTALL_TAILSCALE=true ;;
        --tailscale-rejoin) TS_REJOIN=true ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" 2 ;;
    esac
    shift
done

# ---- environment preconditions ---------------------------------------------
[ -n "${BASH_VERSION:-}" ] || die "Run this with bash."
command -v python3 >/dev/null || die "Python 3 is required (apt-get install -y python3)."
command -v systemctl >/dev/null || die "systemd is required; this bootstrap installs systemd services."
if [ "$DRY_RUN" = false ] && [ "$EUID" -ne 0 ]; then
    die "Run as root: curl -fsSL <hub>/companion/install.sh | sudo bash -s -- <options>"
fi

for service in ${SERVICES//,/ }; do
    case "$service" in hub|telemetry|logs-ota|camera|hublink) ;; *) die "Unknown service '$service' in --services (hub,telemetry,logs-ota,camera,hublink)" 2 ;; esac
done
case ",$SERVICES," in *,hub,*) ;; *) SERVICES="hub,$SERVICES"; say "The Hub client suite is always installed first; services: $SERVICES" ;; esac
[ "$TEST_SECONDS" -ge 1 ] && [ "$TEST_SECONDS" -le 300 ] 2>/dev/null || die "--test-run seconds must be 1..300" 2

# ---- locate an existing installation (non-virgin Pi) -----------------------
LOGIN_USER=${SUDO_USER:-$(id -un)}
SERVICE_USER=${SERVICE_USER:-$LOGIN_USER}
id "$SERVICE_USER" >/dev/null 2>&1 || die "Service user '$SERVICE_USER' does not exist on this Pi (create it, or pass --user)."
SERVICE_GROUP=$(id -gn "$SERVICE_USER")
SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$SERVICE_HOME/quiver"
case "$INSTALL_DIR" in /*) ;; *) die "--install-dir must be an absolute path" 2 ;; esac
ENV_FILE="$INSTALL_DIR/.env"
EXISTING_ENV=false
[ -f "$ENV_FILE" ] && EXISTING_ENV=true

# companion_config.py is only available after the suite download; read the
# existing file with the same literal (no shell expansion) rules it uses.
env_get() {
    [ -f "$ENV_FILE" ] || return 0
    python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1:]
value = ""
for line in open(path, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, raw = line.split("=", 1)
    if name.strip() != key:
        continue
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    value = raw
print(value)
PY
}

if [ "$EXISTING_ENV" = true ]; then
    say "Existing companion configuration found: $ENV_FILE (kept; only the keys you pass change)."
    [ -n "$HUB_URL" ] || HUB_URL=$(env_get HUB_URL)
    [ -n "$HUB_URL" ] || HUB_URL=$(env_get WEB_SERVER_URL)
    [ -n "$DRONE_ID" ] || DRONE_ID=$(env_get DRONE_ID)
    [ -n "$API_KEY" ] || API_KEY=$(env_get API_KEY)
fi
if [ "$API_KEY_PROMPT" = true ] || { [ -z "$API_KEY" ] && [ -r /dev/tty ] && [ "$DRY_RUN" = false ]; }; then
    if [ -r /dev/tty ]; then
        printf 'API key for %s (input hidden%s): ' "${DRONE_ID:-this drone}" "$([ -n "$API_KEY" ] && printf ', blank keeps the configured key')" > /dev/tty
        IFS= read -r -s TYPED_KEY < /dev/tty || TYPED_KEY=""
        printf '\n' > /dev/tty
        [ -n "$TYPED_KEY" ] && API_KEY=$TYPED_KEY
    fi
fi
HUB_URL=${HUB_URL%/}
[ -n "$HUB_URL" ] || die "--hub-url is required (the Hub's address as seen from the Pi, e.g. http://<hub-ip-on-drone-subnet>:3000)" 2
[ -n "$DRONE_ID" ] || die "--drone-id is required" 2
if [ "$DRY_RUN" = false ]; then [ -n "$API_KEY" ] || die "--api-key is required (or --api-key-prompt / API_KEY env)" 2; fi

# ---- Hub URL policy: plain HTTP only to a local/private address --------------
HUB_SCHEME=$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(p.scheme)' "$HUB_URL")
HUB_HOST=$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(p.hostname or "")' "$HUB_URL")
[ -n "$HUB_HOST" ] || die "--hub-url must be an absolute URL such as http://<hub-ip>:3000" 2
ALLOW_INSECURE=false
if [ "$HUB_SCHEME" = http ]; then
    if python3 - "$HUB_HOST" <<'PY'
import ipaddress, sys
host = sys.argv[1].lower().rstrip(".")
if host == "localhost" or host.endswith(".ts.net"):
    sys.exit(0)  # loopback, or a MagicDNS name (WireGuard-encrypted)
try:
    a = ipaddress.ip_address(host)
except ValueError:
    sys.exit(1)
ok = a.is_loopback or a.is_link_local or a.is_private or (a.version == 4 and a in ipaddress.ip_network("100.64.0.0/10"))
sys.exit(0 if ok else 1)
PY
    then
        ALLOW_INSECURE=true
        say "Hub $HUB_URL is plain HTTP to a private-network/tailnet address: ALLOW_INSECURE_HUB=true will be set."
    else
        die "Plain HTTP to a public host ($HUB_HOST) is refused. Use https://, or the Hub's tailnet (MagicDNS) or drone-subnet address."
    fi
elif [ "$HUB_SCHEME" != https ]; then
    die "--hub-url must start with http:// or https://" 2
fi

# ---- Tailscale identity (join only when explicitly asked) ----------------------
TS_DNS=""; TS_IPV4=""; TS_STATE="absent"
tailscale_identity() {
    TS_DNS=""; TS_IPV4=""
    command -v tailscale >/dev/null 2>&1 || { TS_STATE="absent"; return 0; }
    if tailscale status >/dev/null 2>&1; then
        TS_STATE="connected"
        TS_DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || true)
        TS_IPV4=$(tailscale ip -4 2>/dev/null | head -1 || true)
    else
        TS_STATE="disconnected"
    fi
}
tailscale_identity
if [ "$DRY_RUN" = false ] && { [ -n "$TS_AUTHKEY" ] || [ "$TS_REJOIN" = true ]; }; then
    if ! command -v tailscale >/dev/null 2>&1; then
        if [ "$INSTALL_TAILSCALE" = true ]; then
            say "Installing Tailscale with its official install script (--install-tailscale)…"
            curl -fsSL https://tailscale.com/install.sh | sh
        else
            die "Tailscale is not installed. Install it from the official signed repository (https://tailscale.com/kb/1031/install-linux) or pass --install-tailscale."
        fi
    fi
    if [ "$TS_STATE" = connected ] && [ "$TS_REJOIN" = false ]; then
        say "Tailscale:     already connected as ${TS_DNS:-$TS_IPV4} (left untouched; --tailscale-rejoin to re-run tailscale up)."
    else
        [ -n "$TS_AUTHKEY" ] || die "--tailscale-rejoin needs --tailscale-authkey (or TS_AUTHKEY)."
        TS_HOST=${TS_HOSTNAME:-$(printf '%s' "$DRONE_ID" | tr '_' '-' | tr -c 'A-Za-z0-9-\n' '-')}
        say "Tailscale:     joining the tailnet as $TS_HOST with tags $TS_TAGS…"
        TS_UP=(--hostname="$TS_HOST" --advertise-tags="$TS_TAGS" --auth-key="$TS_AUTHKEY" --accept-routes=false)
        [ -n "$TS_LOGIN_SERVER" ] && TS_UP+=(--login-server="$TS_LOGIN_SERVER")
        [ "$TS_REJOIN" = true ] && TS_UP+=(--reset)
        tailscale up "${TS_UP[@]}"
        for _ in $(seq 1 15); do tailscale_identity; [ -n "$TS_IPV4" ] && break; sleep 1; done
        [ "$TS_STATE" = connected ] || die "tailscale up did not leave the Pi connected."
        say "Tailscale:     connected as ${TS_DNS:-?} (${TS_IPV4:-no IPv4 yet})."
    fi
fi

# ---- data-plane mode -------------------------------------------------------------
case "$MODE" in
    auto) if [ "$TS_STATE" = connected ]; then MODE=pull; else MODE=push; fi ;;
esac
if [ "$MODE" = pull ]; then
    [ "$TS_STATE" = connected ] || [ "$DRY_RUN" = true ] || die "--pull needs a Tailscale identity on this Pi (connect it, or pass --tailscale-authkey). Use --push for a same-network bench setup."
    case ",$SERVICES," in *,hublink,*) ;; *) SERVICES="$SERVICES,hublink" ;; esac
fi
[ -n "$STREAM_PORT_OPT" ] && EXTRA_SETTINGS+=("STREAM_PORT=$STREAM_PORT_OPT")

# ---- read-only preflight report ---------------------------------------------
say ""
say "== Preflight (read-only) ==  (bootstrap v$BOOTSTRAP_VERSION)"
say "Pi:            $(hostname) ($(uname -m)), $(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" || printf 'unknown OS')"
say "Service user:  $SERVICE_USER ($SERVICE_GROUP), home $SERVICE_HOME"
say "Install dir:   $INSTALL_DIR $([ "$EXISTING_ENV" = true ] && printf '(existing installation)' || printf '(new)')"
say "Hub:           $HUB_URL   drone: $DRONE_ID   services: $SERVICES"
say "Data plane:    $MODE$([ "$MODE" = pull ] && printf ' (Hub dials into HubLink on this Pi at %s)' "${TS_DNS:-$TS_IPV4}" || printf ' (this Pi POSTs to the Hub)')"
if command -v ip >/dev/null; then
    ADDRS=$(ip -4 -o addr show 2>/dev/null | awk '{print $2": "$4}' | tr '\n' ' ')
    say "Addresses:     ${ADDRS:-none}"
fi
case "$TS_STATE" in
    connected) say "Tailscale:     connected as ${TS_DNS:-?} (${TS_IPV4:-no IPv4}); left untouched." ;;
    disconnected) say "Tailscale:     installed, not connected (pass --tailscale-authkey to join; push mode otherwise)." ;;
    *) say "Tailscale:     not installed (push mode on a shared network only; --tailscale-authkey --install-tailscale to join a tailnet)." ;;
esac
for unit in quiver-hub-client telemetry-forwarder logs-ota hublink go2rtc tailscale-funnel siyi-camera camera-stream; do
    if systemctl list-unit-files "$unit.service" 2>/dev/null | grep -q "^$unit.service"; then
        say "Service:       $unit is $(systemctl is-enabled "$unit.service" 2>/dev/null || true)/$(systemctl is-active "$unit.service" 2>/dev/null || true)"
    fi
done

HEALTH=$(python3 - "$HUB_URL" <<'PY' || true
import json, sys, urllib.request
# The Hub is on the local drone subnet/LAN: never route to it through a system proxy.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(urllib.request.Request(sys.argv[1] + "/api/rest/health", headers={"User-Agent": "Quiver-Companion-Bootstrap"}), timeout=10) as r:
        print("ok" if json.loads(r.read()).get("success") else "bad")
except Exception as e:
    print("unreachable: " + str(e)[:120])
PY
)
if [ "$HEALTH" = ok ]; then
    say "Hub health:    reachable."
elif [ "$SOURCE" = hub ]; then
    die "Hub $HUB_URL is $HEALTH. The suite is fetched from the Hub (--source hub); start the Hub, check the address/port and the Pi's route to it, or pass --source <GitHub tree URL>."
else
    warn "Hub $HUB_URL is $HEALTH; continuing because --source is not the Hub."
fi

# The key travels in the environment of one child process, never on a command line.
if [ "$SKIP_HUB_CHECK" = false ] && [ "$DRY_RUN" = false ] && [ "$HEALTH" = ok ]; then
    CHECK=$(QUIVER_BOOTSTRAP_KEY="$API_KEY" python3 - "$HUB_URL" "$DRONE_ID" <<'PY' || true
import json, os, sys, urllib.request
hub, drone = sys.argv[1:]
body = json.dumps({"api_key": os.environ.get("QUIVER_BOOTSTRAP_KEY", ""), "drone_id": drone}).encode()
req = urllib.request.Request(hub + "/api/rest/test-connection", data=body, headers={"Content-Type": "application/json", "User-Agent": "Quiver-Companion-Bootstrap"})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(req, timeout=10) as r:
        print("ok" if json.loads(r.read()).get("success") else "rejected")
except urllib.error.HTTPError as e:
    print("rejected (HTTP %d)" % e.code)
except Exception as e:
    print("error: " + str(e)[:120])
PY
    )
    [ "$CHECK" = ok ] || die "The Hub did not accept this API key for drone '$DRONE_ID' ($CHECK). Generate/copy the key on the Hub's Drone Configuration page."
    say "Hub auth:      API key accepted for $DRONE_ID."
fi

# ---- fetch and verify the complete suite ------------------------------------
STAGING_DIR=$(mktemp -d)
trap 'rm -rf -- "$STAGING_DIR"' EXIT
say ""
say "== Fetching the companion suite =="
if [ "$SOURCE" = hub ]; then SOURCE_URL="$HUB_URL/companion"; else SOURCE_URL="$SOURCE"; fi
python3 - "$SOURCE_URL" "$STAGING_DIR" "$SUITE_REQUIRED" <<'PY'
import hashlib, json, pathlib, sys, urllib.parse, urllib.request

source, destination, required = sys.argv[1:]
required = required.split()
root = pathlib.Path(destination)
SKIP = {".env", "forwarder.env", "go2rtc.yaml", "firmware_puller.param", "companion-suite.manifest.json"}


def read(address, accept=None, direct=False):
    headers = {"User-Agent": "Quiver-Companion-Bootstrap"}
    if accept:
        headers["Accept"] = accept
    # direct=True: the Hub is on the local subnet, so bypass any system proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if direct else urllib.request.build_opener()
    with opener.open(urllib.request.Request(address, headers=headers), timeout=60) as response:
        return response.read()


def safe_relative(name):
    relative = pathlib.PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or any("\\" in p or p in ("", ".") for p in relative.parts):
        raise ValueError("Unsafe suite path: " + name)
    return relative


hashes = {}
url = urllib.parse.urlsplit(source)
try:
    if url.hostname in ("github.com", "raw.githubusercontent.com"):
        # Pinned-commit GitHub tree download (same rules as install_hub_client.sh).
        parts = [urllib.parse.unquote(p) for p in url.path.strip("/").split("/")]
        if url.scheme != "https" or url.query or url.fragment:
            raise ValueError("Use an HTTPS GitHub tree-folder URL without a query or fragment.")
        if url.hostname == "github.com" and len(parts) >= 5 and parts[2] == "tree":
            owner, repo, _, ref, *folder_parts = parts
        elif url.hostname == "raw.githubusercontent.com" and len(parts) >= 4:
            owner, repo, ref, *folder_parts = parts
        else:
            raise ValueError("Expected https://github.com/OWNER/REPO/tree/REF/companion_scripts")
        folder = "/".join(folder_parts)
        base = "https://api.github.com/repos/" + urllib.parse.quote(owner) + "/" + urllib.parse.quote(repo)
        sha = json.loads(read(base + "/commits/" + urllib.parse.quote(ref, safe=""), "application/vnd.github+json"))["sha"]
        tree = json.loads(read(base + "/git/trees/" + sha + "?recursive=1", "application/vnd.github+json"))
        if tree.get("truncated"):
            raise ValueError("Repository tree is truncated.")
        for entry in tree.get("tree", []):
            path = entry.get("path", "")
            if not path.startswith(folder + "/") or entry.get("type") != "blob":
                continue
            if entry.get("mode") == "120000":
                raise ValueError("Symlink source files are not supported: " + path)
            relative = safe_relative(path[len(folder) + 1:])
            if relative.name in SKIP:
                continue
            payload = read("https://raw.githubusercontent.com/" + urllib.parse.quote(owner) + "/" + urllib.parse.quote(repo) + "/" + sha + "/" + urllib.parse.quote(path, safe="/"))
            target = root.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            hashes[str(relative)] = hashlib.sha256(payload).hexdigest()
        origin = {"source": source, "source_commit": sha}
    else:
        # The Hub serves its own copy of the suite plus a SHA-256 manifest.
        manifest = json.loads(read(source.rstrip("/") + "/manifest.json", "application/json", direct=True))
        files = manifest.get("files")
        if not isinstance(files, dict) or not files:
            raise ValueError("The Hub returned an empty suite manifest.")
        for name, meta in files.items():
            relative = safe_relative(name)
            if relative.name in SKIP:
                continue
            expected = meta.get("sha256") if isinstance(meta, dict) else meta
            payload = read(source.rstrip("/") + "/files/" + urllib.parse.quote(str(relative), safe="/"), direct=True)
            digest = hashlib.sha256(payload).hexdigest()
            if digest != expected:
                raise ValueError("SHA-256 mismatch for " + name + " (download corrupted or tampered)")
            target = root.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            hashes[str(relative)] = digest
        origin = {"source": source, "source_commit": manifest.get("source_commit"), "hub_version": manifest.get("hub_version")}
    missing = [name for name in required if not (root / name).is_file()]
    if missing:
        raise ValueError("Suite is missing: " + ", ".join(missing))
    (root / "companion-suite.manifest.json").write_text(json.dumps({**origin, "files": hashes}, indent=2) + "\n")
    print(f"Fetched and verified {len(hashes)} files from {source}")
except Exception as error:
    raise SystemExit(f"Download failed; nothing was installed: {error}")
PY

# The expected companion address comes from the existing .env, --companion-ip, or
# the suite's own template; this script carries no network literals of its own.
WANT_IP=${COMPANION_IP:-$(env_get COMPANION_IP)}
[ -n "$WANT_IP" ] || WANT_IP=$(python3 "$STAGING_DIR/companion_config.py" get "$STAGING_DIR/companion-config.example" COMPANION_IP 2>/dev/null || true)
if command -v ip >/dev/null && [ -n "$WANT_IP" ]; then
    if ip -4 -o addr show 2>/dev/null | grep -q " $WANT_IP/"; then
        say "Companion IP:  $WANT_IP is assigned to this Pi."
    else
        warn "COMPANION_IP $WANT_IP is not assigned to any interface. The FC firmware puller and the Hub expect the Pi there; this installer does NOT change network configuration."
    fi
fi

# ---- plan ---------------------------------------------------------------------
say ""
say "== Plan =="
say "1. Seed $ENV_FILE (HUB_URL, WEB_SERVER_URL, DRONE_ID, API_KEY$([ "$ALLOW_INSECURE" = true ] && printf ', ALLOW_INSECURE_HUB=true')${COMPANION_IP:+, COMPANION_IP=$COMPANION_IP}${EXTRA_SETTINGS[*]:+, ${EXTRA_SETTINGS[*]}})"
say "2. install_hub_client.sh --local   (packages, suite -> $INSTALL_DIR, quiver-hub-client unit)"
case ",$SERVICES," in *,telemetry,*) say "3. install_telemetry_forwarder.sh$([ "$DISABLE_UAVCAN" = true ] && printf ' --disable-uavcan')$([ "$TEST_RUN" = true ] && printf ' --test-run --test-seconds %s' "$TEST_SECONDS")$([ "$NO_START" = true ] && printf ' --no-start')" ;; esac
case ",$SERVICES," in *,logs-ota,*) say "4. install_logs_ota.sh" ;; esac
case ",$SERVICES," in *,camera,*) say "5. install_camera_services.sh   (CAMERA_REGISTRATION=auto: tailnet name if Tailscale is connected, else COMPANION_IP)" ;; esac
case ",$SERVICES," in *,hublink,*) say "6. install_hublink.sh   (pull mode: HubLink on STREAM_PORT; telemetry re-pointed at the local bridge)" ;; esac
[ "$NO_START" = true ] && say "   --no-start: quiver-hub-client will not be enabled/started by this bootstrap."
if [ "$DRY_RUN" = true ]; then
    say ""
    say "--dry-run: suite verified, nothing changed. Manifest:"
    sed -n '1,6p' "$STAGING_DIR/companion-suite.manifest.json"
    exit 0
fi

# ---- seed the shared configuration ----------------------------------------------
say ""
say "== Configuring $ENV_FILE =="
mkdir -p -- "$INSTALL_DIR"
if [ "$EXISTING_ENV" = false ]; then
    python3 "$STAGING_DIR/companion_config.py" init "$ENV_FILE"
fi
SET_ARGS=(HUB_URL "$HUB_URL" WEB_SERVER_URL "$HUB_URL" DRONE_ID "$DRONE_ID" API_KEY "$API_KEY")
[ "$ALLOW_INSECURE" = true ] && SET_ARGS+=(ALLOW_INSECURE_HUB true)
[ -n "$COMPANION_IP" ] && SET_ARGS+=(COMPANION_IP "$COMPANION_IP")
for setting in "${EXTRA_SETTINGS[@]}"; do
    case "$setting" in *=*) SET_ARGS+=("${setting%%=*}" "${setting#*=}") ;; *) die "--set expects KEY=VALUE, got '$setting'" 2 ;; esac
done
SET_ARGS+=(COMPANION_SOURCE_URL "$SOURCE_URL")
python3 "$STAGING_DIR/companion_config.py" set "$ENV_FILE" "${SET_ARGS[@]}"
chown "$SERVICE_USER:$SERVICE_GROUP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
python3 "$STAGING_DIR/companion_config.py" validate "$ENV_FILE"

# ---- run the installers unattended ------------------------------------------------
export QUIVER_NONINTERACTIVE=1 QUIVER_SERVICE_USER="$SERVICE_USER" QUIVER_INSTALL_DIR="$INSTALL_DIR" QUIVER_ENV_FILE="$ENV_FILE" QUIVER_COMPANION_SOURCE="$SOURCE_URL"
if [ "$SKIP_APT" = true ]; then
    # Shadow apt-get for this run only; pip/python package steps still run.
    mkdir -p "$STAGING_DIR/noapt"
    printf '#!/bin/sh\necho "apt-get skipped (--skip-apt): $*"\n' > "$STAGING_DIR/noapt/apt-get"
    chmod 755 "$STAGING_DIR/noapt/apt-get"
    export PATH="$STAGING_DIR/noapt:$PATH"
fi
say ""
say "== [1] Hub client + complete suite =="
bash "$STAGING_DIR/install_hub_client.sh" --local
step=1
if [ "$NO_START" = false ]; then
    systemctl reset-failed quiver-hub-client.service 2>/dev/null || true
    systemctl enable --now quiver-hub-client.service
fi
case ",$SERVICES," in *,telemetry,*)
    step=$((step+1)); say ""; say "== [$step] Telemetry forwarder =="
    TELEMETRY_ARGS=()
    [ "$DISABLE_UAVCAN" = true ] && TELEMETRY_ARGS+=(--disable-uavcan)
    [ "$TEST_RUN" = true ] && TELEMETRY_ARGS+=(--test-run --test-seconds "$TEST_SECONDS")
    [ "$NO_START" = true ] && TELEMETRY_ARGS+=(--no-start)
    bash "$INSTALL_DIR/install_telemetry_forwarder.sh" "${TELEMETRY_ARGS[@]}" ;;
esac
case ",$SERVICES," in *,logs-ota,*)
    step=$((step+1)); say ""; say "== [$step] Logs, diagnostics & OTA =="
    bash "$INSTALL_DIR/install_logs_ota.sh"
    if [ "$NO_START" = true ]; then systemctl disable --now logs-ota.service 2>/dev/null || true; fi ;;
esac
case ",$SERVICES," in *,camera,*)
    step=$((step+1)); say ""; say "== [$step] Camera services =="
    bash "$INSTALL_DIR/install_camera_services.sh" ;;
esac
case ",$SERVICES," in *,hublink,*)
    step=$((step+1)); say ""; say "== [$step] HubLink stream service (pull mode) =="
    HUBLINK_ARGS=()
    [ "$NO_START" = true ] && HUBLINK_ARGS+=(--no-start)
    bash "$INSTALL_DIR/install_hublink.sh" "${HUBLINK_ARGS[@]}" ;;
esac

# ---- pull mode: register this Pi with the Hub (no typing into the Hub UI) ----------
REGISTERED=""
if [ "$MODE" = pull ] && [ "$NO_START" = true ]; then
    warn "--no-start: not registering pull mode with the Hub yet (HubLink is not running). Re-run without --no-start, or set it in Drone Configuration -> Data Plane & Control."
elif [ "$MODE" = pull ]; then
    STREAM_PORT_VALUE=$(python3 "$INSTALL_DIR/companion_config.py" get "$ENV_FILE" STREAM_PORT 2>/dev/null || true)
    STREAM_PORT_VALUE=${STREAM_PORT_VALUE:-8765}
    TAILNET_HOST=${TS_DNS:-$TS_IPV4}
    REGISTERED=$(QUIVER_BOOTSTRAP_KEY="$API_KEY" python3 - "$HUB_URL" "$DRONE_ID" "$TAILNET_HOST" "$STREAM_PORT_VALUE" <<'PY' || true
import json, os, sys, urllib.request
hub, drone, host, port = sys.argv[1:]
body = json.dumps({"api_key": os.environ.get("QUIVER_BOOTSTRAP_KEY", ""), "drone_id": drone, "ingest_mode": "pull", "tailnet_host": host, "stream_port": int(port)}).encode()
req = urllib.request.Request(hub + "/api/rest/drone/connection", data=body, headers={"Content-Type": "application/json", "User-Agent": "Quiver-Companion-Bootstrap"})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(req, timeout=15) as r:
        d = json.loads(r.read())
        print("ok " + (d.get("hub", {}).get("base_url") or "") if d.get("success") else "rejected " + str(d.get("error")))
except urllib.error.HTTPError as e:
    print("rejected (HTTP %d) %s" % (e.code, e.read()[:200].decode(errors="replace")))
except Exception as e:
    print("error " + str(e)[:160])
PY
    )
    case "$REGISTERED" in
        ok*) say "Hub:           registered pull connection for $DRONE_ID -> $TAILNET_HOST:$STREAM_PORT_VALUE (Hub will dial in)." ;;
        *) warn "Could not register the pull connection with the Hub ($REGISTERED). Set it in Drone Configuration -> Data Plane & Control: host $TAILNET_HOST, port $STREAM_PORT_VALUE." ;;
    esac
fi

# ---- summary ---------------------------------------------------------------------
say ""
say "== Done =="
say "Suite:         $INSTALL_DIR  (source $SOURCE_URL)"
say "Configuration: $ENV_FILE"
for unit in quiver-hub-client telemetry-forwarder logs-ota hublink go2rtc tailscale-funnel siyi-camera camera-stream; do
    if systemctl list-unit-files "$unit.service" 2>/dev/null | grep -q "^$unit.service"; then
        say "Service:       $unit is $(systemctl is-enabled "$unit.service" 2>/dev/null || true)/$(systemctl is-active "$unit.service" 2>/dev/null || true)"
    fi
done
if [ "$MODE" = pull ]; then
    say ""
    say "┌─ Connection card (what the Hub uses for this drone) ─────────────"
    say "│ Drone ID:     $DRONE_ID"
    say "│ Mode:         pull  (Hub dials in over the tailnet)"
    say "│ Tailnet host: ${TS_DNS:-?}   (IPv4 ${TS_IPV4:-?})"
    say "│ Stream port:  $STREAM_PORT_VALUE  (HubLink, quiver.stream.v1)"
    say "│ API key:      ${API_KEY:0:6}…(${#API_KEY} chars)   same key the Hub presents to HubLink"
    say "│ Hub:          $HUB_URL$( [ -n "${REGISTERED#ok }" ] && [ "${REGISTERED%% *}" = ok ] && printf ' (drone-facing %s)' "${REGISTERED#ok }")"
    say "└──────────────────────────────────────────────────────────────────"
    say "HubLink health: curl -s http://127.0.0.1:$STREAM_PORT_VALUE/api/rest/health"
fi
say ""
say "Re-run the same command any time to update; .env values you do not pass are kept."
say "Logs: sudo journalctl -u quiver-hub-client -u telemetry-forwarder -u logs-ota -f"
