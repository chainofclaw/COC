/**
 * pose-witness-verifier.ts — #667 Push-verification core (audit follow-up, 2026-05-26).
 *
 * Closes the cryptographic rubber-stamp class for /pose/witness:
 *
 *   Before: the witness signs whatever (challengeId, nodeId, responseBodyHash,
 *           witnessIndex) tuple the caller hands it. Any unauthenticated
 *           caller can mint an arbitrary witness attestation.
 *
 *   After (this module): when the caller also supplies the prover's signed
 *           receipt (`responseBody`, `responseAtMs`, `nodeSig`, `tipHash`,
 *           `tipHeight`), the witness:
 *             1. recomputes keccak256(stableStringify(responseBody)) and
 *                rejects if it does not equal `responseBodyHash`
 *             2. ecrecovers the EIP-712 RECEIPT_TYPES digest against `nodeSig`
 *                and looks up nodeOperator(poseNodeId) on-chain; rejects if
 *                the recovered address is not the registered operator
 *             3. checks `|now - responseAtMs| <= freshnessWindowMs` (F2) so
 *                an old verified receipt cannot be re-fed across challenges
 *
 *   Only when all three pass does the witness sign the EIP-712 attestation.
 *
 * Deeper semantic verification (the prover actually answered the challenge
 * correctly — e.g., re-fetching the IPFS bytes for a storage proof) is a
 * strictly larger surface and tracked separately as #746 (the F1 finding,
 * including F3 leaf binding which depends on having a witness-derived
 * resultCode). This module deliberately closes only the cryptographic
 * rubber-stamp; semantic rubber-stamping remains open until #746 ships.
 */

import { verifyTypedData } from "ethers"
import { RECEIPT_TYPES, buildDomain, toEthersDomain } from "../../node/src/crypto/eip712-types.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { ContractReader } from "./contract-reader.ts"
import type { Hex32 } from "../../services/common/pose-types.ts"

export interface PushVerifyInput {
  challengeId: string
  nodeId: string                  // 32-byte poseNodeId in lowercase hex
  responseBodyHash: string
  responseBody: Record<string, unknown>
  responseAtMs: number
  nodeSig: string
  tipHash: string
  tipHeight: bigint
}

export interface PushVerifyOpts {
  chainId: bigint
  verifyingContract: string
  /** Maximum drift between `now` and `responseAtMs`. Default 60_000ms. */
  freshnessWindowMs?: number
  /** Required to look up `nodeOperator(poseNodeId)` on-chain. */
  contractReader: ContractReader
  /** For deterministic tests — production calls `Date.now`. */
  nowMs?: () => number
  /**
   * #746 — optional Layer-7 semantic verifier. When provided, runs after
   * the cryptographic push-verify checks pass and returns the witness's
   * independently-computed `resultCode`. The witness then signs that
   * resultCode into the v3 EIP-712 digest (`WITNESS_TYPES_V3`).
   *
   * When omitted, push-verify still succeeds cryptographically but no
   * `resultCode` is produced — the caller will only sign v1+v2 (which
   * leaves the F1/F3 semantic gap open, gated by `v2SunsetEpoch`).
   *
   * Implementations should return a numeric `ResultCode` matching
   * `services/common/pose-types-v2.ts`'s `ResultCode` enum (uint8 range).
   * Throw to fail-closed — the witness refuses to sign.
   */
  layer7Verifier?: (input: PushVerifyInput) => Promise<number>
}

export type PushVerifyResult =
  | {
      ok: true
      recoveredOperator: string
      /**
       * #746 — present when `layer7Verifier` was configured and ran.
       * Witness signs the v3 typehash binding this `resultCode`.
       */
      resultCode?: number
    }
  | { ok: false; status: number; error: string }

/**
 * Stable JSON stringification — must match `runtime/coc-node.ts:stableStringify`
 * (the prover's encoding) byte-for-byte, otherwise `responseBodyHash` won't
 * match. Keep these in sync. Pulled into this module rather than imported
 * from coc-node.ts because that file is a runtime entry point with side
 * effects on import (binds sockets, reads env, etc.).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${props.join(",")}}`
}

/**
 * Run the three Push-verification checks. Returns `{ ok: true, recoveredOperator }`
 * on success (caller may want to log the operator for audit) or a typed
 * failure with `status` + `error` suitable for direct HTTP response.
 */
export async function verifyPushedReceipt(
  input: PushVerifyInput,
  opts: PushVerifyOpts,
): Promise<PushVerifyResult> {
  // (1) responseBodyHash recomputation.
  const recomputed = `0x${keccak256Hex(Buffer.from(stableStringify(input.responseBody), "utf8"))}`.toLowerCase()
  if (recomputed !== input.responseBodyHash.toLowerCase()) {
    return { ok: false, status: 400, error: "responseBody does not hash to responseBodyHash" }
  }

  // (2) F2 freshness check — bound the drift so a stale verified receipt
  // can't be re-fed across challenges. Bidirectional bound: future
  // timestamps are also rejected because the prover's clock could be
  // dragged forward to extend the validity window. Use a generous window
  // (default 60s) so honest clock skew is tolerated.
  const window = opts.freshnessWindowMs ?? 60_000
  const now = (opts.nowMs ?? Date.now)()
  const drift = Math.abs(now - input.responseAtMs)
  if (drift > window) {
    return {
      ok: false,
      status: 400,
      error: `responseAtMs out of freshness window (drift ${drift}ms > ${window}ms)`,
    }
  }

  // (3) ecrecover the RECEIPT_TYPES digest against nodeSig + match to
  // registered nodeOperator(poseNodeId). Without the on-chain lookup
  // step the recovered address is just "some EOA" — any attacker can
  // self-sign a forged receipt and pass step (1)+(3).
  const domain = toEthersDomain(buildDomain(opts.chainId, opts.verifyingContract))
  const receiptPayload = {
    challengeId: input.challengeId,
    nodeId: input.nodeId,
    responseAtMs: BigInt(input.responseAtMs),
    responseBodyHash: input.responseBodyHash,
    tipHash: input.tipHash,
    tipHeight: input.tipHeight,
  }

  let recovered: string
  try {
    recovered = verifyTypedData(domain, RECEIPT_TYPES, receiptPayload, input.nodeSig).toLowerCase()
  } catch (err) {
    // Malformed signature (wrong length / non-canonical s / bad v) lands here.
    // Do not leak the underlying ethers error into the HTTP response.
    return { ok: false, status: 400, error: "nodeSig is malformed or does not recover" }
  }

  let registeredOperator: string
  try {
    registeredOperator = (await opts.contractReader.getNodeOperator(input.nodeId as Hex32)).toLowerCase()
  } catch (err) {
    // RPC failure / contract not configured — fail closed. Caller already
    // gated the push path on COC_POSE_WITNESS_REQUIRE_VERIFIED, so reaching
    // here means we explicitly want strict verification.
    return { ok: false, status: 502, error: "operator lookup failed" }
  }
  if (registeredOperator === "0x0000000000000000000000000000000000000000") {
    return { ok: false, status: 400, error: "nodeId is not registered" }
  }
  if (recovered !== registeredOperator) {
    return {
      ok: false,
      status: 400,
      error: "nodeSig does not recover to the registered nodeOperator for nodeId",
    }
  }

  // (4) #746 — Layer-7 semantic verification. Runs only when the caller
  //     wired in a verifier; the witness signs whatever resultCode it
  //     computes into the v3 EIP-712 digest. Fail-closed: if the verifier
  //     throws, refuse the attestation entirely rather than silently
  //     falling back to "no resultCode" (which would let the v3 path
  //     degrade to v2 — gated by v2SunsetEpoch, possibly accepted).
  let resultCode: number | undefined
  if (opts.layer7Verifier) {
    try {
      resultCode = await opts.layer7Verifier(input)
    } catch (err) {
      return { ok: false, status: 502, error: "layer-7 verification failed" }
    }
    if (typeof resultCode !== "number" || !Number.isInteger(resultCode) || resultCode < 0 || resultCode > 255) {
      return { ok: false, status: 502, error: "layer-7 verifier returned non-uint8 resultCode" }
    }
  }

  return { ok: true, recoveredOperator: recovered, ...(resultCode !== undefined ? { resultCode } : {}) }
}
