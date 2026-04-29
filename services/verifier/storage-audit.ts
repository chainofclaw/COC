/**
 * Storage challenge audit sampling (Phase C2.4).
 *
 * Given a storage receipt, 5% of the time (configurable via
 * `auditSampleBps`) we independently re-fetch the challenged chunk
 * from a second peer that also advertises the CID, recompute
 * `hashLeaf(bytes)`, and compare to the `leafHash` the prover
 * returned. If they disagree, the prover either:
 *  - fabricated a proof without actually holding the bytes
 *    (leafHash != real hash of real bytes), or
 *  - colluded with its DHT-advertised provider set so the only peer
 *    that would have served the challenged chunk is itself.
 * Either way, the result code flips to `InvalidStorageAudit` and the
 * storageBps tally for that node drops.
 *
 * Keeping the sampler as a plain function makes it trivially unit-
 * testable and reusable across both the agent's V2 happy path
 * (coc-agent.ts) and the ReceiptVerifierV2 pipeline when it
 * eventually gets wired. The function only needs the injection points
 * — it does not know about EIP-712, nonce registries, or Merkle
 * math-only proof validation; those layers stay with the caller.
 */

import { hashLeaf } from "../../node/src/ipfs-merkle.ts"

const DEFAULT_AUDIT_SAMPLE_BPS = 500 // 5% of challenges

export interface StorageAuditDeps {
  /**
   * Fetch the raw chunk bytes for `cid` from any reachable DHT-
   * advertised peer *other than* `excludePeerId` (the prover). The
   * node-side implementation handles both provider lookup and peer
   * racing; the auditor only needs one RPC. Returns null when no
   * non-excluded peer served the CID within the pull timeout — the
   * auditor treats that as "inconclusive" (audited: false) rather
   * than a failed audit, since the absence of independent providers
   * is a separate signal that C3.3's repair loop handles.
   */
  fetchChunkExcluding: (cid: string, excludePeerId: string) => Promise<Uint8Array | null>
  /** Source of randomness. Default Math.random. Injected for deterministic tests. */
  rng?: () => number
  /**
   * Sample rate in basis points (1/10000). Default 500 = 5%. Set to
   * 10000 to audit every receipt (useful for soak tests); set to 0 to
   * disable sampling entirely (the caller still pays the cost of
   * asking us, but the returned `audited: false` skips the network
   * round trip).
   */
  auditSampleBps?: number
}

export interface StorageAuditInput {
  /** CID the prover claimed to hold. */
  cid: string
  /** Leaf hash the prover returned in its Merkle proof. */
  leafHash: string
  /** The prover's node ID — excluded from the peer set we re-fetch from. */
  proverNodeId: string
  /**
   * Chunk index on a multi-leaf file. The audit ignores this and
   * compares the single returned blob's full-content hash, which
   * matches only when `hashLeaf(bytes) === leafHash`. Callers who
   * re-assemble chunk-level proofs reuse this same helper.
   */
  chunkIndex?: number
}

export type StorageAuditStatus =
  | { audited: false; reason: "not-sampled" | "no-independent-provider" | "no-bytes-returned" }
  | { audited: true; passed: true }
  | { audited: true; passed: false; reason: "leaf-hash-mismatch"; expected: string; actual: string }

/** Pure helper: decide whether to audit this receipt given the sample rate. */
export function shouldSampleAudit(rng: () => number, sampleBps: number): boolean {
  if (sampleBps <= 0) return false
  if (sampleBps >= 10_000) return true
  return Math.floor(rng() * 10_000) < sampleBps
}

/**
 * Sample-then-audit. When sampled, pulls the chunk from an
 * independent peer and compares recomputed leafHash to the prover's
 * claimed leafHash.
 *
 * The function never throws — network / peer errors collapse into
 * `audited: false, reason: "no-bytes-returned"` so callers can
 * distinguish "audit didn't run" from "audit caught a lie". The
 * caller decides scoring policy: Ok on !audited, Ok on audited+passed,
 * InvalidStorageAudit on audited+!passed.
 */
export async function auditStorageReceipt(
  deps: StorageAuditDeps,
  input: StorageAuditInput,
): Promise<StorageAuditStatus> {
  const sampleBps = deps.auditSampleBps ?? DEFAULT_AUDIT_SAMPLE_BPS
  const rng = deps.rng ?? Math.random

  if (!shouldSampleAudit(rng, sampleBps)) {
    return { audited: false, reason: "not-sampled" }
  }

  let bytes: Uint8Array | null = null
  try {
    bytes = await deps.fetchChunkExcluding(input.cid, input.proverNodeId)
  } catch {
    bytes = null
  }
  if (!bytes || bytes.length === 0) {
    // Either no non-excluded peer responded (the prover is the only
    // advertised provider — yellow flag surfaced separately via C3.3's
    // repair metrics) or the peers are down. Audit is inconclusive, not
    // failed: caller leaves the receipt as Ok.
    return { audited: false, reason: "no-bytes-returned" }
  }

  const actual = hashLeaf(bytes).toLowerCase()
  const expected = input.leafHash.toLowerCase()
  if (actual === expected) {
    return { audited: true, passed: true }
  }
  return {
    audited: true,
    passed: false,
    reason: "leaf-hash-mismatch",
    expected,
    actual,
  }
}
