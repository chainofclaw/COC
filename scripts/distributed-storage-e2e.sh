#!/usr/bin/env bash
# Phase C4.1 — distributed-storage end-to-end smoke test.
#
# Validates the C1+C3 pipeline end-to-end in a 3-node devnet:
#   1. PUT a file into node-1's IPFS HTTP gateway.
#   2. Assert ≥ 2 distinct DHT providers claim the root CID after
#      C1.4's push-to-K fans out + C3.1's replication wait.
#   3. Kill node-1 (the uploader / origin).
#   4. GET the file from node-2 and diff the bytes against the upload.
#      The read path goes through C1.3's blockstore fetchRemote
#      fallback — node-2 didn't originate the CID, so the bytes must
#      come from the C1.4 push replica stored on node-2 or from
#      node-3 via wire BlockRequest.
#
# Exits 0 on success, non-zero on any assertion failure. Designed to
# be runnable as a pre-merge check and inside CI.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES=3
RUN_DIR="${ROOT}/.run/devnet-${NODES}"
BASE_RPC=28780
BASE_IPFS=28800

NODE1_IPFS="http://127.0.0.1:$((BASE_IPFS + 0))"
NODE2_IPFS="http://127.0.0.1:$((BASE_IPFS + 1))"
NODE1_RPC="http://127.0.0.1:$((BASE_RPC + 0))"
NODE2_RPC="http://127.0.0.1:$((BASE_RPC + 1))"

# Keep a manifest of everything we spawned so teardown cleans up even
# on early failure (bash `trap` fires on error/interrupt, not just exit).
TEMP_DIR="$(mktemp -d -t coc-c4-XXXX)"
trap 'teardown' EXIT INT TERM

teardown() {
  local code=$?
  echo "--- teardown (exit=${code}) ---"
  bash "${ROOT}/scripts/stop-devnet.sh" "${NODES}" >/dev/null 2>&1 || true
  rm -rf "${TEMP_DIR}"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

# ---- Step 0: start devnet ----
echo "--- starting ${NODES}-node devnet ---"
bash "${ROOT}/scripts/start-devnet.sh" "${NODES}" >/dev/null 2>&1 || fail "devnet start"

# Give the DHT a beat to exchange routing tables. start-devnet.sh only
# waits for RPC readiness, not DHT convergence — the push-to-K path
# needs peers in the routing table to work.
sleep 5

# ---- Step 1: upload ----
echo "--- uploading test file to node-1 ---"
CONTENT_FILE="${TEMP_DIR}/input.bin"
# ~256 KiB of deterministic pseudo-random data — big enough that
# UnixFS chunks into > 1 block so we exercise the DAG-PB path, but
# small enough that the upload is quick.
head -c 262144 /dev/urandom > "${CONTENT_FILE}"
EXPECTED_HASH="$(sha256sum "${CONTENT_FILE}" | cut -d' ' -f1)"

UPLOAD_RES="$(curl -X POST -sf "${NODE1_IPFS}/api/v0/add" \
  -F "file=@${CONTENT_FILE};filename=test.bin" 2>&1)" || fail "upload to node-1 (${UPLOAD_RES})"

CID="$(echo "${UPLOAD_RES}" | grep -oE '"Hash":"[^"]+"' | head -1 | sed 's/"Hash":"\([^"]*\)"/\1/')"
[[ -n "${CID}" ]] || fail "no CID in upload response: ${UPLOAD_RES}"
pass "uploaded, cid=${CID}"

# ---- Step 2: assert replication ----
# Give pushToK a moment to complete its fan-out. PUT handler already
# waits up to 8s per-chunk for replication, but DHT provider records
# from remote pushes need a tick to settle.
sleep 2

echo "--- checking provider count via node-2's coc_dhtFindProviders ---"
PROVIDERS_RES="$(curl -sf -X POST "${NODE2_RPC}" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"coc_dhtFindProviders\",\"params\":[\"${CID}\",10]}")" \
  || fail "coc_dhtFindProviders rpc"

# Provider list format: {"result": ["peerId1", "peerId2", ...]}
PROVIDER_COUNT="$(echo "${PROVIDERS_RES}" | grep -oE '\[[^]]*\]' | head -1 | tr ',' '\n' | wc -l)"
[[ "${PROVIDER_COUNT}" -ge 2 ]] \
  || fail "expected ≥ 2 providers after push-to-K, got ${PROVIDER_COUNT} (resp=${PROVIDERS_RES})"
pass "≥ 2 providers claim cid=${CID} from node-2's DHT perspective"

# ---- Step 3: kill node-1 ----
echo "--- killing node-1 (origin) ---"
NODE1_PID="$(cat "${RUN_DIR}/node-1.pid")"
kill "${NODE1_PID}" || fail "failed to signal node-1"
# Wait for it to actually exit so subsequent fetches can't be served
# by the dying process's in-flight sockets.
for _ in $(seq 1 50); do
  kill -0 "${NODE1_PID}" 2>/dev/null || break
  sleep 0.1
done
kill -0 "${NODE1_PID}" 2>/dev/null && fail "node-1 didn't exit within 5s"
pass "node-1 (pid ${NODE1_PID}) stopped"

# Small grace so node-2's connection manager notices node-1 is gone.
sleep 2

# ---- Step 4: retrieve from node-2, diff ----
echo "--- fetching ${CID} from node-2 (should go through peer fetch fallback) ---"
OUT_FILE="${TEMP_DIR}/out.bin"
# First try /api/v0/cat since that's the official IPFS path; fall back
# to gateway /ipfs/<cid> if the HTTP API variant isn't wired up on the
# devnet config.
curl -X POST -sf "${NODE2_IPFS}/api/v0/cat?arg=${CID}" -o "${OUT_FILE}" \
  || curl -sf "${NODE2_IPFS}/ipfs/${CID}" -o "${OUT_FILE}" \
  || fail "GET from node-2 failed — did C1.3 fetchRemote fallback land a cached chunk?"

ACTUAL_HASH="$(sha256sum "${OUT_FILE}" | cut -d' ' -f1)"
[[ "${ACTUAL_HASH}" == "${EXPECTED_HASH}" ]] \
  || fail "content hash mismatch (want ${EXPECTED_HASH}, got ${ACTUAL_HASH})"
pass "fetched identical bytes from node-2 after origin death"

echo "--- Phase C4.1 distributed-storage-e2e OK ---"
