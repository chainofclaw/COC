import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

export function hashBlockPayload(input: {
  number: bigint
  parentHash: Hex
  proposer: string
  timestampMs: number
  txs: Hex[]
  baseFee?: bigint
  cumulativeWeight?: bigint
}): Hex {
  // baseFee and cumulativeWeight are pre-execution and bound into hash
  // gasUsed and stateRoot are post-execution — verified separately after tx replay
  const stable = `${input.number.toString()}|${input.parentHash}|${input.proposer}|${input.timestampMs}|${input.txs.join(",")}|${(input.baseFee ?? 0n).toString()}|${(input.cumulativeWeight ?? 0n).toString()}`
  return `0x${keccak256Hex(Buffer.from(stable, "utf-8"))}` as Hex
}

export function validateBlockLink(prev: ChainBlock | undefined, next: ChainBlock): boolean {
  if (!prev) {
    return next.number === 1n && next.parentHash === zeroHash()
  }
  return next.number === prev.number + 1n && next.parentHash === prev.hash
}

export function zeroHash(): Hex {
  return `0x${"0".repeat(64)}` as Hex
}
