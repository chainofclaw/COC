// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollupTypes} from "./RollupTypes.sol";

/// @title IDelayedInbox — interface for COC Rollup forced transaction inclusion
interface IDelayedInbox {
    event TransactionEnqueued(uint256 indexed queueIndex, address sender, bytes32 txHash, uint64 enqueuedAt);
    event TransactionForceIncluded(uint256 indexed queueIndex);
    event TransactionIncluded(uint256 indexed queueIndex);

    error QueueIndexOutOfRange(uint256 provided, uint256 queueLength);
    error NotYetForceable(uint256 queueIndex, uint64 enqueuedAt, uint256 inclusionDelay);
    error AlreadyIncluded(uint256 queueIndex);
    error NotSequencer(address caller);

    function enqueueTransaction(bytes calldata l2Tx) external;
    function forceInclude(uint256 queueIndex) external;
    function markIncluded(uint256 queueIndex) external;
    function getQueueLength() external view returns (uint256);
    function getQueueItem(uint256 index) external view returns (RollupTypes.ForcedTx memory);
    function INCLUSION_DELAY() external view returns (uint256);
}
