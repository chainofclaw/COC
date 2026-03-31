// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollupTypes} from "./RollupTypes.sol";

/// @title IRollupStateManager — interface for COC Optimistic Rollup state commitments
interface IRollupStateManager {
    // ── Events ──────────────────────────────────────────────────────────
    event OutputProposed(uint64 indexed l2BlockNumber, bytes32 outputRoot, address proposer);
    event OutputChallenged(uint64 indexed l2BlockNumber, address challenger, uint256 bond);
    event ChallengeResolved(uint64 indexed l2BlockNumber, bool proposerFault);
    event OutputFinalized(uint64 indexed l2BlockNumber, bytes32 outputRoot);

    // ── Errors ──────────────────────────────────────────────────────────
    error OutputAlreadySubmitted(uint64 l2BlockNumber);
    error OutputNotFound(uint64 l2BlockNumber);
    error OutputAlreadyFinalized(uint64 l2BlockNumber);
    error AlreadyChallenged(uint64 l2BlockNumber);
    error ChallengeWindowElapsed(uint64 l2BlockNumber);
    error ChallengeWindowNotElapsed(uint64 l2BlockNumber);
    error ChallengeNotFound(uint64 l2BlockNumber);
    error ChallengeAlreadyResolved(uint64 l2BlockNumber);
    error InsufficientBond(uint256 required, uint256 provided);
    error BlockNumberNotIncreasing(uint64 provided, uint64 lastSubmitted);

    // ── Write ───────────────────────────────────────────────────────────
    function submitOutputRoot(
        uint64 l2BlockNumber,
        bytes32 outputRoot,
        bytes32 l2StateRoot
    ) external payable;

    function challengeOutputRoot(uint64 l2BlockNumber) external payable;

    function resolveChallenge(
        uint64 l2BlockNumber,
        bytes32 correctStateRoot
    ) external;

    function finalizeOutput(uint64 l2BlockNumber) external;

    // ── Read ────────────────────────────────────────────────────────────
    function getOutputProposal(uint64 l2BlockNumber)
        external view returns (RollupTypes.OutputProposal memory);

    function getChallenge(uint64 l2BlockNumber)
        external view returns (RollupTypes.OutputChallenge memory);

    function getLatestFinalizedL2Block() external view returns (uint64);

    function isOutputFinalized(uint64 l2BlockNumber) external view returns (bool);

    function CHALLENGE_WINDOW() external view returns (uint256);
    function PROPOSER_BOND() external view returns (uint256);
    function CHALLENGER_BOND() external view returns (uint256);
}
