/**
 * Output root computation for COC Optimistic Rollup.
 *
 * The output root is a commitment to a specific L2 state at a given block height.
 * It is computed as keccak256(abi.encodePacked(l2BlockNumber, stateRoot, blockHash)),
 * matching the Solidity-side verification in RollupStateManager.sol.
 */

import { solidityPackedKeccak256 } from "ethers"
import type { Hex } from "./rollup-types.ts"

/**
 * Compute the output root for a given L2 block.
 *
 * @param l2BlockNumber - L2 block height
 * @param stateRoot     - EVM state trie root at this block
 * @param blockHash     - L2 block hash
 * @returns The output root as a hex string
 */
export function computeOutputRoot(
  l2BlockNumber: bigint,
  stateRoot: Hex,
  blockHash: Hex,
): Hex {
  return solidityPackedKeccak256(
    ["uint64", "bytes32", "bytes32"],
    [l2BlockNumber, stateRoot, blockHash],
  ) as Hex
}
