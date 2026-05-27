#!/usr/bin/env bash
#
# Faucet balance probe for Prometheus textfile collector.
#
# Curls the faucet's /faucet/status, parses the JSON `balance` (ether),
# and writes a node_exporter textfile metric for the FaucetBalanceLow /
# FaucetBalanceCritical / FaucetProbeStale alerts in
# ops/alerts/prometheus-rules.yml.
#
# Install:
#   sudo cp scripts/faucet-balance-check.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/faucet-balance-check.sh
#   # Then a root cron, every 5 min:
#   echo '*/5 * * * * root /usr/local/bin/faucet-balance-check.sh' \
#     | sudo tee /etc/cron.d/coc-faucet-balance-check
#
# Requirements on the host:
#   - curl, jq
#   - node_exporter running with --collector.textfile.directory=<TEXTFILE_DIR>
#     (default /var/lib/node_exporter/textfile_collector)
#
# Env knobs (defaults shown):
#   FAUCET_URL=https://faucet.chainofclaw.io
#   TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector

set -euo pipefail

FAUCET_URL="${FAUCET_URL:-https://faucet.chainofclaw.io}"
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
OUT="${TEXTFILE_DIR}/coc_faucet_balance.prom"
TMP="${OUT}.$$"

mkdir -p "$TEXTFILE_DIR"

now=$(date +%s)

# /faucet/status returns {"address":"0x…", "balance":"<eth>", "totalDrips":N, …}
# Use --max-time 8 so a hung faucet doesn't wedge the cron.
status_json=$(curl --max-time 8 -sf "${FAUCET_URL}/faucet/status" 2>/dev/null || echo "")

if [ -z "$status_json" ]; then
  # Probe failed — emit a stale-marker by NOT updating the metric file.
  # FaucetProbeStale alert will fire from time() - timestamp > 1800.
  # But we still want to capture *that* the probe failed for ops to see —
  # use the up{} pattern: 0 = failed, 1 = OK.
  cat > "$TMP" <<EOF
# HELP coc_faucet_probe_up Whether the faucet balance probe succeeded.
# TYPE coc_faucet_probe_up gauge
coc_faucet_probe_up 0
EOF
  mv "$TMP" "$OUT"
  exit 1
fi

balance=$(echo "$status_json" | jq -r '.balance // empty')

if [ -z "$balance" ]; then
  echo "faucet-balance-check: no balance field in /faucet/status response" >&2
  exit 1
fi

cat > "$TMP" <<EOF
# HELP coc_faucet_balance_eth Faucet wallet balance in COC (ether-denominated).
# TYPE coc_faucet_balance_eth gauge
coc_faucet_balance_eth $balance
# HELP coc_faucet_balance_check_timestamp_seconds Unix timestamp of the last successful balance check.
# TYPE coc_faucet_balance_check_timestamp_seconds gauge
coc_faucet_balance_check_timestamp_seconds $now
# HELP coc_faucet_probe_up Whether the faucet balance probe succeeded.
# TYPE coc_faucet_probe_up gauge
coc_faucet_probe_up 1
EOF
mv "$TMP" "$OUT"
