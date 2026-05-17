// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRollupPaymentTarget {
    function submitOutputRoot(uint64 l2BlockNumber, bytes32 outputRoot, bytes32 l2StateRoot) external payable;
    function challengeOutputRoot(uint64 l2BlockNumber) external payable;
    function withdrawPayments() external;
}

/// @notice Test-only helper that can participate in rollup flows but rejects ETH payouts.
contract RollupRejectingReceiver {
    IRollupPaymentTarget public immutable target;

    constructor(address _target) {
        target = IRollupPaymentTarget(_target);
    }

    function submitOutputRoot(uint64 l2BlockNumber, bytes32 outputRoot, bytes32 l2StateRoot) external payable {
        target.submitOutputRoot{value: msg.value}(l2BlockNumber, outputRoot, l2StateRoot);
    }

    function challengeOutputRoot(uint64 l2BlockNumber) external payable {
        target.challengeOutputRoot{value: msg.value}(l2BlockNumber);
    }

    function withdrawPayments() external {
        target.withdrawPayments();
    }

    receive() external payable {
        revert("reject eth");
    }
}
