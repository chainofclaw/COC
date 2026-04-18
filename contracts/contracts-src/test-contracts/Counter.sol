// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal counter for cron stress testing — single SSTORE per call
contract Counter {
    uint256 public count;

    event Incremented(address indexed caller, uint256 newCount);

    function increment() external {
        count++;
        emit Incremented(msg.sender, count);
    }
}
