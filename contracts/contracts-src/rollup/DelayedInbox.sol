// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollupTypes} from "./RollupTypes.sol";
import {IDelayedInbox} from "./IDelayedInbox.sol";

/// @title DelayedInbox — censorship-resistance queue for COC Optimistic Rollup
/// @notice Users can enqueue transactions that the L2 sequencer must eventually include.
///         After INCLUSION_DELAY elapses, anyone can call forceInclude() to emit an event
///         that the sequencer is obligated to process.
contract DelayedInbox is IDelayedInbox {
    uint256 public immutable override INCLUSION_DELAY;
    address public sequencer;
    address public owner;

    RollupTypes.ForcedTx[] private _queue;

    modifier onlySequencer() {
        if (msg.sender != sequencer) revert NotSequencer(msg.sender);
        _;
    }

    constructor(uint256 inclusionDelaySeconds, address sequencerAddress) {
        require(inclusionDelaySeconds > 0, "inclusion delay must be > 0");
        require(sequencerAddress != address(0), "sequencer cannot be zero");
        INCLUSION_DELAY = inclusionDelaySeconds;
        sequencer = sequencerAddress;
        owner = msg.sender;
    }

    /// @notice Enqueue an L2 transaction for eventual forced inclusion
    /// @param l2Tx Raw signed L2 transaction bytes
    function enqueueTransaction(bytes calldata l2Tx) external override {
        require(l2Tx.length > 0, "empty transaction");
        require(l2Tx.length <= 131072, "transaction too large"); // 128KB max

        uint256 idx = _queue.length;
        _queue.push(RollupTypes.ForcedTx({
            l2Tx: l2Tx,
            sender: msg.sender,
            enqueuedAt: uint64(block.timestamp),
            included: false
        }));

        emit TransactionEnqueued(idx, msg.sender, keccak256(l2Tx), uint64(block.timestamp));
    }

    /// @notice Force-include a transaction after the inclusion delay has elapsed.
    ///         Emits TransactionForceIncluded; the L2 sequencer must honor this.
    /// @param queueIndex Index in the queue
    function forceInclude(uint256 queueIndex) external override {
        if (queueIndex >= _queue.length) {
            revert QueueIndexOutOfRange(queueIndex, _queue.length);
        }
        RollupTypes.ForcedTx storage entry = _queue[queueIndex];
        if (entry.included) {
            revert AlreadyIncluded(queueIndex);
        }
        if (block.timestamp < entry.enqueuedAt + INCLUSION_DELAY) {
            revert NotYetForceable(queueIndex, entry.enqueuedAt, INCLUSION_DELAY);
        }

        emit TransactionForceIncluded(queueIndex);
    }

    /// @notice Mark a queued transaction as included by the sequencer.
    ///         Only callable by the authorized sequencer address.
    /// @param queueIndex Index in the queue
    function markIncluded(uint256 queueIndex) external override onlySequencer {
        if (queueIndex >= _queue.length) {
            revert QueueIndexOutOfRange(queueIndex, _queue.length);
        }
        RollupTypes.ForcedTx storage entry = _queue[queueIndex];
        if (entry.included) {
            revert AlreadyIncluded(queueIndex);
        }
        entry.included = true;

        emit TransactionIncluded(queueIndex);
    }

    function getQueueLength() external view override returns (uint256) {
        return _queue.length;
    }

    function getQueueItem(uint256 index) external view override returns (RollupTypes.ForcedTx memory) {
        require(index < _queue.length, "index out of range");
        return _queue[index];
    }

    /// @notice Update the sequencer address (only owner)
    function setSequencer(address newSequencer) external {
        require(msg.sender == owner, "only owner");
        require(newSequencer != address(0), "zero address");
        sequencer = newSequencer;
    }
}
