import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ChainBlock, ChainSnapshot } from "./blockchain-types.ts"

const CHAIN_FILE = "chain.json"

export class ChainStorage {
  private readonly path: string

  constructor(dataDir: string) {
    this.path = join(dataDir, CHAIN_FILE)
  }

  async load(): Promise<ChainSnapshot> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const raw = await readFile(this.path, "utf-8")
      const parsed = JSON.parse(raw) as { blocks?: Array<Record<string, unknown>>; updatedAtMs?: number }
      const blocks = (parsed.blocks ?? []).map(parseBlock)
      return { blocks, updatedAtMs: Number(parsed.updatedAtMs ?? 0) }
    } catch {
      return { blocks: [], updatedAtMs: 0 }
    }
  }

  async save(snapshot: ChainSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const json = JSON.stringify({
      blocks: snapshot.blocks.map((b) => ({
        ...b,
        number: b.number.toString(),
        baseFee: b.baseFee !== undefined ? b.baseFee.toString() : undefined,
        gasUsed: b.gasUsed !== undefined ? b.gasUsed.toString() : undefined,
      })),
      updatedAtMs: snapshot.updatedAtMs,
    }, null, 2)
    await writeFile(this.path, json)
  }
}

function parseBlock(raw: Record<string, unknown>): ChainBlock {
  return {
    number: BigInt(String(raw.number ?? "0")),
    hash: String(raw.hash ?? "0x") as `0x${string}`,
    parentHash: String(raw.parentHash ?? "0x") as `0x${string}`,
    proposer: String(raw.proposer ?? ""),
    timestampMs: Number(raw.timestampMs ?? 0),
    txs: Array.isArray(raw.txs) ? raw.txs.map((x) => String(x) as `0x${string}`) : [],
    finalized: Boolean(raw.finalized),
    baseFee: raw.baseFee !== undefined ? BigInt(String(raw.baseFee)) : undefined,
    gasUsed: raw.gasUsed !== undefined ? BigInt(String(raw.gasUsed)) : undefined,
  }
}
