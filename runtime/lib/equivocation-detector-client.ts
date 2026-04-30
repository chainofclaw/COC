/**
 * Phase I3c — EquivocationDetector tx submission client
 *
 * Closes the loop on Phase I3:
 *   - I3a (PR #23): on-chain `EquivocationDetector.sol` verifies + slashes.
 *   - I3b (PR #24): in-process `EquivocationEvidence` carries the two BFT
 *     signatures; `bft-slash-bridge.ts` encodes evidence to ABI calldata.
 *   - I3c (this file): runtime-side glue that resolves the offender's
 *     `nodeId` from a `validatorAddress` (via ValidatorRegistry event scan)
 *     and submits the tx.
 *
 * Two entry points:
 *   - `prime()` warms the address → nodeId cache by scanning all
 *     `ValidatorRegistered` events from the registry. Idempotent + safe to
 *     re-run (e.g. on each relayer tick) because it tracks the last-scanned
 *     block and only fetches deltas.
 *   - `submitEvidence(evidence)` looks up the nodeId, encodes the call via
 *     `bft-slash-bridge.ts`, and sends the transaction. Returns the tx hash
 *     on success; rejects with a typed error on lookup miss / encoder
 *     reject / chain reject.
 *
 * The caller (coc-relayer tick) decides on/off via env. This module does
 * NOT poll on its own.
 */

import { Contract, Interface, type AbstractSigner, type Provider } from "ethers"
import type { EquivocationEvidence } from "../../node/src/bft.ts"
import { buildSubmitEvidenceCall } from "./bft-slash-bridge.ts"

/** Minimal ABI for the registry event scan. */
const VALIDATOR_REGISTRY_ABI = [
  "event ValidatorRegistered(bytes32 indexed nodeId, address indexed operator, uint256 stake, bytes pubkeyNode)",
] as const

/**
 * Last 20 bytes of nodeId == operator address (per
 * `ValidatorRegistry.sol`'s nodeId convention). The detector contract
 * enforces the same invariant. Useful for derived lookups when the
 * event scan hasn't run yet.
 */
export function nodeIdTrailerAddress(nodeId: string): string {
  return ("0x" + nodeId.slice(-40)).toLowerCase()
}

export interface EquivocationDetectorClientOpts {
  signer: AbstractSigner
  /** ValidatorRegistry deployment address used to resolve address→nodeId. */
  registryAddress: string
  /** EquivocationDetector deployment address (target of submitEvidence). */
  detectorAddress: string
  /**
   * Earliest block to scan for ValidatorRegistered events. Defaults to 0,
   * which is safe but slow on long-running chains. Pass the registry's
   * deploy block in production to skip historical scan overhead.
   */
  fromBlock?: bigint
  /**
   * Provider used for the event scan. Defaults to the signer's provider.
   * Must be set explicitly when the signer was constructed without a
   * provider (e.g. raw VoidSigner in tests).
   */
  provider?: Provider
  /** ms to use as receipt-wait timeout. Default 30s. */
  txTimeoutMs?: number
}

export class EquivocationDetectorClient {
  private readonly signer: AbstractSigner
  private readonly provider: Provider
  private readonly registryAddress: string
  private readonly detectorAddress: string
  private readonly addressToNodeId = new Map<string, string>()
  private lastScannedBlock: bigint
  private readonly txTimeoutMs: number
  private readonly registryIface = new Interface(VALIDATOR_REGISTRY_ABI as unknown as string[])

  constructor(opts: EquivocationDetectorClientOpts) {
    this.signer = opts.signer
    const provider = opts.provider ?? opts.signer.provider
    if (!provider) {
      throw new Error("EquivocationDetectorClient: signer.provider is null and no provider option given")
    }
    this.provider = provider
    this.registryAddress = opts.registryAddress
    this.detectorAddress = opts.detectorAddress
    this.lastScannedBlock = opts.fromBlock ?? 0n
    this.txTimeoutMs = opts.txTimeoutMs ?? 30_000
  }

  // Sentinel used when no scan has run yet. -1n means "fromBlock starts at
  // user-supplied init value", so the very first prime() honours the
  // constructor's `fromBlock` option. Subsequent primes use lastScannedBlock+1.
  private firstScanDone = false

  /**
   * Walk `ValidatorRegistered` events from `lastScannedBlock + 1` to chain
   * tip and append to the address → nodeId cache. Safe to call multiple
   * times; subsequent calls only fetch the delta. Detects backwards-jumps
   * (reorg / snapshot import) and re-scans from genesis-or-init.
   */
  async prime(): Promise<{ scannedFrom: bigint; scannedTo: bigint; newEntries: number }> {
    const tip = BigInt(await this.provider.getBlockNumber())
    if (this.firstScanDone && tip < this.lastScannedBlock) {
      // Backwards jump — reorg or snapshot import. Reset cache, scan
      // pointer, and the firstScanDone flag so the next branch starts
      // over from genesis (or the constructor-given fromBlock — which is
      // 0 by default; deliberately re-scanning costs at most one extra
      // getLogs call on a recovery path that's already exceptional).
      this.firstScanDone = false
      this.lastScannedBlock = 0n
      this.addressToNodeId.clear()
    }
    const fromBlock = this.firstScanDone ? this.lastScannedBlock + 1n : this.lastScannedBlock
    if (fromBlock > tip) {
      return { scannedFrom: fromBlock, scannedTo: tip, newEntries: 0 }
    }
    const filter = {
      address: this.registryAddress,
      fromBlock,
      toBlock: tip,
      topics: [this.registryIface.getEvent("ValidatorRegistered")!.topicHash],
    }
    const logs = await this.provider.getLogs(filter)
    let newEntries = 0
    for (const log of logs) {
      const parsed = this.registryIface.parseLog({ topics: log.topics as string[], data: log.data })
      if (!parsed || parsed.name !== "ValidatorRegistered") continue
      const nodeId = parsed.args[0] as string
      const operator = (parsed.args[1] as string).toLowerCase()
      // Operator may differ from the BFT signer address (multisig staking
      // for an off-host signer). The detector contract validates against
      // `address(uint160(uint256(nodeId)))` which is the trailing 20
      // bytes of nodeId, so the resolver key must be the SAME trailer —
      // not the operator. Use both as keys so either lookup works:
      // operator (for BFT-signs-as-operator deployments) and nodeId
      // trailer (for separated-signer deployments).
      const trailer = nodeIdTrailerAddress(nodeId)
      if (!this.addressToNodeId.has(trailer)) {
        this.addressToNodeId.set(trailer, nodeId)
        newEntries += 1
      }
      if (!this.addressToNodeId.has(operator)) {
        this.addressToNodeId.set(operator, nodeId)
        newEntries += 1
      }
    }
    this.lastScannedBlock = tip
    this.firstScanDone = true
    return { scannedFrom: fromBlock, scannedTo: tip, newEntries }
  }

  /**
   * Resolve `address` (lower-case 0x... 20-byte hex) to the registered
   * nodeId. Returns null if not found.
   */
  resolveNodeId(address: string): string | null {
    return this.addressToNodeId.get(address.toLowerCase()) ?? null
  }

  /**
   * Submit BFT equivocation evidence to the on-chain
   * `EquivocationDetector` contract. Returns the tx hash on success.
   * Throws on missing signatures, missing nodeId resolution, or chain
   * rejection — caller decides how loud to log.
   */
  async submitEvidence(evidence: EquivocationEvidence): Promise<{ txHash: string; nodeId: string }> {
    const nodeId = this.resolveNodeId(evidence.validatorId)
    if (!nodeId) {
      // Try priming once to cover the race where a freshly-staked
      // validator equivocates before our scan caught up.
      await this.prime()
      const retried = this.resolveNodeId(evidence.validatorId)
      if (!retried) {
        throw new Error(
          `EquivocationDetectorClient: no nodeId for validator ${evidence.validatorId} (registry has ${this.addressToNodeId.size / 2} validators registered)`,
        )
      }
    }
    const finalNodeId = this.resolveNodeId(evidence.validatorId)!
    const call = buildSubmitEvidenceCall(evidence, {
      detectorAddress: this.detectorAddress,
      nodeId: finalNodeId,
    })
    const txResp = await this.signer.sendTransaction({ to: call.to, data: call.data })
    // Wait for inclusion. Errors here are surface-bubbled.
    const receipt = await txResp.wait()
    if (!receipt) {
      throw new Error(`submitEvidence tx ${txResp.hash} returned null receipt`)
    }
    if (receipt.status !== 1) {
      throw new Error(`submitEvidence tx reverted (txHash=${txResp.hash})`)
    }
    return { txHash: txResp.hash, nodeId: finalNodeId }
  }

  /** Diagnostic: how many validator entries are cached. */
  cacheSize(): number {
    return this.addressToNodeId.size
  }
}
