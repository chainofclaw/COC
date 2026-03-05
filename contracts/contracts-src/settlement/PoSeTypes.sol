// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library PoSeTypes {
    enum ServiceType {
        Uptime,
        Storage,
        Relay
    }

    struct NodeRecord {
        bytes32 nodeId;
        bytes pubkeyNode;
        uint8 serviceFlags;
        bytes32 serviceCommitment;
        bytes32 endpointCommitment;
        uint256 bondAmount;
        bytes32 metadataHash;
        uint64 registeredAtEpoch;
        uint64 unlockEpoch;
        bool active;
    }

    struct BatchRecord {
        uint64 epochId;
        bytes32 merkleRoot;
        bytes32 summaryHash;
        address aggregator;
        uint64 submittedAtEpoch;
        uint64 disputeDeadlineEpoch;
        bool finalized;
        bool disputed;
    }

    struct SampleProof {
        bytes32 leaf;
        bytes32[] merkleProof;
        uint32 leafIndex;
    }

    struct SlashEvidence {
        bytes32 nodeId;
        bytes32 evidenceHash;
        uint8 reasonCode;
        bytes rawEvidence;
    }

    struct EpochReward {
        bytes32 nodeId;
        uint256 amount;
    }
}
