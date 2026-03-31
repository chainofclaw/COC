#!/usr/bin/env bash
set -euo pipefail

# Emergency containment helper for coc-explorer compromise response.
# This script intentionally keeps explorer offline after containment.

QUARANTINE_BASE="${QUARANTINE_BASE:-/root/quarantine}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
QUARANTINE_DIR="${QUARANTINE_BASE}/coc-explorer-incident-${TIMESTAMP}"
IOC_FILE="${IOC_FILE:-}"
BLOCK_IPS=()

MALICIOUS_PATHS=(
  "/CeuzT0b"
  "/i1LT1A"
  "/RPEiZT"
  "/oHdzPs5h"
  "/BX"
  "/nPtcXf"
  "/tmp/let"
  "/dev/let"
  "/dev/shm/let"
  "/var/let"
  "/etc/let"
  "/let"
)

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

usage() {
  cat <<'EOF'
Usage:
  emergency-isolate-explorer.sh [--ioc-file <path>] [--block-ip <ip>]...

Options:
  --ioc-file <path>    File containing one IOC IP/CIDR per line.
  --block-ip <ip>      Add one IOC IP to outbound block list (repeatable).
  --help               Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ioc-file)
      IOC_FILE="$2"
      shift 2
      ;;
    --block-ip)
      BLOCK_IPS+=("$2")
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

mkdir -p "$QUARANTINE_DIR"
log "Quarantine directory: $QUARANTINE_DIR"

log "Collecting triage artifacts..."
ps -eo pid,ppid,user,cmd --sort=-%cpu > "${QUARANTINE_DIR}/processes.txt" || true
ss -plant > "${QUARANTINE_DIR}/sockets.txt" || true
journalctl --since '2 hours ago' > "${QUARANTINE_DIR}/journal-last-2h.log" || true

log "Stopping explorer services (pm2/systemd/docker) ..."
pm2 stop coc-explorer >/dev/null 2>&1 || true
systemctl stop coc-explorer.service >/dev/null 2>&1 || true
docker stop coc-explorer >/dev/null 2>&1 || true

log "Terminating suspicious miner/downloader process patterns..."
pkill -f 'CeuzT0b|i1LT1A|RPEiZT|oHdzPs5h|/let|xmrig|stratum' >/dev/null 2>&1 || true

log "Quarantining known malicious files..."
for target in "${MALICIOUS_PATHS[@]}"; do
  if [[ -e "$target" || -L "$target" ]]; then
    base="$(basename "$target")"
    destination="${QUARANTINE_DIR}/${base}"
    chmod a-x "$target" >/dev/null 2>&1 || true
    mv "$target" "$destination" >/dev/null 2>&1 || true
    sha256sum "$destination" >> "${QUARANTINE_DIR}/sha256.txt" 2>/dev/null || true
    stat "$destination" >> "${QUARANTINE_DIR}/file-stat.txt" 2>/dev/null || true
    log "Quarantined: $target -> $destination"
  fi
done

log "Creating immutable blocker directories for common drop paths..."
for target in /CeuzT0b /i1LT1A /RPEiZT /oHdzPs5h /BX /nPtcXf; do
  if [[ ! -e "$target" ]]; then
    mkdir -p "$target" || true
  fi
  chattr +i "$target" >/dev/null 2>&1 || true
done

if [[ -n "$IOC_FILE" && -f "$IOC_FILE" ]]; then
  while IFS= read -r entry; do
    entry="${entry%%#*}"
    entry="${entry//[$'\t\r\n ']}"
    [[ -z "$entry" ]] && continue
    BLOCK_IPS+=("$entry")
  done < "$IOC_FILE"
fi

if [[ "${#BLOCK_IPS[@]}" -gt 0 ]]; then
  log "Applying temporary outbound deny rules for IOC IPs..."
  for ip in "${BLOCK_IPS[@]}"; do
    if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$ ]]; then
      log "Skipping non-IP IOC entry: $ip"
      continue
    fi
    iptables -C OUTPUT -d "$ip" -j REJECT >/dev/null 2>&1 || iptables -I OUTPUT -d "$ip" -j REJECT
  done
fi

log "Containment complete. explorer remains offline by design."
log "Artifacts saved to $QUARANTINE_DIR"
