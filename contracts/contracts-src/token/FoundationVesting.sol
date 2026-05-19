// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FoundationVesting
 * @notice Tiered release schedule for Foundation's 6% genesis allocation (60M COC).
 *
 * - Year 1: 1.5% (15M COC) available immediately for startup operations
 * - Remaining 4.5% (45M COC): 48-month linear vesting starting at deployment
 * - Quarterly spending cap: max 15% of current balance per quarter
 */
contract FoundationVesting {
    address public beneficiary;        // Foundation multisig or EOA
    address public owner;              // Deployer (can update beneficiary)

    uint256 public constant IMMEDIATE_RELEASE = 15_000_000 ether;   // 15M COC
    uint256 public constant VESTED_AMOUNT = 45_000_000 ether;       // 45M COC
    uint256 public constant VESTING_DURATION = 48 * 30 days;        // 48 months
    uint16 public constant QUARTERLY_CAP_BPS = 1500;                // 15%
    uint256 public constant QUARTER = 90 days;

    uint256 public vestingStart;
    uint256 public totalReleased;
    uint256 public quarterStart;
    uint256 public quarterReleased;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public pendingWithdrawalTotal;

    event Released(address indexed to, uint256 amount);
    event WithdrawalCredited(address indexed payee, uint256 amount);
    event WithdrawalClaimed(address indexed payee, uint256 amount);
    event BeneficiaryUpdated(address indexed oldBeneficiary, address indexed newBeneficiary);

    error NotOwner();
    error NotBeneficiary();
    error NothingToRelease();
    error QuarterlyCapExceeded();
    error TransferFailed();
    error ZeroAddress();
    error NoPendingWithdrawal();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyBeneficiary() {
        if (msg.sender != beneficiary) revert NotBeneficiary();
        _;
    }

    constructor(address _beneficiary) {
        if (_beneficiary == address(0)) revert ZeroAddress();
        owner = msg.sender;
        beneficiary = _beneficiary;
        vestingStart = block.timestamp;
        quarterStart = block.timestamp;
    }

    /**
     * @notice Total amount vested (unlocked) up to now.
     */
    function vestedAmount() public view returns (uint256) {
        uint256 elapsed = block.timestamp - vestingStart;
        uint256 linearVested = elapsed >= VESTING_DURATION
            ? VESTED_AMOUNT
            : (VESTED_AMOUNT * elapsed) / VESTING_DURATION;
        return IMMEDIATE_RELEASE + linearVested;
    }

    /**
     * @notice Amount currently available to release (vested minus already released).
     */
    function releasable() public view returns (uint256) {
        uint256 vested = vestedAmount();
        return vested > totalReleased ? vested - totalReleased : 0;
    }

    /**
     * @notice Remaining quarterly budget.
     */
    function quarterlyRemaining() public view returns (uint256) {
        if (block.timestamp >= quarterStart + QUARTER) {
            // New quarter — full budget available
            uint256 currentBalance = _availableBalance();
            return (currentBalance * QUARTERLY_CAP_BPS) / 10000;
        }
        uint256 balance = _availableBalance();
        uint256 cap = (balance * QUARTERLY_CAP_BPS) / 10000;
        return cap > quarterReleased ? cap - quarterReleased : 0;
    }

    /**
     * @notice Release vested tokens to beneficiary, respecting quarterly cap.
     * @param amount Amount to release (must be <= releasable and <= quarterly remaining)
     */
    function release(uint256 amount) external onlyBeneficiary {
        if (amount == 0) revert NothingToRelease();
        uint256 available = releasable();
        if (amount > available) revert NothingToRelease();

        // Reset quarter if new quarter started
        if (block.timestamp >= quarterStart + QUARTER) {
            quarterStart = block.timestamp;
            quarterReleased = 0;
        }

        // Enforce quarterly cap
        uint256 balance = _availableBalance();
        uint256 cap = (balance * QUARTERLY_CAP_BPS) / 10000;
        if (quarterReleased + amount > cap) revert QuarterlyCapExceeded();

        totalReleased += amount;
        quarterReleased += amount;

        _payOrCredit(payable(beneficiary), amount);
        emit Released(beneficiary, amount);
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

    function availableBalance() external view returns (uint256) {
        return _availableBalance();
    }

    function updateBeneficiary(address newBeneficiary) external onlyOwner {
        if (newBeneficiary == address(0)) revert ZeroAddress();
        emit BeneficiaryUpdated(beneficiary, newBeneficiary);
        beneficiary = newBeneficiary;
    }

    function _availableBalance() internal view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > pendingWithdrawalTotal ? balance - pendingWithdrawalTotal : 0;
    }

    function _payOrCredit(address payable to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[to] += amount;
            pendingWithdrawalTotal += amount;
            emit WithdrawalCredited(to, amount);
        }
    }

    // Accept ETH deposits (for initial funding)
    receive() external payable {}
}
