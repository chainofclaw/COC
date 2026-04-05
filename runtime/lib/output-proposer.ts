/**
 * Output Proposer for COC Optimistic Rollup.
 *
 * Periodically reads L2 state roots and submits output proposals to the
 * L1 RollupStateManager contract. This anchors the L2 state on L1 for
 * fraud proof verification.
 */

import { computeOutputRoot } from "./rollup-output-root.ts"
import type { Hex, OutputProposal, ProposerState } from "./rollup-types.ts"

export interface OutputProposerConfig {
  readonly l2RpcUrl: string
  readonly proposalInterval: number  // submit every N L2 blocks
  readonly startBlock?: bigint       // resume from this block (default: last proposed + 1)
}

export interface L1Submitter {
  submitOutputRoot(l2BlockNumber: bigint, outputRoot: Hex, stateRoot: Hex, blockHash: Hex): Promise<Hex>
}

interface L2Block {
  readonly number: bigint
  readonly hash: Hex
  readonly stateRoot?: Hex
}

export class OutputProposer {
  private readonly cfg: OutputProposerConfig
  private readonly l1: L1Submitter
  private state: ProposerState
  private readonly proposals: OutputProposal[] = []

  constructor(cfg: OutputProposerConfig, l1Submitter: L1Submitter, initialState?: ProposerState) {
    this.cfg = cfg
    this.l1 = l1Submitter
    this.state = initialState ?? {
      lastProposedBlockNumber: cfg.startBlock ?? 0n,
      lastProposedOutputRoot: "0x" + "0".repeat(64) as Hex,
      lastProposedAtMs: 0,
    }
  }

  /**
   * Check if a new output proposal is due, and submit if so.
   * Called periodically by the runtime tick loop.
   */
  async tick(currentBlock: L2Block): Promise<OutputProposal | null> {
    const blocksSinceLastProposal = currentBlock.number - this.state.lastProposedBlockNumber
    if (blocksSinceLastProposal < BigInt(this.cfg.proposalInterval)) {
      return null
    }

    if (!currentBlock.stateRoot) {
      return null // stateRoot not yet available (deferred commit)
    }

    const outputRoot = computeOutputRoot(
      currentBlock.number,
      currentBlock.stateRoot,
      currentBlock.hash,
    )

    const txHash = await this.l1.submitOutputRoot(
      currentBlock.number,
      outputRoot,
      currentBlock.stateRoot,
      currentBlock.hash,
    )

    const proposal: OutputProposal = {
      l2BlockNumber: currentBlock.number,
      outputRoot,
      l2StateRoot: currentBlock.stateRoot,
      blockHash: currentBlock.hash,
      proposedAtMs: Date.now(),
      txHash,
    }

    this.proposals.push(proposal)
    this.state = {
      lastProposedBlockNumber: currentBlock.number,
      lastProposedOutputRoot: outputRoot,
      lastProposedAtMs: Date.now(),
    }

    return proposal
  }

  getState(): ProposerState {
    return { ...this.state }
  }

  getProposals(): readonly OutputProposal[] {
    return this.proposals
  }

  getLastProposal(): OutputProposal | null {
    return this.proposals.length > 0 ? this.proposals[this.proposals.length - 1] : null
  }
}
