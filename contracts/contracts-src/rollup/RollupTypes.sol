// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RollupTypes — shared data structures for COC Optimistic Rollup
library RollupTypes {
    struct OutputProposal {
        bytes32 outputRoot;       // keccak256(l2BlockNumber, stateRoot, blockHash)
        bytes32 l2StateRoot;      // raw L2 state trie root
        uint64  l2BlockNumber;    // L2 block height this output covers
        uint64  l1Timestamp;      // block.timestamp when submitted
        address proposer;         // who submitted the output
        bool    challenged;       // currently under active challenge
        bool    finalized;        // past challenge window, immutable
    }

    struct OutputChallenge {
        uint64  l2BlockNumber;    // disputed L2 block
        address challenger;       // who opened the challenge
        uint256 bond;             // challenger bond amount
        uint64  createdAt;        // block.timestamp of challenge creation
        uint64  resolveDeadline;  // timestamp after which default resolution applies
        bool    resolved;         // challenge has been resolved
        bool    proposerFault;    // true = proposer submitted incorrect output
    }

    struct ForcedTx {
        bytes   l2Tx;             // raw L2 transaction bytes
        address sender;           // who enqueued the transaction
        uint64  enqueuedAt;       // block.timestamp when enqueued
        bool    included;         // sequencer has included it in L2
    }
}
