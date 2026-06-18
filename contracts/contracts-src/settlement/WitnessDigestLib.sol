// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoSeTypesV2} from "./PoSeTypesV2.sol";

/// @notice #746 — pure EIP-712 digest builders for the three versions of the
///         witness attestation typehash (v1/v2/v3). Extracted to a library so
///         `PoSeManagerV2` stays under EIP-170's 24576-byte deployment cap
///         once the v3 path lands. Each builder takes the dynamic
///         `domainSeparator` as a calldata parameter so the library has no
///         storage access of its own.
library WitnessDigestLib {
    /// @notice v1 — legacy (no epochId, no resultCode). Kept for backwards
    ///         compatibility during the rollout window gated by
    ///         `PoSeManagerStorage.v1SunsetEpoch`.
    function buildV1(
        bytes32 domainSeparator,
        bytes32 challengeId,
        bytes32 nodeId,
        bytes32 responseBodyHash,
        uint8 witnessIndex
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(abi.encode(
                    PoSeTypesV2.WITNESS_TYPEHASH,
                    challengeId,
                    nodeId,
                    responseBodyHash,
                    witnessIndex
                ))
            )
        );
    }

    /// @notice v2 (#667) — binds `epochId` so signatures cannot be replayed
    ///         across epochs. Gated by
    ///         `PoSeManagerStorage.v2SunsetEpoch` (#746).
    function buildV2(
        bytes32 domainSeparator,
        bytes32 challengeId,
        bytes32 nodeId,
        bytes32 responseBodyHash,
        uint8 witnessIndex,
        uint64 epochId
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(abi.encode(
                    PoSeTypesV2.WITNESS_TYPEHASH_V2,
                    challengeId,
                    nodeId,
                    responseBodyHash,
                    witnessIndex,
                    epochId
                ))
            )
        );
    }

    /// @notice v3 (#746) — adds `resultCode` so the witness signature
    ///         cryptographically pins the Layer-7 semantic result the witness
    ///         independently computed by running `ReceiptVerifierV2`'s
    ///         verifier callbacks on the pushed receipt. Closes the F1
    ///         (semantic rubber-stamp) and F3 (leaf binding) gaps.
    function buildV3(
        bytes32 domainSeparator,
        bytes32 challengeId,
        bytes32 nodeId,
        bytes32 responseBodyHash,
        uint8 resultCode,
        uint8 witnessIndex,
        uint64 epochId
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(abi.encode(
                    PoSeTypesV2.WITNESS_TYPEHASH_V3,
                    challengeId,
                    nodeId,
                    responseBodyHash,
                    resultCode,
                    witnessIndex,
                    epochId
                ))
            )
        );
    }
}
