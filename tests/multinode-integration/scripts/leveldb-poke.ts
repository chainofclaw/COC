/**
 * Phase J3 fault-injection helper.
 *
 * Opens a node's persisted block index and rewrites the `stateRoot` field
 * of the named block. Used by inject-stateroot-corruption.sh inside a
 * sidecar container that has volume-mount access to the target node's
 * /data/coc directory.
 *
 * Modes:
 *   read   <height>                  — print the block's current stateRoot
 *   write  <height>  <poison_hex>    — overwrite the stateRoot field
 *
 * Implementation note: the on-disk format used by the chain engine is
 * `LevelDatabase` from node/src/storage/db.ts, with block records keyed by
 * `block-by-number:<height>` and serialized as JSON with a custom
 * `stringifyWithBigInt` encoder (see block-index.ts). We read/write through
 * the same code path so the sidecar's mutations are byte-identical to what
 * the engine itself would produce — no schema drift, no checksums to
 * reconstruct.
 */
import { LevelDatabase } from "../../../node/src/storage/db.ts"
import { BlockIndex } from "../../../node/src/storage/block-index.ts"
import type { Hex } from "../../../node/src/blockchain-types.ts"

const DATA_DIR = process.env.COC_DATA_DIR ?? "/data/coc"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const mode = args[0]
  if (mode !== "read" && mode !== "write") {
    console.error("usage: leveldb-poke.ts read <height>")
    console.error("       leveldb-poke.ts write <height> <poison_hex>")
    process.exit(2)
  }

  const height = BigInt(args[1])
  const db = new LevelDatabase(DATA_DIR, "chain")
  const idx = new BlockIndex(db)
  await idx.init()

  const block = await idx.getByNumber(height)
  if (!block) {
    console.error(`block ${height} not found`)
    process.exit(3)
  }

  if (mode === "read") {
    console.log(JSON.stringify({
      height: block.number.toString(),
      hash: block.hash,
      stateRoot: block.stateRoot ?? null,
      parentHash: block.parentHash,
    }, null, 2))
    await db.close()
    return
  }

  // write mode
  const poison = args[2] as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(poison)) {
    console.error(`poison value must be a 32-byte hex string, got: ${poison}`)
    process.exit(4)
  }
  const corrupted = { ...block, stateRoot: poison }
  // BlockIndex doesn't expose a direct "rewrite by number" mutator — it
  // expects atomic apply via the chain engine. For fault injection we open
  // the underlying db.put() and write the same key the engine would use.
  // This bypasses validation INTENTIONALLY (real LevelDB corruption could
  // arise from any source); we want to simulate "header field is wrong on
  // disk" without re-running the apply pipeline.
  await db.put(`block-by-number:${height.toString()}`, JSON.stringify(corrupted, (_, v) =>
    typeof v === "bigint" ? `${v.toString()}n` : v,
  ))
  console.log(`stateRoot at height ${height} written: ${poison}`)
  await db.close()
}

main().catch((err) => {
  console.error("leveldb-poke failed:", err)
  process.exit(1)
})
