// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {FactionRegistry} from "./FactionRegistry.sol";

/// @title GovernanceDAO - Multi-type proposals with stake-weighted voting
/// @notice Supports bicameral mode where both factions must independently approve.
///         UUPS upgradeable since 88780 gen-5; upgrade gated on `owner` (the
///         88780 multisig). Bicameral check fixed for silent-faction (#705).
contract GovernanceDAO is Initializable, UUPSUpgradeable {
    enum ProposalType { ValidatorAdd, ValidatorRemove, ParameterChange, TreasurySpend, ContractUpgrade, FreeText }
    enum ProposalState { Pending, Approved, Rejected, Queued, Executed, Cancelled, Expired }

    struct Proposal {
        uint256 id;
        // Registered population (human + claw) captured at creation. Quorum is
        // judged against this snapshot so the denominator cannot be inflated
        // by permissionless registrations after voting closes.
        uint256 registeredSnapshot;
        // #705: per-faction count snapshots at creation so the bicameral
        // approval check can distinguish "faction did not exist at creation"
        // (auto-pass) from "faction exists but stayed silent" (must NOT pass).
        uint256 humanSnapshot;
        uint256 clawSnapshot;
        ProposalType proposalType;
        address proposer;
        string title;
        bytes32 descriptionHash;
        address executionTarget;
        bytes executionData;
        uint256 value;
        uint64 createdAt;
        uint64 votingDeadline;
        uint64 executionDeadline;
        uint256 forVotesHuman;
        uint256 againstVotesHuman;
        uint256 forVotesClaw;
        uint256 againstVotesClaw;
        uint256 abstainVotes;
        ProposalState state;
    }

    FactionRegistry public factionRegistry;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // Governance parameters (set in `initialize`; mutable via owner setters).
    uint64 public votingPeriod;
    uint64 public timelockDelay;
    uint256 public quorumPercent;
    uint256 public approvalPercent;
    bool public bicameralEnabled;

    address public owner;
    address public treasury;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, ProposalType proposalType, string title);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, FactionRegistry.Faction faction);
    event ProposalQueued(uint256 indexed proposalId, uint64 executionDeadline);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event ParameterUpdated(string paramName, uint256 newValue);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    error NotRegistered();
    error AlreadyVoted();
    error VotingClosed();
    error VotingNotEnded();
    error NotApproved();
    error NotQueued();
    error TimelockNotElapsed();
    error ExecutionFailed();
    error InvalidProposal();
    error NotOwner();
    error NotProposer();
    error ProposalNotPending();
    error InvalidParameter();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRegistered() {
        if (factionRegistry.getFaction(msg.sender) == FactionRegistry.Faction.None) revert NotRegistered();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _factionRegistry, address initialOwner) external initializer {
        require(_factionRegistry != address(0) && initialOwner != address(0), "zero address");
        factionRegistry = FactionRegistry(_factionRegistry);
        owner = initialOwner;
        votingPeriod = 7 days;
        timelockDelay = 2 days;
        quorumPercent = 40;
        approvalPercent = 60;
        bicameralEnabled = false;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    function createProposal(
        ProposalType proposalType,
        string calldata title,
        bytes32 descriptionHash,
        address executionTarget,
        bytes calldata executionData,
        uint256 value
    ) external onlyRegistered returns (uint256) {
        if (bytes(title).length == 0) revert InvalidProposal();

        proposalCount += 1;
        uint256 proposalId = proposalCount;
        uint64 deadline = uint64(block.timestamp) + votingPeriod;

        uint256 humanSnap = factionRegistry.humanCount();
        uint256 clawSnap = factionRegistry.clawCount();
        proposals[proposalId] = Proposal({
            id: proposalId,
            registeredSnapshot: humanSnap + clawSnap,
            humanSnapshot: humanSnap,
            clawSnapshot: clawSnap,
            proposalType: proposalType,
            proposer: msg.sender,
            title: title,
            descriptionHash: descriptionHash,
            executionTarget: executionTarget,
            executionData: executionData,
            value: value,
            createdAt: uint64(block.timestamp),
            votingDeadline: deadline,
            executionDeadline: 0,
            forVotesHuman: 0,
            againstVotesHuman: 0,
            forVotesClaw: 0,
            againstVotesClaw: 0,
            abstainVotes: 0,
            state: ProposalState.Pending
        });

        emit ProposalCreated(proposalId, msg.sender, proposalType, title);
        return proposalId;
    }

    /// @param support 0 = against, 1 = for, 2 = abstain
    function vote(uint256 proposalId, uint8 support) external onlyRegistered {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Pending) revert VotingClosed();
        if (block.timestamp > p.votingDeadline) revert VotingClosed();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        hasVoted[proposalId][msg.sender] = true;
        FactionRegistry.Faction faction = factionRegistry.getFaction(msg.sender);

        if (support == 2) {
            p.abstainVotes += 1;
        } else if (support == 1) {
            if (faction == FactionRegistry.Faction.Human) {
                p.forVotesHuman += 1;
            } else {
                p.forVotesClaw += 1;
            }
        } else {
            if (faction == FactionRegistry.Faction.Human) {
                p.againstVotesHuman += 1;
            } else {
                p.againstVotesClaw += 1;
            }
        }

        emit VoteCast(proposalId, msg.sender, support == 1, faction);
    }

    function queue(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Pending) revert ProposalNotPending();
        if (block.timestamp <= p.votingDeadline) revert VotingNotEnded();

        if (_isApproved(p)) {
            p.state = ProposalState.Queued;
            p.executionDeadline = uint64(block.timestamp) + timelockDelay;
            emit ProposalQueued(proposalId, p.executionDeadline);
        } else {
            p.state = ProposalState.Rejected;
        }
    }

    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Queued) revert NotQueued();
        if (block.timestamp < p.executionDeadline) revert TimelockNotElapsed();

        p.state = ProposalState.Executed;

        // FreeText proposals have no execution
        if (p.proposalType != ProposalType.FreeText && p.executionTarget != address(0)) {
            (bool success,) = p.executionTarget.call{value: p.value}(p.executionData);
            if (!success) revert ExecutionFailed();
        }

        emit ProposalExecuted(proposalId);
    }

    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (msg.sender != p.proposer && msg.sender != owner) revert NotProposer();
        if (p.state != ProposalState.Pending && p.state != ProposalState.Queued) revert ProposalNotPending();

        p.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId);
    }

    // Governance parameter setters (called via governance proposals targeting this contract)
    function setVotingPeriod(uint64 _votingPeriod) external onlyOwner {
        if (_votingPeriod < 1 days || _votingPeriod > 30 days) revert InvalidParameter();
        votingPeriod = _votingPeriod;
        emit ParameterUpdated("votingPeriod", _votingPeriod);
    }

    function setTimelockDelay(uint64 _timelockDelay) external onlyOwner {
        if (_timelockDelay > 14 days) revert InvalidParameter();
        timelockDelay = _timelockDelay;
        emit ParameterUpdated("timelockDelay", _timelockDelay);
    }

    function setQuorumPercent(uint256 _quorumPercent) external onlyOwner {
        if (_quorumPercent < 10 || _quorumPercent > 80) revert InvalidParameter();
        quorumPercent = _quorumPercent;
        emit ParameterUpdated("quorumPercent", _quorumPercent);
    }

    function setApprovalPercent(uint256 _approvalPercent) external onlyOwner {
        if (_approvalPercent < 50 || _approvalPercent > 90) revert InvalidParameter();
        approvalPercent = _approvalPercent;
        emit ParameterUpdated("approvalPercent", _approvalPercent);
    }

    function setBicameralEnabled(bool _enabled) external onlyOwner {
        bicameralEnabled = _enabled;
    }

    /// @notice Transfer contract ownership (#686 — moves owner to a multisig).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    // View helpers
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }

    function getProposalState(uint256 proposalId) external view returns (ProposalState) {
        Proposal storage p = proposals[proposalId];
        if (p.state == ProposalState.Pending && block.timestamp > p.votingDeadline) {
            return _isApproved(p) ? ProposalState.Approved : ProposalState.Rejected;
        }
        return p.state;
    }

    function getVoteTotals(uint256 proposalId) external view returns (
        uint256 forHuman, uint256 againstHuman,
        uint256 forClaw, uint256 againstClaw,
        uint256 abstain
    ) {
        Proposal storage p = proposals[proposalId];
        return (p.forVotesHuman, p.againstVotesHuman, p.forVotesClaw, p.againstVotesClaw, p.abstainVotes);
    }

    function _isApproved(Proposal storage p) internal view returns (bool) {
        uint256 totalVotes = p.forVotesHuman + p.againstVotesHuman + p.forVotesClaw + p.againstVotesClaw + p.abstainVotes;
        uint256 totalRegistered = p.registeredSnapshot;

        // Quorum check
        if (totalRegistered > 0 && (totalVotes * 100) / totalRegistered < quorumPercent) {
            return false;
        }

        if (bicameralEnabled) {
            // #705: a faction that existed at proposal creation must cast at
            // least one non-abstain vote AND meet the approval threshold;
            // only a faction that did not exist at creation (snapshot==0) is
            // treated as auto-approved (preserves the empty-chamber
            // compatibility behaviour without auto-passing silent factions).
            uint256 humanTotal = p.forVotesHuman + p.againstVotesHuman;
            uint256 clawTotal = p.forVotesClaw + p.againstVotesClaw;
            bool humanApproved = p.humanSnapshot == 0
                || (humanTotal > 0 && (p.forVotesHuman * 100) / humanTotal >= approvalPercent);
            bool clawApproved = p.clawSnapshot == 0
                || (clawTotal > 0 && (p.forVotesClaw * 100) / clawTotal >= approvalPercent);
            return humanApproved && clawApproved;
        }

        // Simple majority (combined)
        uint256 totalFor = p.forVotesHuman + p.forVotesClaw;
        uint256 totalAgainst = p.againstVotesHuman + p.againstVotesClaw;
        uint256 totalCast = totalFor + totalAgainst;
        if (totalCast == 0) return false;
        return (totalFor * 100) / totalCast >= approvalPercent;
    }

    // UUPS storage gap — append-only state from now on.
    uint256[50] private __gap;
}
