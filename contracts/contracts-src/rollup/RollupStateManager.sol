// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {RollupTypes} from "./RollupTypes.sol";
import {IRollupStateManager} from "./IRollupStateManager.sol";

/// @title RollupStateManager — COC Optimistic Rollup state commitment and challenge game
/// @notice Manages L2 output root proposals, challenges, and finalization.
///         Proposers submit output roots for L2 block ranges; challengers can dispute
///         within the challenge window. After the window elapses without challenge (or
///         after challenge resolution in proposer's favor), outputs are finalized.
///         UUPS upgradeable since 88780 gen-5; upgrade gated on `owner` (the multisig).
contract RollupStateManager is IRollupStateManager, Initializable, UUPSUpgradeable {
    // ── Configuration (set in `initialize`; mutable across upgrades) ─────
    uint256 public override CHALLENGE_WINDOW;
    uint256 public override PROPOSER_BOND;
    uint256 public override CHALLENGER_BOND;

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
    address public owner;
    address public challengeResolver;
    mapping(address => uint256) public pendingWithdrawals;
    // #683: only allowlisted proposers may submit output roots. Without this
    // gate any account can submit a max-uint64 block number, jamming
    // lastSubmittedBlock and permanently bricking all future submissions.
    mapping(address => bool) public allowedProposers;

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyChallengeResolver() {
        if (msg.sender != challengeResolver) revert OnlyChallengeResolver();
        _;
    }

    modifier onlyProposer() {
        if (!allowedProposers[msg.sender]) revert NotProposer();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint256 challengeWindowSeconds,
        uint256 proposerBondWei,
        uint256 challengerBondWei,
        address insuranceFundAddress,
        address initialProposer,
        address initialOwner
    ) external initializer {
        require(challengeWindowSeconds > 0, "challenge window must be > 0");
        require(proposerBondWei > 0, "proposer bond must be > 0");
        require(challengerBondWei > 0, "challenger bond must be > 0");
        require(initialOwner != address(0), "owner cannot be zero");
        CHALLENGE_WINDOW = challengeWindowSeconds;
        PROPOSER_BOND = proposerBondWei;
        CHALLENGER_BOND = challengerBondWei;
        insuranceFund = insuranceFundAddress;
        owner = initialOwner;
        challengeResolver = initialOwner;
        if (initialProposer != address(0)) {
            allowedProposers[initialProposer] = true;
            emit ProposerUpdated(initialProposer, true);
        }
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Submit Output Root ──────────────────────────────────────────────

    /// @notice Proposer submits an output root for a given L2 block number.
    /// @param l2BlockNumber The L2 block height this output covers
    /// @param outputRoot    keccak256(l2BlockNumber, stateRoot, blockHash)
    /// @param l2StateRoot   The raw L2 EVM state trie root
    function submitOutputRoot(
        uint64 l2BlockNumber,
        bytes32 outputRoot,
        bytes32 l2StateRoot
    ) external payable override onlyProposer {
        if (msg.value < PROPOSER_BOND) {
            revert InsufficientBond(PROPOSER_BOND, msg.value);
        }
        if (msg.value > PROPOSER_BOND) {
            revert IncorrectBond(PROPOSER_BOND, msg.value);
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
        if (msg.value > CHALLENGER_BOND) {
            revert IncorrectBond(CHALLENGER_BOND, msg.value);
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
    ) external override onlyChallengeResolver {
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

            // Effects before interactions (CEI): invalidate the output up-front.
            // Otherwise a malicious challenger could reenter finalizeOutput()
            // during the payout below and refund the at-fault proposer's bond.
            delete _outputs[l2BlockNumber];
            // Reset lastSubmittedBlock if this was the latest
            if (l2BlockNumber == lastSubmittedBlock) {
                // Simplified: in production, scan backward for last valid output
                lastSubmittedBlock = 0;
            }

            // Burn by sending to address(0) is not possible in EVM, so we just keep it locked.
            // Return challenger bond + reward. A rejecting receiver must not
            // block challenge resolution, so failed payments become pull funds.
            _payOrCredit(challenge.challenger, challenge.bond + challengerReward);

            // Send insurance portion
            if (insuranceFund != address(0) && insuranceAmount > 0) {
                _payOrCredit(insuranceFund, insuranceAmount);
            }
        } else {
            // Challenger was wrong — forfeit challenger bond to proposer
            _payOrCredit(proposal.proposer, challenge.bond);
        }

        emit ChallengeResolved(l2BlockNumber, proposerAtFault);
    }

    /// @notice Update the authorized challenge resolver.
    /// @param newResolver Address allowed to resolve challenges.
    function setChallengeResolver(address newResolver) external override onlyOwner {
        if (newResolver == address(0)) revert ZeroAddress();

        address oldResolver = challengeResolver;
        challengeResolver = newResolver;
        emit ChallengeResolverUpdated(oldResolver, newResolver);
    }

    /// @notice Allowlist an address permitted to submit output roots (#683).
    function addProposer(address proposer) external onlyOwner {
        if (proposer == address(0)) revert ZeroAddress();
        allowedProposers[proposer] = true;
        emit ProposerUpdated(proposer, true);
    }

    /// @notice Remove an address from the output-root proposer allowlist (#683).
    function removeProposer(address proposer) external onlyOwner {
        allowedProposers[proposer] = false;
        emit ProposerUpdated(proposer, false);
    }

    /// @notice Transfer contract ownership (admin of the resolver + proposer set).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
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

        // Refund proposer bond. Rejected ETH must not block finalization.
        _payOrCredit(proposal.proposer, PROPOSER_BOND);

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

    /// @notice Claim ETH that could not be delivered during protocol payouts.
    function withdrawPayments() external override {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) {
            revert TransferFailed();
        }

        emit WithdrawalClaimed(msg.sender, amount);
    }

    // ── Internal ────────────────────────────────────────────────────────

    function _payOrCredit(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[to] += amount;
            emit WithdrawalCredited(to, amount);
        }
    }

    /// @notice Accept ETH deposits (for bond top-ups)
    receive() external payable {}

    // UUPS storage gap — append-only state from now on.
    uint256[50] private __gap;
}
