// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoSeTypes} from "./PoSeTypes.sol";
import {PoSeTypesV2} from "./PoSeTypesV2.sol";

interface IPoSeManagerV2 {
    // Events inherited from v1 for node lifecycle
    event NodeRegistered(bytes32 indexed nodeId, address indexed operator, uint8 serviceFlags, uint256 bondAmount);

    // v2 Events
    event EpochNonceSet(uint64 indexed epochId, uint64 nonce);
    event BatchSubmittedV2(uint64 indexed epochId, bytes32 indexed batchId, bytes32 merkleRoot, uint32 witnessBitmap);
    /// @notice Emitted when a v2 batch is submitted with per-receipt metadata
    ///         (#667). `challengeIds`/`nodeIds`/`responseBodyHashes` are aligned
    ///         to the `leafHashes` order used to rebuild the Merkle root.
    ///         Indexers can pair this with `BatchSubmittedV2` via `batchId`.
    event ReceiptBatchMetadataSubmitted(
        bytes32 indexed batchId,
        bytes32[] challengeIds,
        bytes32[] nodeIds,
        bytes32[] responseBodyHashes,
        bytes32[] leafHashes,
        uint16[32] witnessReceiptIndex
    );
    event ChallengeOpened(bytes32 indexed challengeId, address indexed challenger, uint256 bond);
    event ChallengeRevealed(bytes32 indexed challengeId, bytes32 targetNodeId, uint8 faultType);
    event ChallengeSettled(bytes32 indexed challengeId, bool faultConfirmed, uint256 slashAmount);
    event RewardClaimed(uint64 indexed epochId, bytes32 indexed nodeId, uint256 amount);
    event SlashDistributed(bytes32 indexed nodeId, uint256 burned, uint256 challenger, uint256 insurance);
    event EpochFinalizedV2(uint64 indexed epochId, bytes32 rewardRoot, uint256 totalReward);
    event InsuranceDeposited(address indexed depositor, uint256 amount);
    event WithdrawalCredited(address indexed payee, uint256 amount);
    event WithdrawalClaimed(address indexed payee, uint256 amount);

    // Errors
    error InvalidWitnessQuorum();
    error ChallengeNotFound();
    error RevealWindowMissed();
    error AlreadyClaimed();
    error InvalidMerkleProof();
    error SlashCapExceeded();
    error BondTooLow();
    error EpochNonceAlreadySet();
    error CommitHashMismatch();
    error AdjudicationWindowNotElapsed();
    error ChallengeAlreadySettled();
    error ChallengeNotRevealed();
    error InvalidFaultProof();
    error NotChallengeOwner();
    error InvalidFaultType();
    error RewardPoolInsufficient();
    error RewardBudgetExceeded();
    error NoPendingWithdrawal();
    error BatchesNotProcessed();
    /// @notice #667 errors — surfaced by `submitBatchV2WithMetadata`.
    error WitnessNotActive();
    error WitnessSigReplay();
    error MerkleRootMismatch();
    error MetadataLengthMismatch();
    error BadReceiptIndex();

    // Functions
    function initEpochNonce(uint64 epochId) external;

    function submitBatchV2(
        uint64 epochId,
        bytes32 merkleRoot,
        bytes32 summaryHash,
        PoSeTypes.SampleProof[] calldata sampleProofs,
        uint32 witnessBitmap,
        bytes[] calldata witnessSignatures
    ) external returns (bytes32 batchId);

    /// @notice v2 batch submission with per-receipt metadata. Independent
    ///         witness verification — each witness signature is checked
    ///         against the original (challengeId, responseBodyHash) it
    ///         attested to (looked up via `metadata.witnessReceiptIndex`),
    ///         and the contract rebuilds the batch Merkle root from the
    ///         declared `metadata.leafHashes` to assert it matches
    ///         `merkleRoot`. Closes #667.
    function submitBatchV2WithMetadata(
        uint64 epochId,
        bytes32 merkleRoot,
        bytes32 summaryHash,
        PoSeTypes.SampleProof[] calldata sampleProofs,
        uint32 witnessBitmap,
        bytes[] calldata witnessSignatures,
        PoSeTypesV2.ReceiptBatchMetadata calldata metadata
    ) external returns (bytes32 batchId);

    function openChallenge(bytes32 commitHash) external payable returns (bytes32 challengeId);

    function revealChallenge(
        bytes32 challengeId,
        bytes32 targetNodeId,
        uint8 faultType,
        bytes32 evidenceLeafHash,
        bytes32 salt,
        bytes calldata evidenceData,
        bytes calldata challengerSig
    ) external;

    function settleChallenge(bytes32 challengeId) external;

    function processEpochBatches(uint64 epochId, uint256 maxBatches) external;

    function getEpochBatchCount(uint64 epochId) external view returns (uint256);

    function finalizeEpochV2(
        uint64 epochId,
        bytes32 rewardRoot,
        uint256 totalReward,
        uint256 slashTotal,
        uint256 treasuryDelta
    ) external;

    function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] calldata merkleProof) external;

    function depositRewardPool() external payable;

    function withdrawPayments() external;

    function getWitnessSet(uint64 epochId) external view returns (bytes32[] memory);

    function getActiveNodeIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory);

    function getActiveNodeCount() external view returns (uint256);
}
