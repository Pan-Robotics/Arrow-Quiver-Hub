#!/usr/bin/env bash
#
# setup-drone-tailscale.sh — put a Quiver companion computer (Raspberry Pi) on
# the tailnet as a tagged node so Hubs can pull from it over 4G/anywhere.
#
# Safe on a non-virgin Pi: if Tailscale is already installed and connected this
# script REPORTS the current state and exits 0 without touching it, unless you
# pass --rejoin (which re-runs `tailscale up` with the fleet tags and the key).
# It never installs Tailscale by piping a remote script into a root shell; use
# the official signed OS repository (https://tailscale.com/kb/1031/install-linux).
#
# The auth key should be an EPHEMERAL, PRE-AUTHORISED, TAGGED key (or minted by
# a Tailscale OAuth client) so the fleet onboards with zero manual approval and
# stale drones drop off the device list automatically.
#
# Usage:
#   sudo ./setup-drone-tailscale.sh --fleet acme --drone-id quiver-001 --authkey tskey-xxxx
#   sudo ./setup-drone-tailscale.sh --status          # read-only report
#
set -euo pipefail

FLEET=""
DRONE_ID=""
AUTHKEY="${TS_AUTHKEY:-}"
REJOIN=false
STATUS_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fleet)    FLEET="$2"; shift 2 ;;
    --drone-id) DRONE_ID="$2"; shift 2 ;;
    --authkey)  AUTHKEY="$2"; shift 2 ;;
    --rejoin)   REJOIN=true; shift ;;
    --status)   STATUS_ONLY=true; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

report() {
  local dnsname ip
  dnsname="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')"
  ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  echo "[tailscale] connected as ${dnsname:-<no MagicDNS name yet>} (${ip:-no IPv4})"
  echo "[tailscale] tags: $(tailscale status --json 2>/dev/null | sed -n 's/.*"Tags": *\[\([^]]*\)\].*/\1/p' | head -1 | tr -d '"' || true)"
  echo
  echo "Register this drone on the Hub (Drone Configuration -> Data Plane & Control):"
  echo "  mode: pull    tailnet host: ${dnsname:-<MagicDNS name>}    stream port: 8765 (HubLink)"
  echo "  camera (go2rtc WHEP) registers itself at http://${dnsname:-<MagicDNS name>}:1984 when CAMERA_REGISTRATION=auto|tailnet"
}

if ! command -v tailscale >/dev/null 2>&1; then
  echo "ERROR: Tailscale is not installed. Install it from the official signed repository first:" >&2
  echo "       https://tailscale.com/kb/1031/install-linux   (then rerun this script)" >&2
  exit 1
fi

if tailscale status >/dev/null 2>&1; then
  echo "[tailscale] already connected on this Pi (left untouched)."
  report
  if [[ "$STATUS_ONLY" == true || "$REJOIN" == false ]]; then
    [[ "$REJOIN" == false && "$STATUS_ONLY" == false ]] && echo "(pass --rejoin to re-run 'tailscale up' with fleet tags)"
    exit 0
  fi
elif [[ "$STATUS_ONLY" == true ]]; then
  echo "[tailscale] installed but not connected."
  exit 0
fi

[[ -z "$FLEET"    ]] && { echo "ERROR: --fleet <name> is required (tag:fleet-<name>)." >&2; exit 1; }
[[ -z "$DRONE_ID" ]] && { echo "ERROR: --drone-id <id> is required (used as hostname)." >&2; exit 1; }
[[ -z "$AUTHKEY"  ]] && { echo "ERROR: --authkey (ephemeral, tagged) is required (or TS_AUTHKEY)." >&2; exit 1; }

TAGS="tag:drone,tag:fleet-${FLEET}"
echo "[tailscale] joining tailnet as ${DRONE_ID} with tags: ${TAGS}"
tailscale up --advertise-tags="${TAGS}" --hostname="${DRONE_ID}" --authkey="${AUTHKEY}"
report
