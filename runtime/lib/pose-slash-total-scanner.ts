/**
 * Phase I4b — PoSe slashTotal chain scanner
 *
 * Wraps the I4a estimator (computeExpectedSlashTotal) with the on-chain
 * data fetch needed by `coc-relayer.ts:tryFinalizeV2`. Walks
 * `ChallengeRevealed` events emitted by `PoSeManagerV2` for an epoch's
 * window, filters by `challengeFaultConfirmed`, reads each offender's
 * bond + already-slashed amount, and feeds the resulting list into the
 * pure helper.
 *
 * The relayer activates this path when `COC_RELAYER_AUTO_SLASH=1`. When
 * off, the manifest's `slashTotal` field continues to be the source of
 * truth (today's behaviour). The scanner is a *fallback* when the
 * manifest generator hasn't been upgraded to compute slashTotal itself.
 */

import { Interface, type Provider } from "ethers"
import type { FaultConfirmedChallenge } from "./pose-slash-total.ts"
import { computeExpectedSlashTotal } from "./pose-slash-total.ts"

const POSE_V2_SCANNER_ABI = [
  "event ChallengeRevealed(bytes32 indexed challengeId, bytes32 targetNodeId, uint8 faultType)",
  "function challengeFaultConfirmed(bytes32) view returns (bool)",
  "function challenges(bytes32 challengeId) view returns (tuple(bytes32 commitHash, address challenger, uint256 bond, uint64 commitEpoch, uint64 revealDeadlineEpoch, bool revealed, bool settled, bytes32 targetNodeId, uint8 faultType))",
  "function getNode(bytes32 nodeId) view returns (tuple(bytes32 nodeId, bytes pubkeyNode, uint8 serviceFlags, bytes32 serviceCommitment, bytes32 endpointCommitment, uint256 bondAmount, bytes32 metadataHash, uint64 registeredAtEpoch, uint64 unlockEpoch, bool active))",
  "function epochNodeSlashed(uint64 epoch, bytes32 nodeId) view returns (uint256)",
] as const

export interface PoSeSlashTotalScannerOpts {
  provider: Provider
  poseManagerV2Address: string
  /**
   * Earliest block to scan for ChallengeRevealed events. Defaults to 0.
   * Pass the contract's deploy block to skip irrelevant history.
   */
  fromBlock?: bigint
}

export class PoSeSlashTotalScanner {
  private readonly provider: Provider
  private readonly poseAddress: string
  private readonly fromBlock: bigint
  private readonly iface = new Interface(POSE_V2_SCANNER_ABI as unknown as string[])

  constructor(opts: PoSeSlashTotalScannerOpts) {
    this.provider = opts.provider
    this.poseAddress = opts.poseManagerV2Address
    this.fromBlock = opts.fromBlock ?? 0n
  }

  /**
   * Compute the expected slashTotal for `epochId` by scanning chain
   * state. Returns 0n when no fault-confirmed challenges fall in the
   * epoch's window (the common case on a healthy chain).
   *
   * The function is read-only — does NOT submit any tx. The caller
   * (relayer.tryFinalizeV2) decides whether to use the result.
   */
  async computeSlashTotalForEpoch(epochId: bigint): Promise<bigint> {
    const challenges = await this.collectFaultConfirmedChallenges(epochId)
    if (challenges.length === 0) return 0n
    return computeExpectedSlashTotal(challenges)
  }

  /**
   * Lower-level: return the per-challenge structures for the epoch so
   * callers can inspect / log before deciding to submit. Same path as
   * computeSlashTotalForEpoch but without the final reduction.
   */
  async collectFaultConfirmedChallenges(epochId: bigint): Promise<FaultConfirmedChallenge[]> {
    const tip = BigInt(await this.provider.getBlockNumber())
    if (tip < this.fromBlock) return []

    const filter = {
      address: this.poseAddress,
      fromBlock: this.fromBlock,
      toBlock: tip,
      topics: [this.iface.getEvent("ChallengeRevealed")!.topicHash],
    }
    const logs = await this.provider.getLogs(filter)

    const result: FaultConfirmedChallenge[] = []
    // Cache (epoch, nodeId) → alreadySlashed so multiple challenges
    // hitting the same node in the same epoch share the read.
    const slashedCache = new Map<string, bigint>()

    for (const rawLog of logs) {
      const parsed = this.iface.parseLog({ topics: rawLog.topics as string[], data: rawLog.data })
      if (!parsed || parsed.name !== "ChallengeRevealed") continue
      const challengeId = parsed.args[0] as string

      // Confirm the fault was upheld on-chain.
      const confirmedRet: unknown = await this.callView("challengeFaultConfirmed", [challengeId])
      const confirmed = Boolean(confirmedRet)
      if (!confirmed) continue

      // Pull challenge metadata for slashEpoch determination.
      const challenge: unknown = await this.callView("challenges", [challengeId])
      const targetNodeId = (challenge as { targetNodeId: string }).targetNodeId
      const commitEpoch = BigInt((challenge as { commitEpoch: bigint | string | number }).commitEpoch)

      // Filter to the epoch we're finalizing. challengeFaultEpochPlusOne
      // (the contract's slashEpoch derivation) defaults to commitEpoch
      // when no proof was attached; commitEpoch is therefore the safest
      // approximation and matches the contract's own settleChallenge
      // logic when proofEpochPlusOne == 0. Off-by-one in either
      // direction would over-attribute slash to a neighbouring epoch
      // but never inflate cluster-wide totals.
      if (commitEpoch !== epochId) continue

      // Read bond + already-slashed for this (epoch, nodeId) pair.
      const cacheKey = `${epochId.toString()}|${targetNodeId.toLowerCase()}`
      let alreadySlashed = slashedCache.get(cacheKey)
      if (alreadySlashed === undefined) {
        const slashedRet: unknown = await this.callView("epochNodeSlashed", [epochId, targetNodeId])
        alreadySlashed = BigInt(slashedRet as bigint | string | number)
        slashedCache.set(cacheKey, alreadySlashed)
      }
      const node: unknown = await this.callView("getNode", [targetNodeId])
      const bondAmount = BigInt((node as { bondAmount: bigint | string | number }).bondAmount)

      result.push({
        targetNodeId,
        bondAmountWei: bondAmount,
        alreadySlashedThisEpochWei: alreadySlashed,
      })
    }

    return result
  }

  /**
   * Generic call wrapper that uses the provider's `call` to invoke a
   * function from `POSE_V2_SCANNER_ABI`. Decoded result returned as
   * unknown; caller asserts shape.
   */
  private async callView(name: string, args: unknown[]): Promise<unknown> {
    const data = this.iface.encodeFunctionData(name, args)
    const ret = await this.provider.call({ to: this.poseAddress, data })
    const decoded = this.iface.decodeFunctionResult(name, ret)
    return decoded.length === 1 ? decoded[0] : decoded
  }
}
