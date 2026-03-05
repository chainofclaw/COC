// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library PoSeTypesV2 {
    struct EvidenceLeafV2 {
        uint64 epoch;
        bytes32 nodeId;
        bytes16 nonce;
        bytes32 tipHash;
        uint64 tipHeight;
        uint32 latencyMs;
        uint8 resultCode;
        uint32 witnessBitmap;
    }

    struct FaultProof {
        bytes32 batchId;
        uint8 faultType;
        bytes32 evidenceLeafHash;
        bytes32[] merkleProof;
        bytes evidenceData;
        bytes challengerSig;
    }

    struct ChallengeRecord {
        bytes32 commitHash;
        address challenger;
        uint256 bond;
        uint64 commitEpoch;
        uint64 revealDeadlineEpoch;
        bool revealed;
        bool settled;
        bytes32 targetNodeId;
        uint8 faultType;
    }

    struct RewardClaim {
        uint64 epochId;
        bytes32 nodeId;
        uint256 amount;
    }

    // EIP-712 type hashes (precomputed for gas efficiency)
    bytes32 internal constant EVIDENCE_LEAF_TYPEHASH = keccak256(
        "EvidenceLeaf(uint64 epoch,bytes32 nodeId,bytes16 nonce,bytes32 tipHash,uint64 tipHeight,uint32 latencyMs,uint8 resultCode,uint32 witnessBitmap)"
    );

    bytes32 internal constant REWARD_LEAF_TYPEHASH = keccak256(
        "RewardLeaf(uint64 epochId,bytes32 nodeId,uint256 amount)"
    );

    bytes32 internal constant WITNESS_TYPEHASH = keccak256(
        "WitnessAttestation(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex)"
    );
}
