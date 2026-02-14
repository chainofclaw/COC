/**
 * Legacy JSON snapshot migration script
 *
 * Reads the legacy chain.json format (array of blocks) and
 * imports them into the new LevelDB-backed BlockIndex storage.
 *
 * Usage:
 *   node --experimental-strip-types src/storage/migrate-legacy.ts [dataDir]
 */

import { readFile, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { LevelDatabase } from "./db.ts"
import { BlockIndex } from "./block-index.ts"
import { PersistentNonceStore } from "./nonce-store.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"

const LEGACY_CHAIN_FILE = "chain.json"

interface LegacySnapshot {
  blocks: Array<Record<string, unknown>>
  updatedAtMs: number
}

function parseBlock(raw: Record<string, unknown>): ChainBlock {
  return {
    number: BigInt(String(raw.number ?? "0")),
    hash: String(raw.hash ?? "0x") as Hex,
    parentHash: String(raw.parentHash ?? "0x") as Hex,
    proposer: String(raw.proposer ?? ""),
    timestampMs: Number(raw.timestampMs ?? 0),
    txs: Array.isArray(raw.txs)
      ? raw.txs.map((x: unknown) => String(x) as Hex)
      : [],
    finalized: Boolean(raw.finalized),
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export interface MigrationResult {
  blocksImported: number
  noncesMarked: number
  legacyFileRenamed: boolean
}

/**
 * Migrate legacy chain.json to LevelDB storage.
 *
 * After successful migration, renames chain.json to chain.json.bak
 * to prevent re-migration on next restart.
 */
export async function migrateLegacySnapshot(
  dataDir: string
): Promise<MigrationResult> {
  const legacyPath = join(dataDir, LEGACY_CHAIN_FILE)

  if (!(await fileExists(legacyPath))) {
    return { blocksImported: 0, noncesMarked: 0, legacyFileRenamed: false }
  }

  // Read legacy file
  const raw = await readFile(legacyPath, "utf-8")
  const parsed: LegacySnapshot = JSON.parse(raw)

  if (!Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
    return { blocksImported: 0, noncesMarked: 0, legacyFileRenamed: false }
  }

  // Open LevelDB
  const db = new LevelDatabase(dataDir, "chain")
  await db.open()

  const blockIndex = new BlockIndex(db)
  const nonceStore = new PersistentNonceStore(db)

  let blocksImported = 0
  let noncesMarked = 0

  try {
    // Check if data already exists
    const existing = await blockIndex.getLatestBlock()
    if (existing) {
      console.log(
        `LevelDB already contains blocks (latest: #${existing.number}), skipping migration`
      )
      return { blocksImported: 0, noncesMarked: 0, legacyFileRenamed: false }
    }

    // Import blocks in order
    for (const rawBlock of parsed.blocks) {
      const block = parseBlock(rawBlock)
      await blockIndex.putBlock(block)
      blocksImported++

      // Mark transaction nonces as used
      for (const txHash of block.txs) {
        const nonce = `tx:${txHash}`
        await nonceStore.markUsed(nonce)
        noncesMarked++
      }
    }

    // Rename legacy file to prevent re-migration
    const backupPath = join(dataDir, `${LEGACY_CHAIN_FILE}.bak`)
    await rename(legacyPath, backupPath)

    return { blocksImported, noncesMarked, legacyFileRenamed: true }
  } finally {
    await db.close()
  }
}

// CLI entry point
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-legacy.ts") ||
    process.argv[1].endsWith("migrate-legacy.js"))

if (isMainModule) {
  const dataDir =
    process.argv[2] ||
    process.env.COC_DATA_DIR ||
    join(homedir(), ".clawdbot", "coc")

  console.log(`Migrating legacy snapshot from: ${dataDir}`)

  migrateLegacySnapshot(dataDir)
    .then((result) => {
      if (result.blocksImported === 0) {
        console.log("No migration needed")
      } else {
        console.log(
          `Migration complete: ${result.blocksImported} blocks, ${result.noncesMarked} nonces`
        )
      }
    })
    .catch((err) => {
      console.error("Migration failed:", err)
      process.exit(1)
    })
}
