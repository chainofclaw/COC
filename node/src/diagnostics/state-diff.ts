/**
 * Phase H8 — EVM state diff CLI
 *
 * Compares two `leveldb-state` directories (e.g., divergent node-1 vs
 * canonical node-2 forensic snapshots) and reports per-account and
 * per-storage-slot differences. Used to isolate which specific account
 * or storage slot keeps getting corrupted on node-1, so we can trace to
 * the code path that mutates it inconsistently.
 *
 * Usage (offline; reads existing leveldb directories):
 *
 *     node --experimental-strip-types node/src/diagnostics/state-diff.ts \
 *         /path/to/leveldb-state-A \
 *         /path/to/leveldb-state-B \
 *         [--state-root 0xHEX]
 *
 * `--state-root` is optional. When omitted, each side uses whatever
 * root was last persisted to its `STATE_ROOT_KEY`. Pass an explicit
 * root to compare both sides at the same logical block (the recommended
 * usage for forensic snapshots).
 *
 * The output is grouped:
 *   1. Summary counts (accounts in A only, B only, both, differing)
 *   2. List of accounts that exist on one side but not the other
 *   3. List of accounts present on both with field differences
 *   4. For each differing account whose `storageRoot` differs, an
 *      enumeration of differing storage slots
 *
 * Exits 0 if no differences found, 1 if any differences found.
 */

import { dirname, basename } from "node:path"
import { LevelDatabase } from "../storage/db.ts"
import { PersistentStateTrie } from "../storage/state-trie.ts"
import type { AccountState } from "../storage/state-trie.ts"

/**
 * `LevelDatabase(dataDir, namespace)` resolves to `dataDir/leveldb-{namespace}`.
 * The diff tool's CLI accepts the full final path (e.g.
 * `/var/lib/docker/volumes/docker_node1-data/_data/leveldb-state.broken.20260430T1737Z`),
 * so we split it back into (dataDir, namespace) here. If the path doesn't
 * follow the `leveldb-{namespace}` convention we fall back to opening it
 * directly via a marker namespace pointed at its parent.
 */
function openLevelDb(fullPath: string): LevelDatabase {
  const dir = dirname(fullPath)
  const base = basename(fullPath)
  const prefix = "leveldb-"
  const namespace = base.startsWith(prefix) ? base.slice(prefix.length) : base
  return new LevelDatabase(dir, namespace)
}

interface AccountDiff {
  address: string
  a?: AccountState
  b?: AccountState
  fieldChanges?: Array<"nonce" | "balance" | "storageRoot" | "codeHash">
}

interface StorageDiff {
  address: string
  /** slot → { a, b } where one side may be undefined */
  slots: Map<string, { a?: string; b?: string }>
}

export interface StateDiffOptions {
  pathA: string
  pathB: string
  stateRoot?: string
  /**
   * Cap the number of differing slots reported per account so a single
   * massively-divergent contract doesn't drown the report.
   */
  maxStorageSlotsPerAccount?: number
}

export interface StateDiffReport {
  pathA: string
  pathB: string
  stateRootA: string | null
  stateRootB: string | null
  /** number of accounts present in A but not B */
  onlyInACount: number
  /** number of accounts present in B but not A */
  onlyInBCount: number
  /** number of accounts present in both with at least one field differing */
  differingCount: number
  /** number of accounts present in both with byte-identical fields */
  matchingCount: number
  /** at-most N accounts present in A only (capped by sample size) */
  onlyInASample: AccountDiff[]
  onlyInBSample: AccountDiff[]
  differingAccounts: AccountDiff[]
  storageDiffs: StorageDiff[]
}

const DEFAULT_MAX_STORAGE_SLOTS = 64
const SAMPLE_LIMIT = 32

export async function compareStates(opts: StateDiffOptions): Promise<StateDiffReport> {
  const dbA = openLevelDb(opts.pathA)
  const dbB = openLevelDb(opts.pathB)
  await dbA.open()
  await dbB.open()
  const trieA = new PersistentStateTrie(dbA)
  const trieB = new PersistentStateTrie(dbB)
  await trieA.init()
  await trieB.init()
  if (opts.stateRoot) {
    await trieA.setStateRoot(opts.stateRoot, { persist: false })
    await trieB.setStateRoot(opts.stateRoot, { persist: false })
  }

  try {
    const accountsA = new Map<string, AccountState>()
    const accountsB = new Map<string, AccountState>()
    for await (const { address, state } of trieA.iterateAccounts()) {
      accountsA.set(address.toLowerCase(), state)
    }
    for await (const { address, state } of trieB.iterateAccounts()) {
      accountsB.set(address.toLowerCase(), state)
    }

    const onlyInA: AccountDiff[] = []
    const onlyInB: AccountDiff[] = []
    const differing: AccountDiff[] = []
    let matching = 0

    const allAddrs = new Set<string>([...accountsA.keys(), ...accountsB.keys()])
    for (const addr of allAddrs) {
      const a = accountsA.get(addr)
      const b = accountsB.get(addr)
      if (!a) {
        onlyInB.push({ address: addr, b: b! })
        continue
      }
      if (!b) {
        onlyInA.push({ address: addr, a })
        continue
      }
      const fieldChanges: AccountDiff["fieldChanges"] = []
      if (a.nonce !== b.nonce) fieldChanges!.push("nonce")
      if (a.balance !== b.balance) fieldChanges!.push("balance")
      if (a.storageRoot !== b.storageRoot) fieldChanges!.push("storageRoot")
      if (a.codeHash !== b.codeHash) fieldChanges!.push("codeHash")
      if (fieldChanges!.length === 0) {
        matching++
      } else {
        differing.push({ address: addr, a, b, fieldChanges })
      }
    }

    // For each differing account whose storageRoot differs, enumerate
    // slot-level diffs.
    const storageDiffs: StorageDiff[] = []
    const maxSlots = opts.maxStorageSlotsPerAccount ?? DEFAULT_MAX_STORAGE_SLOTS
    for (const diff of differing) {
      if (!diff.fieldChanges?.includes("storageRoot")) continue
      const slotsA = new Map<string, string>()
      const slotsB = new Map<string, string>()
      for await (const { slot, value } of trieA.iterateStorage(diff.address)) {
        slotsA.set(slot.toLowerCase(), value)
      }
      for await (const { slot, value } of trieB.iterateStorage(diff.address)) {
        slotsB.set(slot.toLowerCase(), value)
      }
      const slotChanges = new Map<string, { a?: string; b?: string }>()
      const allSlots = new Set<string>([...slotsA.keys(), ...slotsB.keys()])
      for (const slot of allSlots) {
        if (slotChanges.size >= maxSlots) break
        const va = slotsA.get(slot)
        const vb = slotsB.get(slot)
        if (va !== vb) slotChanges.set(slot, { a: va, b: vb })
      }
      if (slotChanges.size > 0) {
        storageDiffs.push({ address: diff.address, slots: slotChanges })
      }
    }

    return {
      pathA: opts.pathA,
      pathB: opts.pathB,
      stateRootA: trieA.stateRoot(),
      stateRootB: trieB.stateRoot(),
      onlyInACount: onlyInA.length,
      onlyInBCount: onlyInB.length,
      differingCount: differing.length,
      matchingCount: matching,
      onlyInASample: onlyInA.slice(0, SAMPLE_LIMIT),
      onlyInBSample: onlyInB.slice(0, SAMPLE_LIMIT),
      differingAccounts: differing,
      storageDiffs,
    }
  } finally {
    await dbA.close()
    await dbB.close()
  }
}

function fmtBig(n: bigint | undefined): string {
  if (n === undefined) return "<none>"
  return n.toString()
}

function fmtAccount(s: AccountState | undefined): string {
  if (!s) return "<absent>"
  return `nonce=${fmtBig(s.nonce)} balance=${fmtBig(s.balance)} storageRoot=${s.storageRoot} codeHash=${s.codeHash}`
}

export function renderReport(report: StateDiffReport): string {
  const lines: string[] = []
  lines.push("=== EVM State Diff Report ===")
  lines.push(`A: ${report.pathA} (root=${report.stateRootA ?? "<unset>"})`)
  lines.push(`B: ${report.pathB} (root=${report.stateRootB ?? "<unset>"})`)
  lines.push("")
  lines.push("Summary:")
  lines.push(`  matching            ${report.matchingCount}`)
  lines.push(`  differing           ${report.differingCount}`)
  lines.push(`  only in A           ${report.onlyInACount}`)
  lines.push(`  only in B           ${report.onlyInBCount}`)
  lines.push("")
  if (report.onlyInACount > 0) {
    lines.push(`-- ${report.onlyInACount} accounts only in A (showing ${report.onlyInASample.length}) --`)
    for (const d of report.onlyInASample) lines.push(`  ${d.address}  ${fmtAccount(d.a)}`)
    lines.push("")
  }
  if (report.onlyInBCount > 0) {
    lines.push(`-- ${report.onlyInBCount} accounts only in B (showing ${report.onlyInBSample.length}) --`)
    for (const d of report.onlyInBSample) lines.push(`  ${d.address}  ${fmtAccount(d.b)}`)
    lines.push("")
  }
  if (report.differingCount > 0) {
    lines.push(`-- ${report.differingCount} accounts differ --`)
    for (const d of report.differingAccounts) {
      lines.push(`  ${d.address}  fields=[${d.fieldChanges?.join(",")}]`)
      lines.push(`    A: ${fmtAccount(d.a)}`)
      lines.push(`    B: ${fmtAccount(d.b)}`)
    }
    lines.push("")
  }
  if (report.storageDiffs.length > 0) {
    lines.push(`-- storage-slot differences (${report.storageDiffs.length} accounts) --`)
    for (const sd of report.storageDiffs) {
      lines.push(`  ${sd.address}  diff slots=${sd.slots.size}`)
      for (const [slot, { a, b }] of sd.slots) {
        lines.push(`    slot ${slot}: A=${a ?? "<absent>"}  B=${b ?? "<absent>"}`)
      }
    }
  }
  return lines.join("\n")
}

// CLI entry point — only runs when this file is the script main.
const moduleUrl = new URL(import.meta.url).href
const argv1 = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : ""
if (moduleUrl === argv1) {
  const args = process.argv.slice(2)
  const pathA = args[0]
  const pathB = args[1]
  if (!pathA || !pathB) {
    console.error("usage: state-diff <leveldb-state-A> <leveldb-state-B> [--state-root 0xHEX]")
    process.exit(2)
  }
  const stateRootIdx = args.indexOf("--state-root")
  const stateRoot = stateRootIdx >= 0 ? args[stateRootIdx + 1] : undefined
  compareStates({ pathA, pathB, stateRoot })
    .then((report) => {
      console.log(renderReport(report))
      const hasDiffs = report.onlyInACount > 0 || report.onlyInBCount > 0 || report.differingCount > 0
      process.exit(hasDiffs ? 1 : 0)
    })
    .catch((err) => {
      console.error("state-diff failed:", err)
      process.exit(2)
    })
}
