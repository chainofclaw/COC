// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Treasury - DAO treasury that receives slash proceeds and governance-approved withdrawals
contract Treasury {
    address public governance;
    address public owner;

    event Deposit(address indexed from, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount, uint256 indexed proposalId);
    event GovernanceUpdated(address indexed newGovernance);

    error NotGovernance();
    error NotOwner();
    error TransferFailed();
    error InsufficientBalance();
    error ZeroAmount();

    modifier onlyGovernance() {
        if (msg.sender != governance && msg.sender != owner) revert NotGovernance();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _governance) {
        governance = _governance;
        owner = msg.sender;
    }

    /// @notice Withdraw funds approved by a governance proposal
    function withdraw(address payable to, uint256 amount, uint256 proposalId) external onlyGovernance {
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) revert InsufficientBalance();

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawal(to, amount, proposalId);
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceUpdated(_governance);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Receive slash proceeds or any ETH deposits
    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }
}
