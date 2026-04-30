/**
 * Phase I3b — BFT slash bridge
 *
 * Translates `EquivocationEvidence` records produced by the in-process
 * `EquivocationDetector` (node/src/bft.ts) into transactions on the
 * on-chain `EquivocationDetector.sol` contract for permissionless
 * slashing via `ValidatorRegistry.slashValidator`.
 *
 * The bridge is plumbing-only: encoding evidence to ABI calldata,
 * deriving the target nodeId from the validator address, and providing
 * a single `buildSubmitEvidenceCall` helper that callers (e.g.
 * coc-relayer.ts tick) can use to construct a transaction.
 *
 * It does NOT submit the tx itself — the caller owns wallet/signer
 * concerns, gas pricing, retry, and idempotency. That separation keeps
 * this module trivially testable without mocking an RPC client.
 */

import type { EquivocationEvidence } from "../../node/src/bft.ts"
import { Interface, type Result } from "ethers"

/**
 * Solidity ABI fragment for `EquivocationDetector.submitEvidence`. Matches
 * contracts/contracts-src/governance/EquivocationDetector.sol exactly.
 *
 * Argument order: nodeId, phase, height, hashA, sigA, hashB, sigB.
 */
export const EQUIVOCATION_DETECTOR_ABI = [
  "function submitEvidence(bytes32 nodeId, string phase, uint256 height, bytes32 hashA, bytes sigA, bytes32 hashB, bytes sigB) external",
  "event EquivocationProven(bytes32 indexed nodeId, address indexed signer, uint256 indexed height, bytes32 hashA, bytes32 hashB, bytes32 evidenceHash)",
] as const

const detectorIface = new Interface(EQUIVOCATION_DETECTOR_ABI as unknown as string[])

export interface SubmitEvidenceCall {
  /** ABI-encoded calldata ready to send to the EquivocationDetector contract */
  data: string
  /** Address of the EquivocationDetector contract */
  to: string
  /** The nodeId being slashed; useful for logging/metric attribution */
  nodeId: string
}

export interface BuildSubmitEvidenceOpts {
  /** EquivocationDetector.sol deployment address */
  detectorAddress: string
  /**
   * 32-byte nodeId of the offender.
   *
   * Validators in `ValidatorRegistry` are indexed by `nodeId =
   * keccak256(uncompressedPubkey[1:65])`, whose trailing 20 bytes equal
   * the EVM address derived from the same key. The `validatorId` field
   * on the in-process evidence is just the address — to slash on-chain
   * we need the full nodeId, which the caller looks up from the
   * registry. The bridge asserts the trailing-20 invariant before
   * encoding so a stale or wrong nodeId is rejected at build time.
   */
  nodeId: string
}

/**
 * Build the calldata + target address for a single
 * `EquivocationDetector.submitEvidence` call.
 *
 * Throws when the evidence is incomplete (missing signatures), the phase
 * is not "prepare"/"commit", or the nodeId trailer doesn't match the
 * offender's address. Validation here is fail-loud so the caller doesn't
 * spend gas on a tx that the contract would just revert.
 */
export function buildSubmitEvidenceCall(
  evidence: EquivocationEvidence,
  opts: BuildSubmitEvidenceOpts,
): SubmitEvidenceCall {
  if (!evidence.signature1 || !evidence.signature2) {
    throw new Error("equivocation evidence is missing signatures; cannot submit on-chain")
  }
  if (evidence.phase !== "prepare" && evidence.phase !== "commit") {
    throw new Error(`unsupported BFT phase: ${evidence.phase}`)
  }
  if (evidence.blockHash1 === evidence.blockHash2) {
    throw new Error("evidence blockHashes are equal; not equivocation")
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.nodeId)) {
    throw new Error(`malformed nodeId: ${opts.nodeId}`)
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.detectorAddress)) {
    throw new Error(`malformed detector address: ${opts.detectorAddress}`)
  }

  // Defence in depth: the trailing 20 bytes of nodeId must equal the
  // recorded validatorId (an EVM address). The contract enforces the
  // same invariant via `address(uint160(uint256(nodeId)))`, but we want
  // to fail at the bridge if the caller threaded the wrong nodeId.
  const trailer = ("0x" + opts.nodeId.slice(-40)).toLowerCase()
  const validatorAddr = evidence.validatorId.toLowerCase()
  // Allow the validatorId to be either 0x-prefixed 20 bytes or a 32-byte
  // node id whose last 20 bytes are the address — accept the suffix.
  const validatorTrailer = validatorAddr.startsWith("0x")
    ? "0x" + validatorAddr.slice(-40)
    : "0x" + validatorAddr.slice(-40)
  if (trailer !== validatorTrailer) {
    throw new Error(
      `nodeId trailer ${trailer} does not match validatorId ${evidence.validatorId}`,
    )
  }

  const data = detectorIface.encodeFunctionData("submitEvidence", [
    opts.nodeId,
    evidence.phase,
    evidence.height,
    evidence.blockHash1,
    evidence.signature1,
    evidence.blockHash2,
    evidence.signature2,
  ])

  return {
    data,
    to: opts.detectorAddress,
    nodeId: opts.nodeId,
  }
}

/**
 * Decode the calldata produced by `buildSubmitEvidenceCall` back into the
 * structured arguments. Useful for unit tests that round-trip evidence
 * through the bridge encoder.
 */
export function decodeSubmitEvidenceCall(data: string): {
  nodeId: string
  phase: string
  height: bigint
  hashA: string
  sigA: string
  hashB: string
  sigB: string
} {
  const decoded: Result = detectorIface.decodeFunctionData("submitEvidence", data)
  return {
    nodeId: decoded[0] as string,
    phase: decoded[1] as string,
    height: decoded[2] as bigint,
    hashA: decoded[3] as string,
    sigA: decoded[4] as string,
    hashB: decoded[5] as string,
    sigB: decoded[6] as string,
  }
}
