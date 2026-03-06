// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../settlement/PoSeTypesV2.sol";

/// @dev Test-only harness exposing EIP-712 hash computations for cross-check with TypeScript.
contract Eip712Harness {
    bytes32 public DOMAIN_SEPARATOR;

    function setDomainSeparator(uint256 chainId, address verifyingContract) external {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("COCPoSe"),
                keccak256("2"),
                chainId,
                verifyingContract
            )
        );
    }

    function evidenceLeafTypeHash() external pure returns (bytes32) {
        return PoSeTypesV2.EVIDENCE_LEAF_TYPEHASH;
    }

    function rewardLeafTypeHash() external pure returns (bytes32) {
        return PoSeTypesV2.REWARD_LEAF_TYPEHASH;
    }

    function witnessTypeHash() external pure returns (bytes32) {
        return PoSeTypesV2.WITNESS_TYPEHASH;
    }

    function hashEvidenceLeaf(
        uint64 epoch,
        bytes32 nodeId,
        bytes16 nonce,
        bytes32 tipHash,
        uint64 tipHeight,
        uint32 latencyMs,
        uint8 resultCode,
        uint32 witnessBitmap
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(
            PoSeTypesV2.EVIDENCE_LEAF_TYPEHASH,
            epoch, nodeId, nonce, tipHash, tipHeight, latencyMs, resultCode, witnessBitmap
        ));
    }

    function hashRewardLeaf(
        uint64 epochId,
        bytes32 nodeId,
        uint256 amount
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(
            PoSeTypesV2.REWARD_LEAF_TYPEHASH,
            epochId, nodeId, amount
        ));
    }

    function hashWitnessAttestation(
        bytes32 challengeId,
        bytes32 nodeId,
        bytes32 responseBodyHash,
        uint8 witnessIndex
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(
            PoSeTypesV2.WITNESS_TYPEHASH,
            challengeId, nodeId, responseBodyHash, witnessIndex
        ));
    }

    function eip712Digest(bytes32 structHash) external view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }
}
