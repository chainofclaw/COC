// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {RollupTypes} from "./RollupTypes.sol";
import {IDelayedInbox} from "./IDelayedInbox.sol";

/// @title DelayedInbox — censorship-resistance queue for COC Optimistic Rollup
/// @notice Users can enqueue transactions that the L2 sequencer must eventually include.
///         After INCLUSION_DELAY elapses, anyone can call forceInclude() to emit an event
///         that the sequencer is obligated to process.
///         UUPS upgradeable since 88780 gen-5; upgrade gated on `owner`.
contract DelayedInbox is IDelayedInbox, Initializable, UUPSUpgradeable {
    uint256 public override INCLUSION_DELAY;
    address public sequencer;
    address public owner;

    RollupTypes.ForcedTx[] private _queue;
    mapping(uint256 => bool) private _forceIncluded;

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    modifier onlySequencer() {
        if (msg.sender != sequencer) revert NotSequencer(msg.sender);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint256 inclusionDelaySeconds,
        address sequencerAddress,
        address initialOwner
    ) external initializer {
        require(inclusionDelaySeconds > 0, "inclusion delay must be > 0");
        require(sequencerAddress != address(0), "sequencer cannot be zero");
        require(initialOwner != address(0), "owner cannot be zero");
        INCLUSION_DELAY = inclusionDelaySeconds;
        sequencer = sequencerAddress;
        owner = initialOwner;
    }

    function _authorizeUpgrade(address) internal override {
        require(msg.sender == owner, "only owner");
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
    ///
    /// #723: NOT gated on `entry.included` — that flag is set by an
    /// unverified sequencer claim via `markIncluded`, and a malicious
    /// sequencer would otherwise be able to suppress the censorship-
    /// resistance signal by pre-emptively marking enqueued txs as
    /// included without actually including them on L2. `_forceIncluded`
    /// is the contract-owned one-shot guard against double-emit.
    function forceInclude(uint256 queueIndex) external override {
        if (queueIndex >= _queue.length) {
            revert QueueIndexOutOfRange(queueIndex, _queue.length);
        }
        RollupTypes.ForcedTx storage entry = _queue[queueIndex];
        if (_forceIncluded[queueIndex]) {
            revert AlreadyForceIncluded(queueIndex);
        }
        if (block.timestamp < entry.enqueuedAt + INCLUSION_DELAY) {
            revert NotYetForceable(queueIndex, entry.enqueuedAt, INCLUSION_DELAY);
        }

        _forceIncluded[queueIndex] = true;
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

    /// @notice Transfer contract ownership (#686 — moves owner to a multisig).
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "only owner");
        require(newOwner != address(0), "zero address");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    // UUPS storage gap — append-only state from now on.
    uint256[50] private __gap;
}
