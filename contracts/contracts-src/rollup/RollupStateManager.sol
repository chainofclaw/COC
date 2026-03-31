// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollupTypes} from "./RollupTypes.sol";
import {IRollupStateManager} from "./IRollupStateManager.sol";

/// @title RollupStateManager — COC Optimistic Rollup state commitment and challenge game
/// @notice Manages L2 output root proposals, challenges, and finalization.
///         Proposers submit output roots for L2 block ranges; challengers can dispute
///         within the challenge window. After the window elapses without challenge (or
///         after challenge resolution in proposer's favor), outputs are finalized.
contract RollupStateManager is IRollupStateManager {
    // ── Configuration (immutable after deploy) ──────────────────────────
    uint256 public immutable override CHALLENGE_WINDOW;
    uint256 public immutable override PROPOSER_BOND;
    uint256 public immutable override CHALLENGER_BOND;

    // ── Slash distribution (basis points, must sum to 10000) ────────────
    uint256 public constant SLASH_BURN_BPS       = 5000; // 50% burned
    uint256 public constant SLASH_CHALLENGER_BPS = 3000; // 30% to challenger
    uint256 public constant SLASH_INSURANCE_BPS  = 2000; // 20% to insurance fund

    // ── State ───────────────────────────────────────────────────────────
    mapping(uint64 => RollupTypes.OutputProposal) private _outputs;
    mapping(uint64 => RollupTypes.OutputChallenge) private _challenges;
    uint64 public lastSubmittedBlock;
    uint64 private _latestFinalizedBlock;
    address public insuranceFund;

    constructor(
        uint256 challengeWindowSeconds,
        uint256 proposerBondWei,
        uint256 challengerBondWei,
        address insuranceFundAddress
    ) {
        require(challengeWindowSeconds > 0, "challenge window must be > 0");
        require(proposerBondWei > 0, "proposer bond must be > 0");
        require(challengerBondWei > 0, "challenger bond must be > 0");
        CHALLENGE_WINDOW = challengeWindowSeconds;
        PROPOSER_BOND = proposerBondWei;
        CHALLENGER_BOND = challengerBondWei;
        insuranceFund = insuranceFundAddress;
    }

    // ── Submit Output Root ──────────────────────────────────────────────

    /// @notice Proposer submits an output root for a given L2 block number.
    /// @param l2BlockNumber The L2 block height this output covers
    /// @param outputRoot    keccak256(l2BlockNumber, stateRoot, blockHash)
    /// @param l2StateRoot   The raw L2 EVM state trie root
    function submitOutputRoot(
        uint64 l2BlockNumber,
        bytes32 outputRoot,
        bytes32 l2StateRoot
    ) external payable override {
        if (msg.value < PROPOSER_BOND) {
            revert InsufficientBond(PROPOSER_BOND, msg.value);
        }
        if (l2BlockNumber <= lastSubmittedBlock) {
            revert BlockNumberNotIncreasing(l2BlockNumber, lastSubmittedBlock);
        }
        if (_outputs[l2BlockNumber].l1Timestamp != 0) {
            revert OutputAlreadySubmitted(l2BlockNumber);
        }

        _outputs[l2BlockNumber] = RollupTypes.OutputProposal({
            outputRoot: outputRoot,
            l2StateRoot: l2StateRoot,
            l2BlockNumber: l2BlockNumber,
            l1Timestamp: uint64(block.timestamp),
            proposer: msg.sender,
            challenged: false,
            finalized: false
        });

        lastSubmittedBlock = l2BlockNumber;
        emit OutputProposed(l2BlockNumber, outputRoot, msg.sender);
    }

    // ── Challenge Output Root ───────────────────────────────────────────

    /// @notice Challenge an output root within the challenge window.
    /// @param l2BlockNumber The L2 block number whose output is being challenged
    function challengeOutputRoot(uint64 l2BlockNumber) external payable override {
        RollupTypes.OutputProposal storage proposal = _outputs[l2BlockNumber];
        if (proposal.l1Timestamp == 0) {
            revert OutputNotFound(l2BlockNumber);
        }
        if (proposal.finalized) {
            revert OutputAlreadyFinalized(l2BlockNumber);
        }
        if (proposal.challenged) {
            revert AlreadyChallenged(l2BlockNumber);
        }
        if (block.timestamp > proposal.l1Timestamp + CHALLENGE_WINDOW) {
            revert ChallengeWindowElapsed(l2BlockNumber);
        }
        if (msg.value < CHALLENGER_BOND) {
            revert InsufficientBond(CHALLENGER_BOND, msg.value);
        }

        proposal.challenged = true;

        _challenges[l2BlockNumber] = RollupTypes.OutputChallenge({
            l2BlockNumber: l2BlockNumber,
            challenger: msg.sender,
            bond: msg.value,
            createdAt: uint64(block.timestamp),
            resolveDeadline: uint64(block.timestamp + CHALLENGE_WINDOW),
            resolved: false,
            proposerFault: false
        });

        emit OutputChallenged(l2BlockNumber, msg.sender, msg.value);
    }

    // ── Resolve Challenge ───────────────────────────────────────────────

    /// @notice Resolve a challenge by providing the correct state root.
    ///         Phase 38: simple state root comparison.
    ///         Phase 39+: will upgrade to interactive bisection game.
    /// @param l2BlockNumber    The disputed L2 block
    /// @param correctStateRoot The correct state root (verified off-chain by re-execution)
    function resolveChallenge(
        uint64 l2BlockNumber,
        bytes32 correctStateRoot
    ) external override {
        RollupTypes.OutputChallenge storage challenge = _challenges[l2BlockNumber];
        if (challenge.createdAt == 0) {
            revert ChallengeNotFound(l2BlockNumber);
        }
        if (challenge.resolved) {
            revert ChallengeAlreadyResolved(l2BlockNumber);
        }

        RollupTypes.OutputProposal storage proposal = _outputs[l2BlockNumber];

        // Phase 38: simple state root comparison
        // If the proposer's state root doesn't match the correct one, proposer is at fault
        bool proposerAtFault = (proposal.l2StateRoot != correctStateRoot);

        challenge.resolved = true;
        challenge.proposerFault = proposerAtFault;

        if (proposerAtFault) {
            // Slash proposer bond: 50% burn, 30% challenger, 20% insurance
            uint256 totalSlash = PROPOSER_BOND;
            uint256 burnAmount = (totalSlash * SLASH_BURN_BPS) / 10000;
            uint256 challengerReward = (totalSlash * SLASH_CHALLENGER_BPS) / 10000;
            uint256 insuranceAmount = totalSlash - burnAmount - challengerReward;

            // Burn by sending to address(0) is not possible in EVM, so we just keep it locked
            // Return challenger bond + reward
            _safeTransfer(challenge.challenger, challenge.bond + challengerReward);

            // Send insurance portion
            if (insuranceFund != address(0) && insuranceAmount > 0) {
                _safeTransfer(insuranceFund, insuranceAmount);
            }

            // Invalidate the output (do NOT finalize)
            delete _outputs[l2BlockNumber];
            // Reset lastSubmittedBlock if this was the latest
            if (l2BlockNumber == lastSubmittedBlock) {
                // Simplified: in production, scan backward for last valid output
                lastSubmittedBlock = 0;
            }
        } else {
            // Challenger was wrong — forfeit challenger bond to proposer
            _safeTransfer(proposal.proposer, challenge.bond);
        }

        emit ChallengeResolved(l2BlockNumber, proposerAtFault);
    }

    // ── Finalize Output ─────────────────────────────────────────────────

    /// @notice Finalize an output after the challenge window elapses.
    /// @param l2BlockNumber The L2 block to finalize
    function finalizeOutput(uint64 l2BlockNumber) external override {
        RollupTypes.OutputProposal storage proposal = _outputs[l2BlockNumber];
        if (proposal.l1Timestamp == 0) {
            revert OutputNotFound(l2BlockNumber);
        }
        if (proposal.finalized) {
            revert OutputAlreadyFinalized(l2BlockNumber);
        }
        if (proposal.challenged) {
            // Check if challenge was resolved in proposer's favor
            RollupTypes.OutputChallenge storage challenge = _challenges[l2BlockNumber];
            if (!challenge.resolved) {
                revert ChallengeWindowNotElapsed(l2BlockNumber);
            }
            // If proposer was at fault, output was already deleted in resolveChallenge
            // If challenger was wrong, we can finalize
        } else {
            // No challenge — check window elapsed
            if (block.timestamp <= proposal.l1Timestamp + CHALLENGE_WINDOW) {
                revert ChallengeWindowNotElapsed(l2BlockNumber);
            }
        }

        proposal.finalized = true;

        // Refund proposer bond
        _safeTransfer(proposal.proposer, PROPOSER_BOND);

        // Update latest finalized block
        if (l2BlockNumber > _latestFinalizedBlock) {
            _latestFinalizedBlock = l2BlockNumber;
        }

        emit OutputFinalized(l2BlockNumber, proposal.outputRoot);
    }

    // ── Read Methods ────────────────────────────────────────────────────

    function getOutputProposal(uint64 l2BlockNumber)
        external view override returns (RollupTypes.OutputProposal memory)
    {
        return _outputs[l2BlockNumber];
    }

    function getChallenge(uint64 l2BlockNumber)
        external view override returns (RollupTypes.OutputChallenge memory)
    {
        return _challenges[l2BlockNumber];
    }

    function getLatestFinalizedL2Block() external view override returns (uint64) {
        return _latestFinalizedBlock;
    }

    function isOutputFinalized(uint64 l2BlockNumber) external view override returns (bool) {
        return _outputs[l2BlockNumber].finalized;
    }

    // ── Internal ────────────────────────────────────────────────────────

    function _safeTransfer(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice Accept ETH deposits (for bond top-ups)
    receive() external payable {}
}
