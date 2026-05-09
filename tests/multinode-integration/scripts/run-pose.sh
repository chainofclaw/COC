#!/usr/bin/env bash
# R2.1 Phase A — orchestrate the full PoSe-on-fork-off lifecycle:
#   1. bring up the H15 fixture (5 BFT validators, chainId 88888)
#   2. deploy ValidatorRegistry + PoSeManagerV2 + InsuranceFund + EquivocationDetector
#   3. stake 5 validators (anvil 0..4)
#   4. patch agent-config.json + relayer-config.json with deployed addresses
#   5. bring up coc-agent + coc-relayer sidecars
#   6. run 05-pose-epoch-sanity scenario
#   7. tear down on success (leave running on failure)
#
# Total runtime ~5-7 min the first time (docker build cached after R1.4 run).
#
# Usage:
#   bash scripts/run-pose.sh            # full lifecycle
#   bash scripts/run-pose.sh up         # bring up + deploy + sidecars (no test)
#   bash scripts/run-pose.sh deploy     # only run deploy-pose-on-h15.mjs
#   bash scripts/run-pose.sh test-only  # run scenario (assumes everything up)
#   bash scripts/run-pose.sh down       # tear down + delete volumes

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/.."
DEPLOYED_PATH="$FIXTURE_DIR/configs-h15/deployed-pose.json"

up() {
  echo "==> [1/3] Building + starting H15 fixture (chainId 88888)"
  docker compose -f "$FIXTURE_DIR/docker-compose-h15.yml" up -d --build
  echo "==> Waiting for all 5 validators to reach block ≥10"
  TARGET=10 MAX_WAIT_S=300 bash "$SCRIPT_DIR/wait-ready-h15.sh"

  echo "==> [2/3] Deploying PoSe contract suite to fork-off chain"
  cd "$FIXTURE_DIR/.." && cd ..  # reach contracts/ workspace root
  cd /passinger/projects/ClawdBot/COC/contracts
  node "$SCRIPT_DIR/deploy-pose-on-h15.mjs"
  cd "$FIXTURE_DIR"

  echo "==> [3/3] Patching agent + relayer configs with deployed addresses"
  patch_config "$FIXTURE_DIR/configs-h15/agent-config.json" \
    "poseManagerAddress" \
    "$(jq -r '.contracts.PoSeManagerV2.address' "$DEPLOYED_PATH")"
  patch_config "$FIXTURE_DIR/configs-h15/agent-config.json" \
    "cidRegistryAddress" \
    "$(jq -r '.contracts.CidRegistry.address' "$DEPLOYED_PATH")"
  patch_config "$FIXTURE_DIR/configs-h15/relayer-config.json" \
    "poseManagerAddress" \
    "$(jq -r '.contracts.PoSeManagerV2.address' "$DEPLOYED_PATH")"
  patch_config "$FIXTURE_DIR/configs-h15/relayer-config.json" \
    "equivocationDetectorAddress" \
    "$(jq -r '.contracts.EquivocationDetector.address' "$DEPLOYED_PATH")"
  patch_config "$FIXTURE_DIR/configs-h15/relayer-config.json" \
    "validatorRegistryAddress" \
    "$(jq -r '.contracts.ValidatorRegistry.address' "$DEPLOYED_PATH")"

  echo "==> Bringing up sidecars (coc-agent + coc-relayer)"
  docker compose \
    -f "$FIXTURE_DIR/docker-compose-h15.yml" \
    -f "$FIXTURE_DIR/docker-compose-pose.yml" \
    up -d --build
  echo "==> Waiting 30 s for sidecars to start a tick"
  sleep 30
}

patch_config() {
  local file="$1" key="$2" value="$3"
  local tmp
  tmp=$(mktemp)
  jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  $file: $key=$value"
}

deploy() {
  cd /passinger/projects/ClawdBot/COC/contracts
  node "$SCRIPT_DIR/deploy-pose-on-h15.mjs"
}

down() {
  echo "==> Tearing down PoSe + H15 fixtures"
  docker compose \
    -f "$FIXTURE_DIR/docker-compose-h15.yml" \
    -f "$FIXTURE_DIR/docker-compose-pose.yml" \
    down -v
  echo "  removing deployed-pose.json"
  rm -f "$DEPLOYED_PATH"
}

test_only() {
  echo "==> Running 05-pose-epoch-sanity scenario"
  cd "$FIXTURE_DIR"
  node --experimental-strip-types --test scenarios/05-pose-epoch-sanity.test.ts
}

ACTION="${1:-all}"
case "$ACTION" in
  up)        up ;;
  deploy)    deploy ;;
  test-only) test_only ;;
  down)      down ;;
  all)
    up
    if test_only; then
      down
    else
      echo "==> Test FAILED — leaving fixture up for inspection."
      echo "    docker logs coc-h15-agent | tail -100"
      echo "    docker logs coc-h15-relayer | tail -100"
      echo "    bash $SCRIPT_DIR/run-pose.sh down  # to clean up"
      exit 1
    fi
    ;;
  *) echo "usage: $0 [up|deploy|test-only|down|all]" >&2; exit 2 ;;
esac
