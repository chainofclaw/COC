// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title Treasury
 * @notice DAO treasury with 3/5 multisig and governance-enforced spending limits.
 *
 * - 3-of-5 signer threshold for all withdrawals
 * - Single withdrawal capped at 5% of treasury balance
 * - Withdrawals exceeding 5% require DAO proposal (external governance contract)
 * - Receives slash proceeds (20% of PoSe penalties) and other deposits
 */
contract Treasury is Initializable, UUPSUpgradeable {
    uint8 public constant REQUIRED_CONFIRMATIONS = 3;
    uint8 public constant MAX_SIGNERS = 5;
    uint16 public constant SPENDING_CAP_BPS = 500; // 5% of balance

    address public governance;  // DAO governance contract (for >5% withdrawals)
    address public owner;
    address[5] public signers;
    mapping(address => bool) public isSigner;

    struct Proposal {
        address to;
        uint256 amount;
        uint8 confirmations;
        bool executed;
        bool governanceApproved; // true if >5% and DAO-approved
        mapping(address => bool) confirmed;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public pendingWithdrawalTotal;
    /**
     * #15 (audit follow-up): address has historically served as a
     * signer at least once. Set in `replaceSigner` for the OLD signer
     * being removed, never cleared. Used to surface a warning event
     * when `replaceSigner` re-adds an address that previously served:
     * that address's `confirmed[]` bits on pending proposals are still
     * `true` and will silently re-count once the address is back in
     * `signers[]`, so operators must `cancel + re-propose` any pending
     * proposals before re-adding. Append-only storage slot — safe to
     * add under UUPS without breaking layout.
     */
    mapping(address => bool) public wasSignerHistorical;

    event Deposit(address indexed from, uint256 amount);
    event ProposalCreated(uint256 indexed proposalId, address indexed to, uint256 amount);
    event ProposalConfirmed(uint256 indexed proposalId, address indexed signer);
    event ProposalExecuted(uint256 indexed proposalId, address indexed to, uint256 amount);
    event WithdrawalCredited(address indexed payee, uint256 amount);
    event WithdrawalClaimed(address indexed payee, uint256 amount);
    event GovernanceUpdated(address indexed newGovernance);
    event SignerUpdated(uint8 indexed index, address indexed oldSigner, address indexed newSigner);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    /**
     * #15: emitted when `replaceSigner` re-adds an address that has
     * served as a signer in the past. The address's `confirmed[]` bits
     * on any pending proposals are still set from the previous tenure
     * and will silently re-count toward the 3-of-5 threshold once the
     * address is back in `signers[]`. Operators MUST cancel + recreate
     * any pending proposals (or wait for them to execute) before
     * re-adding a historical signer, otherwise stale confirmations
     * from the prior tenure resurrect on re-entry. Defence-in-depth
     * warning only — the runtime path is not blocked.
     */
    event ReusingHistoricalSigner(uint8 indexed index, address indexed signer);

    error NotSigner();
    error NotOwner();
    error NotGovernance();
    error AlreadyConfirmed();
    error NotEnoughConfirmations();
    error AlreadyExecuted();
    error InsufficientBalance();
    error ExceedsSpendingCap();
    error TransferFailed();
    error ZeroAmount();
    error ZeroAddress();
    error DuplicateSigner();
    error InvalidProposal();
    error NoPendingWithdrawal();

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address[5] memory _signers,
        address _governance,
        address initialOwner
    ) external initializer {
        if (_governance == address(0) || initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        governance = _governance;
        for (uint8 i = 0; i < MAX_SIGNERS; i++) {
            if (_signers[i] == address(0)) revert ZeroAddress();
            if (isSigner[_signers[i]]) revert DuplicateSigner();
            signers[i] = _signers[i];
            isSigner[_signers[i]] = true;
        }
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /**
     * @notice Propose a withdrawal. Any signer can propose.
     *         Proposer's confirmation is automatically counted.
     */
    function proposeWithdrawal(address to, uint256 amount) external onlySigner returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_availableBalance() < amount) revert InsufficientBalance();

        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];
        p.to = to;
        p.amount = amount;
        p.confirmations = 1;
        p.confirmed[msg.sender] = true;

        emit ProposalCreated(id, to, amount);
        emit ProposalConfirmed(id, msg.sender);
        return id;
    }

    /**
     * @notice Confirm a pending withdrawal proposal.
     */
    function confirmWithdrawal(uint256 proposalId) external onlySigner {
        if (proposalId >= proposalCount) revert InvalidProposal();
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted();
        if (p.confirmed[msg.sender]) revert AlreadyConfirmed();

        p.confirmed[msg.sender] = true;
        p.confirmations += 1;

        emit ProposalConfirmed(proposalId, msg.sender);
    }

    /**
     * @notice Execute a confirmed withdrawal.
     *         Requires 3/5 confirmations.
     *         Amounts > 5% of balance also require governance approval.
     */
    function executeWithdrawal(uint256 proposalId) external onlySigner {
        if (proposalId >= proposalCount) revert InvalidProposal();
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted();
        // Count confirmations over the CURRENT signer set (#719). The raw
        // `p.confirmations` counter is not decremented by `replaceSigner`, so
        // a removed signer's stale confirmation would otherwise still count
        // toward the 3-of-5 threshold.
        if (_currentConfirmations(p) < REQUIRED_CONFIRMATIONS) revert NotEnoughConfirmations();
        uint256 available = _availableBalance();
        if (available < p.amount) revert InsufficientBalance();

        // Enforce 5% spending cap — amounts exceeding require DAO governance approval
        uint256 cap = (available * SPENDING_CAP_BPS) / 10000;
        if (p.amount > cap && !p.governanceApproved) revert ExceedsSpendingCap();

        p.executed = true;

        _payOrCredit(p.to, p.amount);

        emit ProposalExecuted(proposalId, p.to, p.amount);
    }

    /**
     * @notice DAO governance approves a proposal exceeding 5% spending cap.
     */
    function governanceApprove(uint256 proposalId) external {
        if (msg.sender != governance) revert NotGovernance();
        if (proposalId >= proposalCount) revert InvalidProposal();
        proposals[proposalId].governanceApproved = true;
    }

    // --- Admin ---

    function setGovernance(address _governance) external onlyOwner {
        if (_governance == address(0)) revert ZeroAddress();
        governance = _governance;
        emit GovernanceUpdated(_governance);
    }

    /// @notice Transfer contract ownership (#686 — moves owner to a multisig).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function replaceSigner(uint8 index, address newSigner) external onlyOwner {
        require(index < MAX_SIGNERS, "invalid index");
        if (newSigner == address(0)) revert ZeroAddress();
        address old = signers[index];
        if (newSigner != old && isSigner[newSigner]) revert DuplicateSigner();
        // #15: record OLD signer as historical BEFORE we remove them.
        // This catches the case where `replaceSigner` is called with
        // `newSigner == old` (no-op identity churn) — they're already
        // a current signer, so we don't need to flag them as historical,
        // but updating the bit is harmless and keeps the semantics
        // simple: "this address has ever been a signer".
        wasSignerHistorical[old] = true;
        isSigner[old] = false;
        signers[index] = newSigner;
        isSigner[newSigner] = true;
        // #15: surface a warning event if the new signer is being
        // re-added after a prior tenure — operators must verify no
        // pending proposals carry stale confirmations from their
        // previous slot before relying on the 3-of-5 threshold.
        if (wasSignerHistorical[newSigner] && newSigner != old) {
            emit ReusingHistoricalSigner(index, newSigner);
        }
        emit SignerUpdated(index, old, newSigner);
    }

    function withdrawPayments() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingWithdrawals[msg.sender] = 0;
        pendingWithdrawalTotal -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit WithdrawalClaimed(msg.sender, amount);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function availableBalance() external view returns (uint256) {
        return _availableBalance();
    }

    function _availableBalance() internal view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > pendingWithdrawalTotal ? balance - pendingWithdrawalTotal : 0;
    }

    /// @notice Confirmations on a proposal from the CURRENT signer set (#719).
    ///         `replaceSigner` does not revisit pending proposals, so the raw
    ///         `p.confirmations` counter can include confirmations from
    ///         signers that have since been removed. Recomputing over
    ///         `signers` is the source of truth for the 3-of-5 threshold.
    function _currentConfirmations(Proposal storage p) internal view returns (uint8 count) {
        for (uint8 i = 0; i < MAX_SIGNERS; i++) {
            if (p.confirmed[signers[i]]) count++;
        }
    }

    /// @notice Confirmations on `proposalId` counted over the current signer
    ///         set — what `executeWithdrawal` actually gates on.
    function currentConfirmations(uint256 proposalId) external view returns (uint8) {
        if (proposalId >= proposalCount) revert InvalidProposal();
        return _currentConfirmations(proposals[proposalId]);
    }

    function _payOrCredit(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[to] += amount;
            pendingWithdrawalTotal += amount;
            emit WithdrawalCredited(to, amount);
        }
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // UUPS storage gap — append-only state from now on. Decremented from
    // 50 → 49 when #15(3) (PR #741) added `wasSignerHistorical` above.
    uint256[49] private __gap;
}
