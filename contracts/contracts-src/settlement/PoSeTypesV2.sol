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

    /// @notice v2 witness attestation typehash (#667). Adds `epochId` so a
    ///         signature is bound to the epoch in which it was collected and
    ///         can never be replayed across epochs. Off-chain witness signers
    ///         on coc-node v0.3+ produce this typehash; the legacy WITNESS_TYPEHASH
    ///         remains accepted during a versioned-typehash rollout window so
    ///         in-flight batches signed before the contract upgrade still settle.
    bytes32 internal constant WITNESS_TYPEHASH_V2 = keccak256(
        "WitnessAttestationV2(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex,uint64 epochId)"
    );

    /// @notice Per-receipt metadata submitted alongside a v2 batch. Lets the
    ///         contract verify each witness signature against the **original**
    ///         (challengeId, responseBodyHash) the witness actually attested to
    ///         — not the batch merkleRoot — and independently rebuild the batch
    ///         Merkle root from the declared leaves to assert it matches the
    ///         submitted `merkleRoot`.
    ///
    /// `witnessReceiptIndex[i]` maps witness bit position `i` (0..31) to the
    /// index in {challengeIds,nodeIds,responseBodyHashes,leafHashes} that the
    /// witness at that bit signed for. Unused bit positions hold `type(uint16).max`.
    struct ReceiptBatchMetadata {
        bytes32[] challengeIds;
        bytes32[] nodeIds;
        bytes32[] responseBodyHashes;
        bytes32[] leafHashes;
        uint16[32] witnessReceiptIndex;
    }
}
