// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title InsuranceFund
 * @notice Phase I5 — accumulates the 20% insurance share of each
 *         `ValidatorRegistry` / `PoSeManagerV2` slash. Funds remain
 *         segregated until a governance withdrawal is initiated by the
 *         configured `governance` address (typically a multisig or
 *         timelock contract).
 *
 *         Minimal by design: deposit via plain ETH transfer, withdraw
 *         only by governance, transferable governance role. Holds no
 *         off-chain state; auditable purely via events.
 */
contract InsuranceFund {
    address public governance;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;

    event Deposited(address indexed from, uint256 amount, uint256 totalDepositedAfter);
    event Withdrawn(address indexed to, uint256 amount, uint256 totalWithdrawnAfter);
    event GovernanceUpdated(address indexed oldGovernance, address indexed newGovernance);

    error OnlyGovernance();
    error ZeroAmount();
    error TransferFailed();
    error InsufficientBalance(uint256 requested, uint256 available);
    error ZeroAddress();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    constructor(address initialGovernance) {
        if (initialGovernance == address(0)) revert ZeroAddress();
        governance = initialGovernance;
    }

    /// @notice Anyone can deposit ETH; the slash router does this implicitly.
    receive() external payable {
        if (msg.value == 0) return;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value, totalDeposited);
    }

    /**
     * @notice Withdraw `amount` to `to`. Only callable by `governance`.
     *         Reverts on zero amount, zero recipient, or insufficient balance.
     */
    function withdraw(address payable to, uint256 amount) external onlyGovernance {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > address(this).balance) {
            revert InsufficientBalance(amount, address(this).balance);
        }
        totalWithdrawn += amount;
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount, totalWithdrawn);
    }

    /// @notice Transfer the governance role. Two-step transfers are not used
    ///         on purpose — the caller must be sure of the new address.
    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceUpdated(governance, newGovernance);
        governance = newGovernance;
    }

    /// @notice Live ETH balance. `totalDeposited - totalWithdrawn` may diverge
    ///         from this on chains that allow forced ETH transfers (selfdestruct
    ///         + COINBASE before EIP-6780). Both are surfaced for auditing.
    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
