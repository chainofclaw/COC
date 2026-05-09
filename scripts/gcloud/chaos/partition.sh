#!/usr/bin/env bash
# chaos/partition.sh — Inject an iptables-level partition between two groups
# of gcloud VMs. Drops both directions of TCP traffic on COC ports.
#
# This isolates one half of the cluster from the other while keeping local
# services healthy (RPC/SSH stay reachable from the operator). Run repair() to
# restore connectivity.
#
# Usage:
#   bash partition.sh apply  burst-1,burst-2  vs  anchor-1,anchor-2,burst-3
#   bash partition.sh repair burst-1,burst-2,anchor-1,anchor-2,burst-3
#
# Notes:
# - The "vs" literal between groups is required for clarity.
# - Repair is idempotent and removes coc-chaos rules from every named host.
# - Side A is what blocks Side B, and Side B is what blocks Side A.
# - Implemented with iptables -I INPUT and OUTPUT in chain "coc-chaos".

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"
require_gcloud

CHAIN_NAME="coc-chaos"
COC_PORTS=(28780 28781 29780 29781 28786)

apply_chain_install() {
  # Idempotent install of an iptables chain that we use to block COC traffic.
  cat <<'BASH'
set -e
sudo iptables -t filter -N coc-chaos 2>/dev/null || true
# Make sure INPUT and OUTPUT jump to coc-chaos at the top exactly once.
sudo iptables -C INPUT  -j coc-chaos 2>/dev/null || sudo iptables -I INPUT  -j coc-chaos
sudo iptables -C OUTPUT -j coc-chaos 2>/dev/null || sudo iptables -I OUTPUT -j coc-chaos
sudo iptables -F coc-chaos
BASH
}

apply_block_rules_for() {
  local target_ips_csv="$1"  # comma-separated IPs to block
  local ports_csv="$2"
  cat <<EOF
set -e
IFS=',' read -ra TARGETS <<< "$target_ips_csv"
IFS=',' read -ra PORTS <<< "$ports_csv"
for ip in "\${TARGETS[@]}"; do
  for p in "\${PORTS[@]}"; do
    sudo iptables -A coc-chaos -p tcp -d "\$ip" --dport "\$p" -j DROP
    sudo iptables -A coc-chaos -p tcp -s "\$ip" --sport "\$p" -j DROP
  done
done
echo "applied $(sudo iptables -L coc-chaos -n | wc -l) rules"
EOF
}

repair_chain() {
  cat <<'BASH'
set -e
sudo iptables -F coc-chaos 2>/dev/null || true
echo "coc-chaos chain flushed"
BASH
}

resolve_ip() {
  local node="$1" zone
  zone="$(resolve_zone "$node")"
  gcloud compute instances describe "$node" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
}

ssh_run() {
  local node="$1" cmd="$2" zone
  zone="$(resolve_zone "$node")"
  gcloud compute ssh "$node" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --quiet --command="$cmd"
}

cmd="${1:-}"
case "$cmd" in
  apply)
    GROUP_A="${2:-}"; SEP="${3:-}"; GROUP_B="${4:-}"
    if [[ "$SEP" != "vs" || -z "$GROUP_A" || -z "$GROUP_B" ]]; then
      echo "usage: $0 apply <group-a-csv> vs <group-b-csv>" >&2
      echo "   ex: $0 apply burst-1,burst-2 vs anchor-1,anchor-2,burst-3" >&2
      exit 2
    fi
    IFS=',' read -ra A_NODES <<< "$GROUP_A"
    IFS=',' read -ra B_NODES <<< "$GROUP_B"

    # Resolve IPs once
    declare -A IP
    for n in "${A_NODES[@]}" "${B_NODES[@]}"; do
      IP[$n]=$(resolve_ip "$n")
      echo "  $n -> ${IP[$n]}"
    done

    A_IPS=$(IFS=','; for n in "${A_NODES[@]}"; do printf "%s," "${IP[$n]}"; done | sed 's/,$//')
    B_IPS=$(IFS=','; for n in "${B_NODES[@]}"; do printf "%s," "${IP[$n]}"; done | sed 's/,$//')
    PORTS_CSV=$(IFS=','; printf "%s," "${COC_PORTS[@]}" | sed 's/,$//')

    echo "==> Installing chain on group-a nodes (block group-b traffic)"
    for n in "${A_NODES[@]}"; do
      ssh_run "$n" "$(apply_chain_install; apply_block_rules_for "$B_IPS" "$PORTS_CSV")"
    done
    echo "==> Installing chain on group-b nodes (block group-a traffic)"
    for n in "${B_NODES[@]}"; do
      ssh_run "$n" "$(apply_chain_install; apply_block_rules_for "$A_IPS" "$PORTS_CSV")"
    done
    echo "==> Partition active. Verify with: ssh <node> sudo iptables -L coc-chaos -n"
    ;;
  repair)
    NODES_CSV="${2:-}"
    if [[ -z "$NODES_CSV" ]]; then
      echo "usage: $0 repair <nodes-csv>" >&2; exit 2
    fi
    IFS=',' read -ra NODES <<< "$NODES_CSV"
    for n in "${NODES[@]}"; do
      echo "  flushing $n"
      ssh_run "$n" "$(repair_chain)"
    done
    echo "==> Repaired. BFT/wire/IPFS connectivity restored."
    ;;
  *)
    echo "usage: $0 {apply|repair} ..." >&2; exit 2 ;;
esac
