// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only helper whose runtime rejects native token payouts.
contract EthRejectingReceiver {
    receive() external payable {
        revert("reject eth");
    }
}
