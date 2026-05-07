// Rollback chain leveldb to target height by deleting all blocks > target.
// Usage: COC_DATA_DIR=/var/lib/coc/node-1 node rollback-chain.mjs <targetHeight>
import { Level } from "level"
import { resolve } from "node:path"

const TARGET = BigInt(process.argv[2] ?? "212966")
const DATA_DIR = process.env.COC_DATA_DIR
if (!DATA_DIR) { console.error("set COC_DATA_DIR"); process.exit(1) }

const enc = new TextEncoder()
const dec = new TextDecoder()

const dbPath = resolve(DATA_DIR, "leveldb-chain")
const db = new Level(dbPath, { keyEncoding: "utf8", valueEncoding: "view" })
await db.open()

console.log(`opened ${dbPath}, target height = ${TARGET}`)

const padBlock = (n) => n.toString().padStart(20, "0")

// 1. Get target block to use as new latest pointer
const targetData = await db.get(`b:${TARGET}`).catch(() => null)
if (!targetData) {
  console.error(`block ${TARGET} not found in db; cannot rollback`)
  process.exit(2)
}
const targetBlock = JSON.parse(dec.decode(targetData))
console.log(`target block hash=${targetBlock.hash} stateRoot=${targetBlock.stateRoot}`)

// 2. Iterate all blocks > target, collect their hashes + tx hashes for cleanup
const ops = []
let blocksDel = 0
let txsDel = 0
let logsDel = 0
let addrIdxDel = 0
let contractsDel = 0

for await (const [key, value] of db.iterator({ gte: "b:", lt: "b;" })) {
  const numStr = key.slice(2)
  const num = BigInt(numStr)
  if (num <= TARGET) continue
  const block = JSON.parse(dec.decode(value))
  ops.push({ type: "del", key })                                      // b:<n>
  ops.push({ type: "del", key: `h:${block.hash}` })                   // h:<hash>
  ops.push({ type: "del", key: `l:${num}` })                          // l:<n>
  blocksDel++
  if (Array.isArray(block.transactions)) {
    for (const tx of block.transactions) {
      const txHash = typeof tx === "string" ? tx : tx.hash
      if (txHash) {
        ops.push({ type: "del", key: `t:${txHash}` })
        txsDel++
      }
    }
  }
  logsDel++
}

// 3. Iterate addr-tx index — delete entries with padded num > TARGET
const padTarget = padBlock(TARGET)
for await (const key of db.keys({ gte: "a:", lt: "a;" })) {
  // key format: a:<addr>:<padded-num>:<txhash>
  const parts = key.split(":")
  if (parts.length < 4) continue
  const padded = parts[2]
  if (padded > padTarget) {
    ops.push({ type: "del", key })
    addrIdxDel++
  }
}

// 4. Iterate contract index
for await (const key of db.keys({ gte: "ct:", lt: "ct;" })) {
  // key format: ct:<padded-num>:<addr>
  const parts = key.split(":")
  if (parts.length < 3) continue
  const padded = parts[1]
  if (padded > padTarget) {
    ops.push({ type: "del", key })
    contractsDel++
    // also del ca:<addr> back-pointer if present
    const addr = parts[2]
    if (addr) ops.push({ type: "del", key: `ca:${addr}` })
  }
}

// 5. Write new latest-block pointer = TARGET block
ops.push({ type: "put", key: "m:latest-block", value: targetData })

console.log(`prepared ops: blocksDel=${blocksDel} txsDel=${txsDel} addrIdxDel=${addrIdxDel} contractsDel=${contractsDel}; flushing...`)

// Flush in chunks of 5000
const CHUNK = 5000
for (let i = 0; i < ops.length; i += CHUNK) {
  await db.batch(ops.slice(i, i + CHUNK))
}

await db.close()
console.log(`done. new latest = block ${TARGET} hash=${targetBlock.hash}`)
