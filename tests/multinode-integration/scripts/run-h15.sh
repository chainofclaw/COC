#!/usr/bin/env bash
# R1.4 — convenience wrapper to bring up the H15 fork-off devnet, run the
# 04-h15-fallback scenario, and tear down. Total runtime ~13-15 min.
#
# Usage:
#   bash scripts/run-h15.sh             # full lifecycle
#   bash scripts/run-h15.sh up          # just bring up + wait ready
#   bash scripts/run-h15.sh down        # tear down + delete volumes
#   bash scripts/run-h15.sh test-only   # assume already up, run scenario
#
# Logs are kept on failure so you can inspect with `docker logs <container>`.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/.."
COMPOSE_FILE="$FIXTURE_DIR/docker-compose-h15.yml"

ACTION="${1:-all}"

up() {
  echo "==> Building + starting H15 fixture (chainId 88888, 5 validators)"
  cd "$FIXTURE_DIR"
  docker compose -f "$COMPOSE_FILE" up -d --build
  echo "==> Waiting for all 5 to reach block ≥10"
  TARGET=10 MAX_WAIT_S=300 bash "$SCRIPT_DIR/wait-ready-h15.sh"
}

down() {
  echo "==> Tearing down H15 fixture"
  cd "$FIXTURE_DIR"
  docker compose -f "$COMPOSE_FILE" down -v
}

test_only() {
  echo "==> Running 04-h15-fallback scenario (~12 min)"
  cd "$FIXTURE_DIR"
  node --experimental-strip-types --test scenarios/04-h15-fallback.test.ts
}

case "$ACTION" in
  up)        up ;;
  down)      down ;;
  test-only) test_only ;;
  all)
    up
    if test_only; then
      down
    else
      echo "==> Test FAILED — leaving fixture up for inspection."
      echo "    docker logs coc-h15-node-1   # …"
      echo "    bash $SCRIPT_DIR/run-h15.sh down  # to clean up"
      exit 1
    fi
    ;;
  *) echo "usage: $0 [up|down|test-only|all]" >&2; exit 2 ;;
esac
