// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Treasury
 * @notice DAO treasury with 3/5 multisig and governance-enforced spending limits.
 *
 * - 3-of-5 signer threshold for all withdrawals
 * - Single withdrawal capped at 5% of treasury balance
 * - Withdrawals exceeding 5% require DAO proposal (external governance contract)
 * - Receives slash proceeds (20% of PoSe penalties) and other deposits
 */
contract Treasury {
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

    event Deposit(address indexed from, uint256 amount);
    event ProposalCreated(uint256 indexed proposalId, address indexed to, uint256 amount);
    event ProposalConfirmed(uint256 indexed proposalId, address indexed signer);
    event ProposalExecuted(uint256 indexed proposalId, address indexed to, uint256 amount);
    event GovernanceUpdated(address indexed newGovernance);
    event SignerUpdated(uint8 indexed index, address indexed oldSigner, address indexed newSigner);

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
    error InvalidProposal();

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address[5] memory _signers, address _governance) {
        owner = msg.sender;
        governance = _governance;
        for (uint8 i = 0; i < MAX_SIGNERS; i++) {
            require(_signers[i] != address(0), "zero signer");
            signers[i] = _signers[i];
            isSigner[_signers[i]] = true;
        }
    }

    /**
     * @notice Propose a withdrawal. Any signer can propose.
     *         Proposer's confirmation is automatically counted.
     */
    function proposeWithdrawal(address to, uint256 amount) external onlySigner returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) revert InsufficientBalance();

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
        if (p.confirmations < REQUIRED_CONFIRMATIONS) revert NotEnoughConfirmations();
        if (address(this).balance < p.amount) revert InsufficientBalance();

        // Enforce 5% spending cap — amounts exceeding require DAO governance approval
        uint256 cap = (address(this).balance * SPENDING_CAP_BPS) / 10000;
        if (p.amount > cap && !p.governanceApproved) revert ExceedsSpendingCap();

        p.executed = true;

        (bool ok,) = payable(p.to).call{value: p.amount}("");
        if (!ok) revert TransferFailed();

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
        governance = _governance;
        emit GovernanceUpdated(_governance);
    }

    function replaceSigner(uint8 index, address newSigner) external onlyOwner {
        require(index < MAX_SIGNERS, "invalid index");
        if (newSigner == address(0)) revert ZeroAddress();
        address old = signers[index];
        isSigner[old] = false;
        signers[index] = newSigner;
        isSigner[newSigner] = true;
        emit SignerUpdated(index, old, newSigner);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }
}
