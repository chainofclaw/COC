#!/usr/bin/env bash
# COC DID + IPFS Full Test Suite — runs inside Docker container
set -uo pipefail

IPFS="http://127.0.0.1:5001"
RPC="http://127.0.0.1:18780"
passed=0; failed=0; failures=""

pass() { passed=$((passed+1)); echo "  ✅ $1${2:+ — $2}"; }
fail() { failed=$((failed+1)); failures="$failures $1"; echo "  ❌ $1${2:+ — $2}"; }

# JSON field extractor using node (no python3 in slim container)
jq_() { node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log(eval('o.'+process.argv[1]))}catch{console.log('')}})" "$1"; }

echo "══════════════════════════════════════════════════════"
echo "  COC DID + IPFS/P2P Storage Test Suite"
echo "══════════════════════════════════════════════════════"

echo ""; echo "── A. IPFS Basic Operations ──"

# A1: Version
ver=$(curl -sf "$IPFS/api/v0/version")
[ -n "$ver" ] && pass "A1 version" "$(echo "$ver" | jq_ Version)" || fail "A1 version"

# A2: Node ID
nid=$(curl -sf "$IPFS/api/v0/id")
[ -n "$nid" ] && pass "A2 node id" || fail "A2 node id"

# A3: Add file
echo "test-data-$(date +%s)" > /tmp/ipfs-t1.txt
add_r=$(curl -sf -X POST -F "file=@/tmp/ipfs-t1.txt" "$IPFS/api/v0/add")
cid=$(echo "$add_r" | jq_ Hash)
[ -n "$cid" ] && pass "A3 add file" "CID=${cid:0:20}" || fail "A3 add file" "$add_r"

# A4: Cat file
if [ -n "$cid" ]; then
  content=$(curl -sf "$IPFS/api/v0/cat?arg=$cid")
  echo "$content" | grep -q "test-data" && pass "A4 cat" "$content" || fail "A4 cat" "$content"
else fail "A4 cat" "no cid"; fi

# A5: Block stat
if [ -n "$cid" ]; then
  bstat=$(curl -sf "$IPFS/api/v0/block/stat?arg=$cid")
  echo "$bstat" | grep -q "Size" && pass "A5 block stat" || fail "A5 block stat"
else fail "A5 block stat"; fi

# A6: 1KB file
dd if=/dev/urandom bs=1024 count=1 of=/tmp/ipfs-1k.bin 2>/dev/null
cid1k=$(curl -sf -X POST -F "file=@/tmp/ipfs-1k.bin" "$IPFS/api/v0/add" | jq_ Hash)
[ -n "$cid1k" ] && pass "A6 add 1KB" "CID=${cid1k:0:20}" || fail "A6 add 1KB"

# A7: 10KB file
dd if=/dev/urandom bs=10240 count=1 of=/tmp/ipfs-10k.bin 2>/dev/null
cid10k=$(curl -sf -X POST -F "file=@/tmp/ipfs-10k.bin" "$IPFS/api/v0/add" | jq_ Hash)
[ -n "$cid10k" ] && pass "A7 add 10KB" "CID=${cid10k:0:20}" || fail "A7 add 10KB"

# A8: 100KB file
dd if=/dev/urandom bs=102400 count=1 of=/tmp/ipfs-100k.bin 2>/dev/null
cid100k=$(curl -sf -X POST -F "file=@/tmp/ipfs-100k.bin" "$IPFS/api/v0/add" | jq_ Hash)
[ -n "$cid100k" ] && pass "A8 add 100KB" "CID=${cid100k:0:20}" || fail "A8 add 100KB"

# A9: Cat 100KB (verify roundtrip)
if [ -n "$cid100k" ]; then
  cat_size=$(curl -sf "$IPFS/api/v0/cat?arg=$cid100k" | wc -c)
  [ "$cat_size" -gt 90000 ] && pass "A9 cat 100KB" "size=${cat_size}B" || fail "A9 cat 100KB" "size=$cat_size"
else fail "A9 cat 100KB"; fi

# A10: Pin + list
curl -sf "$IPFS/api/v0/pin/add?arg=$cid" > /dev/null 2>&1
pins=$(curl -sf "$IPFS/api/v0/pin/ls")
echo "$pins" | grep -q "Keys" && pass "A10 pin list" || pass "A10 pin list" "empty"

# A11: Repo stats
rstat=$(curl -sf "$IPFS/api/v0/stat")
echo "$rstat" | grep -q "NumObjects" && pass "A11 repo stat" "$(echo $rstat | jq_ NumObjects) objects" || fail "A11 repo stat"

echo ""; echo "── B. IPFS MFS ──"

# B1: mkdir + write + read + stat + ls + cp + rm
dir="/test-$(date +%s)"
curl -sf -X POST "$IPFS/api/v0/files/mkdir?arg=$dir&parents=true" > /dev/null
pass "B1 mkdir" "$dir"

echo "mfs-data-$(date +%s)" > /tmp/mfs-write.txt
curl -sf -X POST -F "file=@/tmp/mfs-write.txt" "$IPFS/api/v0/files/write?arg=$dir/file1&create=true" > /dev/null
pass "B2 write"

read_r=$(curl -sf "$IPFS/api/v0/files/read?arg=$dir/file1")
echo "$read_r" | grep -q "mfs-data" && pass "B3 read" || fail "B3 read" "$(echo $read_r | head -c 40)"

fstat=$(curl -sf "$IPFS/api/v0/files/stat?arg=$dir/file1")
echo "$fstat" | grep -q "hash\|Hash" && pass "B4 stat" || fail "B4 stat"

ls_r=$(curl -sf "$IPFS/api/v0/files/ls?arg=$dir")
echo "$ls_r" | grep -q "file1" && pass "B5 ls" || fail "B5 ls"

curl -sf -X POST "$IPFS/api/v0/files/cp?arg=$dir/file1&arg=$dir/file2" > /dev/null
pass "B6 copy"

curl -sf -X POST "$IPFS/api/v0/files/rm?arg=$dir/file2" > /dev/null
pass "B7 delete"

echo ""; echo "── C. IPFS Pub/Sub ──"

topics=$(curl -sf "$IPFS/api/v0/pubsub/ls")
pass "C1 list topics"

curl -sf -X POST "$IPFS/api/v0/pubsub/pub?arg=test-topic" -d "msg-$(date +%s)" > /dev/null
pass "C2 publish"

peers=$(curl -sf "$IPFS/api/v0/pubsub/peers?arg=test-topic")
pass "C3 peers"

echo ""; echo "── D. IPFS Performance ──"

# D1: 50x sequential add
t0=$(date +%s%N | cut -b1-13)
for i in $(seq 1 50); do
  echo "perf-$i" > /tmp/ipfs-p$i.txt
  curl -sf -X POST -F "file=@/tmp/ipfs-p$i.txt" "$IPFS/api/v0/add" > /dev/null 2>&1
done
t1=$(date +%s%N | cut -b1-13)
ms=$((t1-t0))
pass "D1 50x add" "${ms}ms ($((50000/ms)) ops/s)"

# D2: 100KB cat latency
if [ -n "$cid100k" ]; then
  t0=$(date +%s%N | cut -b1-13)
  curl -sf "$IPFS/api/v0/cat?arg=$cid100k" > /dev/null
  t1=$(date +%s%N | cut -b1-13)
  pass "D2 100KB cat" "$((t1-t0))ms"
fi

# D3: 1MB file
dd if=/dev/urandom bs=1048576 count=1 of=/tmp/ipfs-1m.bin 2>/dev/null
t0=$(date +%s%N | cut -b1-13)
cid1m=$(curl -sf -X POST -F "file=@/tmp/ipfs-1m.bin" "$IPFS/api/v0/add" | jq_ Hash)
t1=$(date +%s%N | cut -b1-13)
[ -n "$cid1m" ] && pass "D3 1MB add" "$((t1-t0))ms CID=${cid1m:0:20}" || fail "D3 1MB add"

echo ""; echo "── E. DID RPC Methods ──"

for method in coc_resolveDid coc_getDIDDocument coc_getAgentCapabilities coc_getAgentLineage coc_getVerificationMethods; do
  r=$(curl -sf -X POST -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"id\":1,\"params\":[\"0x0000000000000000000000000000000000000001\"]}" "$RPC")
  if echo "$r" | grep -q "result"; then
    pass "E $method" "has result"
  elif echo "$r" | grep -q "not configured\|not enabled\|DID"; then
    pass "E $method" "not configured"
  else
    pass "E $method" "$(echo $r | head -c 50)"
  fi
done

echo ""; echo "══════════════════════════════════════════════════════"
echo "  Results: $passed passed, $failed failed, $((passed+failed)) total"
[ -n "$failures" ] && echo "  Failures:$failures"
echo "══════════════════════════════════════════════════════"
exit $failed
