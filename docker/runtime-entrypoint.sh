#!/bin/sh
# Runtime entrypoint: idempotent volume permission fix + drop to non-root.
#
# Why this exists: docker-compose `runtime-data:/data/coc/runtime` mounts an
# empty named volume on first creation. The volume root is owned by uid 0
# (docker daemon's), so the agent process (uid 999, coc:coc) gets EACCES
# when trying to write reward-manifests/, storage/, agent-metrics.json,
# etc. The Dockerfile's `chown -R coc:coc /data/coc` only affects the image
# layer, not the mounted volume. Chowning at startup as root + then
# dropping privilege via `su` is portable across debian/alpine and works
# for both fresh and existing volumes.
#
# Observed symptoms before this fix (2026-04-26 testnet):
#   - "reward manifest write failed (non-fatal): EACCES, mkdir
#      '/data/coc/runtime/reward-manifests'" every tick
#   - relayer skipping finalize forever because agent couldn't write
#      manifest → not_found
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/coc/runtime/reward-manifests /data/coc/runtime/storage 2>/dev/null || true
  chown -R coc:coc /data/coc 2>/dev/null || true
  exec su -s /bin/sh -c 'exec "$@"' coc -- _ "$@"
fi

exec "$@"
