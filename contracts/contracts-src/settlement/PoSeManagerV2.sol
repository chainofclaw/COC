// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IPoSeManagerV2} from "./IPoSeManagerV2.sol";
import {PoSeTypes} from "./PoSeTypes.sol";
import {PoSeTypesV2} from "./PoSeTypesV2.sol";
import {PoSeManagerStorage} from "./PoSeManagerStorage.sol";
import {MerkleProofLite} from "./MerkleProofLite.sol";
import {EmissionSchedule} from "../token/EmissionSchedule.sol";

interface ICOCToken {
    function mint(address to, uint256 amount) external;
    function totalMinted() external view returns (uint256);
    function burn(uint256 amount) external;
}

contract PoSeManagerV2 is IPoSeManagerV2, PoSeManagerStorage, UUPSUpgradeable {
    using EmissionSchedule for uint64;
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 public constant SLASH_EPOCH_CAP_BPS = 500;      // 5% per epoch
    uint16 public constant SLASH_BURN_BPS = 5000;           // 50% burned
    uint16 public constant SLASH_CHALLENGER_BPS = 3000;     // 30% to challenger
    uint16 public constant SLASH_INSURANCE_BPS = 2000;      // 20% to insurance
    uint64 public constant REVEAL_WINDOW_EPOCHS = 2;
    uint64 public constant ADJUDICATION_WINDOW_EPOCHS = 2;
    // #680: max epoch batches finalizeEpochV2 / processEpochBatches walk per
    // call — sized to stay well under the block gas limit even at this many.
    uint256 public constant FINALIZE_BATCH_BUDGET = 200;
    uint256 internal constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // --- v2 storage ---
    mapping(uint64 => uint64) public challengeNonces;
    mapping(uint64 => bytes32) public epochRewardRoots;
    mapping(uint64 => mapping(bytes32 => bool)) public rewardClaimed;
    mapping(uint64 => uint256) public epochTotalReward;
    mapping(uint64 => uint256) public epochSlashTotal;
    mapping(uint64 => uint256) public epochTreasuryDelta;
    mapping(bytes32 => PoSeTypesV2.ChallengeRecord) public challenges;
    mapping(uint64 => mapping(bytes32 => uint256)) public epochNodeSlashed;
    mapping(bytes32 => bool) public challengeFaultConfirmed;
    mapping(uint64 => uint256) public epochClaimedReward;
    mapping(bytes32 => bool) public consumedFaultEvidence;
    mapping(bytes32 => uint64) public challengeFaultEpochPlusOne;
    mapping(address => uint256) public pendingWithdrawals;
    // Per-epoch guard: a merkleRoot uniquely identifies batch contents, so it
    // may be submitted at most once per epoch. Without this, witness sigs
    // (bound only to the root, not to batchId/aggregator) replay across
    // unlimited cloned batches and bloat epochBatches, causing finalizeEpochV2
    // DoS (#680).
    mapping(uint64 => mapping(bytes32 => bool)) public epochMerkleRootUsed;
    // #680: cursor for paginated finalizeEpochV2 — count of epochBatches[epochId]
    // already walked. finalizeEpochV2 cannot complete until the cursor reaches
    // the array length, so an unbounded epochBatches array can no longer
    // OOG-brick epoch finalization.
    mapping(uint64 => uint256) public epochBatchCursor;

    uint256 public challengeBondMin;
    uint256 public insuranceBalance;
    bytes32 public DOMAIN_SEPARATOR;
    bool public allowEmptyWitnessSubmission;
    /// @dev Kept for storage-layout compatibility with the pre-UUPS deployment.
    /// The OZ `initializer` modifier now provides the single-shot guard.
    bool public initialized;
    uint256 private _challengeCounter;

    // --- Token emission ---
    ICOCToken public cocToken;
    uint64 public genesisEpoch;          // First epoch (for year calculation)
    bool public emissionEnabled;
    address public foundationAddress;    // Receives 10% of expired unclaimed rewards

    // --- Reward expiry ---
    uint256 public constant REWARD_CLAIM_WINDOW = 7 days;
    uint16 public constant EXPIRED_FOUNDATION_BPS = 1000;   // 10% to foundation
    mapping(uint64 => uint256) public epochFinalizedAt;      // epochId → block.timestamp
    mapping(uint64 => bool) public epochSwept;               // epochId → swept flag

    event EmissionMinted(uint64 indexed epochId, uint256 amount);
    event ExpiredRewardsSwept(uint64 indexed epochId, uint256 toFoundation, uint256 burned);
    event Initialized(uint256 chainId, address verifyingContract, uint256 challengeBondMin);

    // Active node tracking for witness set selection
    bytes32[] internal _activeNodeIds;
    mapping(bytes32 => uint256) internal _activeNodeIndex; // nodeId => index+1 (0 = not present)

    // #667: per-(epochId, witnessNodeId, signatureHash) anti-replay guard.
    // Set when `submitBatchV2WithMetadata` consumes a witness signature; prevents
    // the same signature being reused across batches inside the same epoch
    // (or carried into a different epoch under the v1 typehash fallback that
    // does not encode `epochId`). Versioned typehash v2 already encodes `epochId`
    // so this also defends against any future regression that drops that field.
    mapping(bytes32 => bool) internal _witnessSigUsed;

    error InvalidNodeId();
    error NodeAlreadyRegistered();
    error NodeNotFound();
    error NotNodeOperator();
    error InvalidBatch();
    error BatchAlreadySubmitted();
    error EpochAlreadyFinalized();
    error DisputeWindowNotElapsed();
    error InsufficientBond();
    error TooManyNodes();
    error InvalidOwnershipProof();
    error EndpointAlreadyRegistered();
    error TransferFailed();
    error AlreadyUnbonding();
    error UnlockNotReached();
    error NoBondToWithdraw();
    error AlreadyInitialized();
    error ZeroAddress();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer. `chainId` and `verifyingContract` are no
    ///         longer parameters — they are taken from `block.chainid` and
    ///         `address(this)` (the proxy address) so the EIP-712 domain
    ///         always reflects the live deployment.
    function initialize(uint256 _challengeBondMin, address initialOwner) external initializer {
        if (_challengeBondMin == 0) revert BondTooLow();
        if (initialOwner == address(0)) revert ZeroAddress();

        __PoSeManagerStorage_init(initialOwner);

        initialized = true;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("COCPoSe"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
        challengeBondMin = _challengeBondMin;
        emit Initialized(block.chainid, address(this), _challengeBondMin);
    }

    /**
     * @notice Enable PoSe mining emission. Sets the COC token contract and records
     *         the genesis epoch for year-based decay calculation.
     * @param token       Address of the COCToken contract
     * @param _genesisEpoch  The epoch ID when mining begins (current epoch)
     */
    function enableEmission(address token, uint64 _genesisEpoch) external onlyOwner {
        require(token != address(0), "zero token address");
        cocToken = ICOCToken(token);
        genesisEpoch = _genesisEpoch;
        emissionEnabled = true;
    }

    function setFoundationAddress(address _foundation) external onlyOwner {
        require(_foundation != address(0), "zero foundation address");
        foundationAddress = _foundation;
    }

    // --- Node registration (reuse v1 logic, extended with active node tracking) ---
    function registerNode(
        bytes32 nodeId,
        bytes calldata pubkeyNode,
        uint8 serviceFlags,
        bytes32 serviceCommitment,
        bytes32 endpointCommitment,
        bytes32 metadataHash,
        bytes calldata ownershipSig,
        bytes calldata endpointAttestation
    ) external payable {
        if (msg.value < _requiredBond(operatorNodeCount[msg.sender])) revert InsufficientBond();
        if (operatorNodeCount[msg.sender] >= MAX_NODES_PER_OPERATOR) revert TooManyNodes();
        if (nodeId == bytes32(0) || keccak256(pubkeyNode) != nodeId) revert InvalidNodeId();
        if (nodes[nodeId].active) revert NodeAlreadyRegistered();
        if (endpointCommitmentUsed[endpointCommitment]) revert EndpointAlreadyRegistered();

        _verifyOwnership(nodeId, pubkeyNode, ownershipSig);

        if (endpointAttestation.length > 0) {
            _verifyEndpointAttestation(endpointCommitment, nodeId, pubkeyNode, endpointAttestation);
        }

        endpointCommitmentUsed[endpointCommitment] = true;
        uint64 currentEpoch = _currentEpoch();

        nodes[nodeId] = PoSeTypes.NodeRecord({
            nodeId: nodeId,
            pubkeyNode: pubkeyNode,
            serviceFlags: serviceFlags,
            serviceCommitment: serviceCommitment,
            endpointCommitment: endpointCommitment,
            bondAmount: msg.value,
            metadataHash: metadataHash,
            registeredAtEpoch: currentEpoch,
            unlockEpoch: currentEpoch + 7 * 24,
            active: true
        });
        nodeOperator[nodeId] = msg.sender;
        operatorNodeCount[msg.sender] += 1;

        // Track active node for witness set
        _activeNodeIds.push(nodeId);
        _activeNodeIndex[nodeId] = _activeNodeIds.length; // 1-indexed

        emit NodeRegistered(nodeId, msg.sender, serviceFlags, msg.value);
    }

    // --- Epoch nonce (prevrandao snapshot) ---
    function initEpochNonce(uint64 epochId) external override onlyOwner {
        if (challengeNonces[epochId] != 0) revert EpochNonceAlreadySet();
        challengeNonces[epochId] = uint64(block.prevrandao);
        emit EpochNonceSet(epochId, uint64(block.prevrandao));
    }

    // --- Batch submission with witness quorum ---
    function submitBatchV2(
        uint64 epochId,
        bytes32 merkleRoot,
        bytes32 summaryHash,
        PoSeTypes.SampleProof[] calldata sampleProofs,
        uint32 witnessBitmap,
        bytes[] calldata witnessSignatures
    ) external override returns (bytes32 batchId) {
        if (merkleRoot == bytes32(0) || summaryHash == bytes32(0)) revert InvalidBatch();
        uint64 currentEpoch = _currentEpoch();
        if (epochId > currentEpoch) revert InvalidBatch();
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        if (sampleProofs.length == 0 || sampleProofs.length > type(uint16).max) revert InvalidBatch();

        // Validate witness quorum.
        // Bootstrap/transition submissions without witness signatures are owner-only.
        _validateWitnessQuorum(epochId, witnessBitmap, witnessSignatures, merkleRoot);

        batchId = _batchId(epochId, merkleRoot, summaryHash, msg.sender);
        if (batches[batchId].merkleRoot != bytes32(0)) revert BatchAlreadySubmitted();
        // One merkleRoot per epoch: blocks duplicate-root clones whose replayed
        // witness signatures would otherwise bloat epochBatches unboundedly (#680).
        if (epochMerkleRootUsed[epochId][merkleRoot]) revert BatchAlreadySubmitted();
        epochMerkleRootUsed[epochId][merkleRoot] = true;

        // Verify sample proofs (reuse v1 logic)
        bytes32 sampleCommitment = bytes32(0);
        uint32 lastLeafIndex = 0;
        bool hasLastIndex = false;
        for (uint256 i = 0; i < sampleProofs.length; i++) {
            PoSeTypes.SampleProof calldata proof = sampleProofs[i];
            if (proof.leaf == bytes32(0) || proof.merkleProof.length == 0) revert InvalidBatch();
            if (hasLastIndex && proof.leafIndex <= lastLeafIndex) revert InvalidBatch();
            if (batchSampledLeaf[batchId][proof.leaf]) revert InvalidBatch();
            if (!MerkleProofLite.verify(proof.merkleProof, merkleRoot, proof.leaf)) revert InvalidBatch();

            batchSampledLeaf[batchId][proof.leaf] = true;
            sampleCommitment = keccak256(abi.encodePacked(sampleCommitment, proof.leafIndex, proof.leaf));
            lastLeafIndex = proof.leafIndex;
            hasLastIndex = true;
        }

        bytes32 expectedSummary = keccak256(abi.encodePacked(epochId, merkleRoot, sampleCommitment, uint32(sampleProofs.length)));
        if (summaryHash != expectedSummary) revert InvalidBatch();

        batches[batchId] = PoSeTypes.BatchRecord({
            epochId: epochId,
            merkleRoot: merkleRoot,
            summaryHash: summaryHash,
            aggregator: msg.sender,
            submittedAtEpoch: currentEpoch,
            disputeDeadlineEpoch: currentEpoch + DISPUTE_WINDOW_EPOCHS,
            finalized: false,
            disputed: false
        });
        batchSampleCount[batchId] = uint32(sampleProofs.length);
        batchSampleCommitment[batchId] = sampleCommitment;
        epochBatches[epochId].push(batchId);

        emit BatchSubmittedV2(epochId, batchId, merkleRoot, witnessBitmap);
    }

    /**
     * @notice v2 batch submission with per-receipt metadata (#667). Closes the
     *         "witness rubber-stamp" gap by:
     *           1. Verifying each witness signature against the ORIGINAL
     *              (challengeId, responseBodyHash) the witness attested to —
     *              looked up via `metadata.witnessReceiptIndex`. The v1 path
     *              re-used `merkleRoot` as both fields, which let aggregator +
     *              any witness collude to attest to any root.
     *           2. Requiring witness signers to be currently in `_activeNodeIds`
     *              (`WitnessNotActive`).
     *           3. Anti-replay: tracks (epochId, witnessNodeId, sigHash) so the
     *              same signature cannot be re-used across batches in an epoch.
     *           4. Independently rebuilding the batch Merkle root from
     *              `metadata.leafHashes` and asserting `== merkleRoot`.
     *           5. Versioned-typehash rollout — accepts both `WITNESS_TYPEHASH`
     *              (v1, no epochId) and `WITNESS_TYPEHASH_V2` (with epochId)
     *              during the migration window. v1 fallback path will be
     *              removed in PR-E after the witness fleet upgrades.
     */
    function submitBatchV2WithMetadata(
        uint64 epochId,
        bytes32 merkleRoot,
        bytes32 summaryHash,
        PoSeTypes.SampleProof[] calldata sampleProofs,
        uint32 witnessBitmap,
        bytes[] calldata witnessSignatures,
        PoSeTypesV2.ReceiptBatchMetadata calldata metadata
    ) external override returns (bytes32 batchId) {
        if (merkleRoot == bytes32(0) || summaryHash == bytes32(0)) revert InvalidBatch();
        uint64 currentEpoch = _currentEpoch();
        if (epochId > currentEpoch) revert InvalidBatch();
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        if (sampleProofs.length == 0 || sampleProofs.length > type(uint16).max) revert InvalidBatch();

        // #667 (1) — metadata length sanity. All per-receipt arrays must align,
        // and at least one leaf must be present (degenerate empty-batch would
        // produce a zero Merkle root).
        uint256 numReceipts = metadata.leafHashes.length;
        if (numReceipts == 0) revert MetadataLengthMismatch();
        if (metadata.challengeIds.length != numReceipts
            || metadata.nodeIds.length != numReceipts
            || metadata.responseBodyHashes.length != numReceipts) {
            revert MetadataLengthMismatch();
        }

        // #667 (2) — independent witness quorum + per-receipt signature check.
        // NOTE: this writes `_witnessSigUsed` so the function is NOT view.
        _validateWitnessQuorumV2(epochId, witnessBitmap, witnessSignatures, metadata, merkleRoot);

        // #667 (3) — independently rebuild the Merkle root from declared leaves.
        // Even if every witness signature is forged-but-recoverable, the
        // aggregator cannot smuggle a `merkleRoot` that doesn't correspond to
        // the leaves it just declared.
        bytes32 reconstructedRoot = _rebuildMerkleRoot(metadata.leafHashes);
        if (reconstructedRoot != merkleRoot) revert MerkleRootMismatch();

        batchId = _batchId(epochId, merkleRoot, summaryHash, msg.sender);
        if (batches[batchId].merkleRoot != bytes32(0)) revert BatchAlreadySubmitted();
        if (epochMerkleRootUsed[epochId][merkleRoot]) revert BatchAlreadySubmitted();
        epochMerkleRootUsed[epochId][merkleRoot] = true;

        // Reuse the existing sample-proof verification path (#680 hardening
        // stays in place: leafIndex monotonic, no duplicate sampled leaves,
        // expectedSummary binds epochId/merkleRoot/sampleCommitment/N).
        bytes32 sampleCommitment = bytes32(0);
        uint32 lastLeafIndex = 0;
        bool hasLastIndex = false;
        for (uint256 i = 0; i < sampleProofs.length; i++) {
            PoSeTypes.SampleProof calldata proof = sampleProofs[i];
            if (proof.leaf == bytes32(0) || proof.merkleProof.length == 0) revert InvalidBatch();
            if (hasLastIndex && proof.leafIndex <= lastLeafIndex) revert InvalidBatch();
            if (batchSampledLeaf[batchId][proof.leaf]) revert InvalidBatch();
            if (!MerkleProofLite.verify(proof.merkleProof, merkleRoot, proof.leaf)) revert InvalidBatch();

            batchSampledLeaf[batchId][proof.leaf] = true;
            sampleCommitment = keccak256(abi.encodePacked(sampleCommitment, proof.leafIndex, proof.leaf));
            lastLeafIndex = proof.leafIndex;
            hasLastIndex = true;
        }

        bytes32 expectedSummary = keccak256(abi.encodePacked(epochId, merkleRoot, sampleCommitment, uint32(sampleProofs.length)));
        if (summaryHash != expectedSummary) revert InvalidBatch();

        batches[batchId] = PoSeTypes.BatchRecord({
            epochId: epochId,
            merkleRoot: merkleRoot,
            summaryHash: summaryHash,
            aggregator: msg.sender,
            submittedAtEpoch: currentEpoch,
            disputeDeadlineEpoch: currentEpoch + DISPUTE_WINDOW_EPOCHS,
            finalized: false,
            disputed: false
        });
        batchSampleCount[batchId] = uint32(sampleProofs.length);
        batchSampleCommitment[batchId] = sampleCommitment;
        epochBatches[epochId].push(batchId);

        emit BatchSubmittedV2(epochId, batchId, merkleRoot, witnessBitmap);
        emit ReceiptBatchMetadataSubmitted(
            batchId,
            metadata.challengeIds,
            metadata.nodeIds,
            metadata.responseBodyHashes,
            metadata.leafHashes,
            metadata.witnessReceiptIndex
        );
    }

    // --- Commit-reveal fault proof ---
    function openChallenge(bytes32 commitHash) external payable override returns (bytes32 challengeId) {
        if (msg.value < challengeBondMin) revert BondTooLow();

        _challengeCounter += 1;
        challengeId = keccak256(abi.encodePacked(msg.sender, _challengeCounter, block.number));

        challenges[challengeId] = PoSeTypesV2.ChallengeRecord({
            commitHash: commitHash,
            challenger: msg.sender,
            bond: msg.value,
            commitEpoch: _currentEpoch(),
            revealDeadlineEpoch: _currentEpoch() + REVEAL_WINDOW_EPOCHS,
            revealed: false,
            settled: false,
            targetNodeId: bytes32(0),
            faultType: 0
        });

        emit ChallengeOpened(challengeId, msg.sender, msg.value);
    }

    function revealChallenge(
        bytes32 challengeId,
        bytes32 targetNodeId,
        uint8 faultType,
        bytes32 evidenceLeafHash,
        bytes32 salt,
        bytes calldata evidenceData,
        bytes calldata challengerSig
    ) external override {
        PoSeTypesV2.ChallengeRecord storage record = challenges[challengeId];
        if (record.challenger == address(0)) revert ChallengeNotFound();
        if (record.revealed) revert ChallengeNotFound(); // already revealed
        if (msg.sender != record.challenger) revert NotChallengeOwner();
        if (_currentEpoch() > record.revealDeadlineEpoch) revert RevealWindowMissed();
        if (faultType == 0 || faultType > 4) revert InvalidFaultType();

        // Verify commit hash
        bytes32 expectedCommit = keccak256(abi.encodePacked(targetNodeId, faultType, evidenceLeafHash, salt));
        if (expectedCommit != record.commitHash) revert CommitHashMismatch();

        // Verify challenger signed the reveal payload.
        bytes32 revealDigest = keccak256(
            abi.encodePacked(
                "coc-fault:",
                challengeId,
                targetNodeId,
                faultType,
                evidenceLeafHash,
                salt,
                keccak256(evidenceData)
            )
        );
        bytes32 revealEthSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", revealDigest));
        address revealSigner = _recoverSignerCalldata(revealEthSignedHash, challengerSig);
        if (revealSigner == address(0) || revealSigner != record.challenger) revert InvalidFaultProof();

        // Decode and verify objective fault proof data.
        (bytes32 batchId, bytes32[] memory merkleProof, PoSeTypesV2.EvidenceLeafV2 memory leaf) =
            abi.decode(evidenceData, (bytes32, bytes32[], PoSeTypesV2.EvidenceLeafV2));
        if (leaf.nodeId != targetNodeId) revert InvalidFaultProof();

        bytes32 computedLeafHash = keccak256(
            abi.encodePacked(
                leaf.epoch,
                leaf.nodeId,
                leaf.nonce,
                leaf.tipHash,
                leaf.tipHeight,
                leaf.latencyMs,
                leaf.resultCode,
                leaf.witnessBitmap
            )
        );
        if (computedLeafHash != evidenceLeafHash) revert InvalidFaultProof();

        PoSeTypes.BatchRecord storage batch = batches[batchId];
        if (batch.merkleRoot == bytes32(0) || batch.disputed) revert InvalidFaultProof();
        if (_currentEpoch() > batch.disputeDeadlineEpoch) revert InvalidFaultProof();
        if (leaf.epoch != batch.epochId) revert InvalidFaultProof();
        if (!MerkleProofLite.verifyMemory(merkleProof, batch.merkleRoot, evidenceLeafHash)) revert InvalidFaultProof();

        bytes32 evidenceKey = keccak256(abi.encodePacked(batchId, targetNodeId, faultType, evidenceLeafHash));
        if (consumedFaultEvidence[evidenceKey]) revert InvalidFaultProof();

        // Fault type must match objective result code in evidence leaf.
        if (faultType == 1) {
            // DoubleSig requires dedicated equivocation proof format (not this leaf format).
            revert InvalidFaultProof();
        } else if (faultType == 2) {
            if (leaf.resultCode != 2) revert InvalidFaultProof(); // InvalidSig
        } else if (faultType == 3) {
            if (leaf.resultCode != 1) revert InvalidFaultProof(); // Timeout
        } else if (faultType == 4) {
            if (
                leaf.resultCode != 3 && // StorageProofFail
                leaf.resultCode != 4 && // RelayWitnessFail
                leaf.resultCode != 5 && // TipMismatch
                leaf.resultCode != 6 && // NonceMismatch
                leaf.resultCode != 7    // WitnessQuorumFail
            ) revert InvalidFaultProof();
        }

        record.revealed = true;
        record.targetNodeId = targetNodeId;
        record.faultType = faultType;
        consumedFaultEvidence[evidenceKey] = true;
        challengeFaultEpochPlusOne[challengeId] = leaf.epoch + 1;
        challengeFaultConfirmed[challengeId] = true;

        emit ChallengeRevealed(challengeId, targetNodeId, faultType);
    }

    function settleChallenge(bytes32 challengeId) external override {
        PoSeTypesV2.ChallengeRecord storage record = challenges[challengeId];
        if (record.challenger == address(0)) revert ChallengeNotFound();
        if (record.settled) revert ChallengeAlreadySettled();
        if (!record.revealed) {
            if (_currentEpoch() <= record.revealDeadlineEpoch) revert ChallengeNotRevealed();
            record.settled = true;
            insuranceBalance += record.bond;
            emit ChallengeSettled(challengeId, false, 0);
            return;
        }
        if (_currentEpoch() < record.revealDeadlineEpoch + ADJUDICATION_WINDOW_EPOCHS) {
            revert AdjudicationWindowNotElapsed();
        }

        record.settled = true;

        PoSeTypes.NodeRecord storage node = nodes[record.targetNodeId];
        bool faultConfirmed = challengeFaultConfirmed[challengeId] && node.active && node.bondAmount > 0;

        if (faultConfirmed) {
            uint64 slashEpoch = record.commitEpoch;
            uint64 proofEpochPlusOne = challengeFaultEpochPlusOne[challengeId];
            if (proofEpochPlusOne != 0) {
                slashEpoch = proofEpochPlusOne - 1;
            }

            // Calculate slash amount with per-epoch cap
            uint256 maxSlash = (node.bondAmount * SLASH_EPOCH_CAP_BPS) / BPS_DENOMINATOR;
            uint256 alreadySlashed = epochNodeSlashed[slashEpoch][record.targetNodeId];
            uint256 available = maxSlash > alreadySlashed ? maxSlash - alreadySlashed : 0;
            uint256 slashAmount = available > 0 ? available : 0;

            if (slashAmount > node.bondAmount) {
                slashAmount = node.bondAmount;
            }

            if (slashAmount > 0) {
                node.bondAmount -= slashAmount;
                epochNodeSlashed[slashEpoch][record.targetNodeId] += slashAmount;

                // Distribute slash: 50% burn / 30% challenger / 20% insurance
                uint256 burnAmount = (slashAmount * SLASH_BURN_BPS) / BPS_DENOMINATOR;
                uint256 challengerAmount = (slashAmount * SLASH_CHALLENGER_BPS) / BPS_DENOMINATOR;
                uint256 insuranceAmount = slashAmount - burnAmount - challengerAmount;

                insuranceBalance += insuranceAmount;

                if (node.bondAmount == 0) {
                    node.active = false;
                    _removeActiveNode(record.targetNodeId);
                }

                // Pay challenger reward + refund bond, or credit for later
                // withdrawal. Done last so every state effect — slash
                // accounting, node deactivation — precedes this external call
                // to the attacker-controlled challenger (#677, CEI ordering).
                _payOrCredit(record.challenger, challengerAmount + record.bond);

                emit SlashDistributed(record.targetNodeId, burnAmount, challengerAmount, insuranceAmount);
                emit ChallengeSettled(challengeId, true, slashAmount);
            } else {
                // Slash cap reached, refund bond.
                _payOrCredit(record.challenger, record.bond);
                emit ChallengeSettled(challengeId, false, 0);
            }
        } else {
            // Invalid fault proof: forfeit bond to insurance
            insuranceBalance += record.bond;
            emit ChallengeSettled(challengeId, false, 0);
        }
    }

    // --- #680: paginated batch processing for epoch finalization ---

    /// @notice Number of batches recorded for an epoch (epochBatches is internal).
    function getEpochBatchCount(uint64 epochId) external view override returns (uint256) {
        return epochBatches[epochId].length;
    }

    /// @dev Walk up to `maxBatches` of epochBatches[epochId] from the cursor:
    ///      mark dispute-elapsed, non-disputed batches finalized, accumulate the
    ///      valid count, and advance epochBatchCursor. Behaviour per batch is
    ///      identical to the old single-pass loop — only the iteration is split.
    function _processBatches(uint64 epochId, uint256 maxBatches) internal {
        bytes32[] storage batchIds = epochBatches[epochId];
        uint256 cursor = epochBatchCursor[epochId];
        uint256 end = cursor + maxBatches;
        if (end > batchIds.length) end = batchIds.length;
        if (end == cursor) return;

        uint32 validCount = epochValidBatchCount[epochId];
        for (uint256 i = cursor; i < end; i++) {
            PoSeTypes.BatchRecord storage batch = batches[batchIds[i]];
            if (batch.finalized || batch.disputed) continue;
            if (_currentEpoch() <= batch.disputeDeadlineEpoch) continue;
            batch.finalized = true;
            validCount += 1;
        }
        epochValidBatchCount[epochId] = validCount;
        epochBatchCursor[epochId] = end;
    }

    /// @notice #680: grind a page of an epoch's batches toward finalization.
    ///         Permissionless — purely deterministic bookkeeping, so finalization
    ///         cannot be blocked even if the owner key is unavailable. Lets a
    ///         large epochBatches array be cleared across several txs instead of
    ///         OOG-bricking finalizeEpochV2 in one unbounded loop.
    function processEpochBatches(uint64 epochId, uint256 maxBatches) external override {
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        if (_currentEpoch() <= epochId + DISPUTE_WINDOW_EPOCHS) revert DisputeWindowNotElapsed();
        _processBatches(epochId, maxBatches);
    }

    // --- Epoch finalization (allows 0 batches) ---
    function finalizeEpochV2(
        uint64 epochId,
        bytes32 rewardRoot,
        uint256 totalReward,
        uint256 slashTotal,
        uint256 treasuryDelta
    ) external override onlyOwner {
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        if (_currentEpoch() <= epochId + DISPUTE_WINDOW_EPOCHS) revert DisputeWindowNotElapsed();
        if (totalReward > 0 && rewardRoot == bytes32(0)) revert InvalidBatch();
        if (totalReward > rewardPoolBalance) revert RewardPoolInsufficient();

        // #680: process a bounded page of batches inline, then require the whole
        // array to have been walked. Epochs with <= FINALIZE_BATCH_BUDGET batches
        // (the normal case — typically 1-5) finalize in this single call; larger
        // epochs need processEpochBatches() pre-grinding, so this can never exceed
        // the block gas limit and permanently brick finalization.
        _processBatches(epochId, FINALIZE_BATCH_BUDGET);
        if (epochBatchCursor[epochId] != epochBatches[epochId].length) revert BatchesNotProcessed();

        // v2: empty epochs are allowed (epochValidBatchCount can be 0)
        epochRewardRoots[epochId] = rewardRoot;
        epochSlashTotal[epochId] = slashTotal;
        epochTreasuryDelta[epochId] = treasuryDelta;
        epochFinalized[epochId] = true;
        epochFinalizedAt[epochId] = block.timestamp;

        // --- PoSe Mining Emission: native supply ledger only ---
        if (emissionEnabled && address(cocToken) != address(0)) {
            // Epoch offset from genesis determines the year for decay rate
            uint64 relativeEpoch = epochId >= genesisEpoch ? epochId - genesisEpoch : 0;
            uint256 emission = EmissionSchedule.getEpochEmission(
                relativeEpoch,
                cocToken.totalMinted(),
                _activeNodeIds.length
            );
            if (emission > 0) {
                cocToken.mint(address(this), emission);
                emit EmissionMinted(epochId, emission);
            }
        }

        // Deduct rewards from the native reward pool. COCToken minting above is
        // supply accounting only; it does not add spendable native balance here.
        epochTotalReward[epochId] = totalReward;
        if (totalReward > rewardPoolBalance) revert RewardPoolInsufficient();
        if (totalReward > 0) {
            rewardPoolBalance -= totalReward;
        }

        emit EpochFinalizedV2(epochId, rewardRoot, totalReward);
    }

    // --- Merkle-claimable rewards ---
    function claim(
        uint64 epochId,
        bytes32 nodeId,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external override {
        if (!epochFinalized[epochId]) revert InvalidBatch();
        if (amount == 0) revert InvalidBatch();
        if (rewardClaimed[epochId][nodeId]) revert AlreadyClaimed();
        require(block.timestamp <= epochFinalizedAt[epochId] + REWARD_CLAIM_WINDOW, "claim window expired");

        // Compute reward leaf hash: keccak256(abi.encodePacked(epochId, nodeId, amount))
        bytes32 leaf = keccak256(abi.encodePacked(epochId, nodeId, amount));
        if (!MerkleProofLite.verify(merkleProof, epochRewardRoots[epochId], leaf)) {
            revert InvalidMerkleProof();
        }

        rewardClaimed[epochId][nodeId] = true;
        uint256 claimed = epochClaimedReward[epochId] + amount;
        if (claimed > epochTotalReward[epochId]) revert RewardBudgetExceeded();
        epochClaimedReward[epochId] = claimed;

        address operator = nodeOperator[nodeId];
        if (operator == address(0)) revert NodeNotFound();

        (bool ok,) = payable(operator).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit RewardClaimed(epochId, nodeId, amount);
    }

    function depositRewardPool() external payable override {
        if (msg.value == 0) revert InsufficientBond();
        rewardPoolBalance += msg.value;
    }

    function depositInsurance() external payable {
        if (msg.value == 0) revert InsufficientBond();
        insuranceBalance += msg.value;
        emit InsuranceDeposited(msg.sender, msg.value);
    }

    /**
     * @notice Sweep unclaimed rewards after the 7-day claim window.
     *         10% goes to Foundation, 90% is burned via COCToken.burn().
     *         Can be called by anyone after the claim window expires.
     */
    function sweepExpiredRewards(uint64 epochId) external {
        require(epochFinalized[epochId], "epoch not finalized");
        require(!epochSwept[epochId], "already swept");
        require(block.timestamp > epochFinalizedAt[epochId] + REWARD_CLAIM_WINDOW, "claim window active");

        uint256 total = epochTotalReward[epochId];
        uint256 claimed = epochClaimedReward[epochId];
        uint256 unclaimed = total > claimed ? total - claimed : 0;

        epochSwept[epochId] = true;

        if (unclaimed == 0) return;

        uint256 toFoundation = (unclaimed * EXPIRED_FOUNDATION_BPS) / BPS_DENOMINATOR;
        uint256 toBurn = unclaimed - toFoundation;

        // Transfer 10% to Foundation, or credit it when the address rejects ETH.
        if (toFoundation > 0 && foundationAddress != address(0)) {
            _payOrCredit(foundationAddress, toFoundation);
        }

        // Burn 90% via COCToken (if emission enabled and token set)
        if (toBurn > 0 && emissionEnabled && address(cocToken) != address(0)) {
            cocToken.burn(toBurn);
        }

        emit ExpiredRewardsSwept(epochId, toFoundation, toBurn);
    }

    /// @notice Claim ETH that could not be delivered during protocol payouts.
    function withdrawPayments() external override {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit WithdrawalClaimed(msg.sender, amount);
    }

    // --- Witness set computation ---
    function getWitnessSet(uint64 epochId) public view override returns (bytes32[] memory) {
        uint256 activeCount = _activeNodeIds.length;
        if (activeCount == 0) return new bytes32[](0);

        uint256 m = _sqrt(activeCount);
        if (m * m < activeCount) m += 1;
        if (m > activeCount) m = activeCount;
        if (m > 32) m = 32; // bitmap max 32 bits

        uint64 nonce = challengeNonces[epochId];
        bytes32[] memory witnesses = new bytes32[](m);
        uint256 selected = 0;

        for (uint256 i = 0; selected < m && i < activeCount * 3; i++) {
            uint256 idx = uint256(keccak256(abi.encodePacked(nonce, i))) % activeCount;
            bytes32 candidate = _activeNodeIds[idx];

            // Check not already selected
            bool duplicate = false;
            for (uint256 j = 0; j < selected; j++) {
                if (witnesses[j] == candidate) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) {
                witnesses[selected] = candidate;
                selected += 1;
            }
        }

        // Trim if we couldn't fill all slots
        if (selected < m) {
            bytes32[] memory trimmed = new bytes32[](selected);
            for (uint256 i = 0; i < selected; i++) {
                trimmed[i] = witnesses[i];
            }
            return trimmed;
        }

        return witnesses;
    }

    function getRequiredWitnessCount(uint64 epochId) public view returns (uint256) {
        bytes32[] memory ws = getWitnessSet(epochId);
        uint256 m = ws.length;
        // n = ceil(2m/3)
        return (2 * m + 2) / 3;
    }

    // --- Read helpers ---
    function getNode(bytes32 nodeId) external view returns (PoSeTypes.NodeRecord memory) {
        return nodes[nodeId];
    }

    function getBatch(bytes32 batchId) external view returns (PoSeTypes.BatchRecord memory) {
        return batches[batchId];
    }

    function getEpochBatchIds(uint64 epochId) external view returns (bytes32[] memory) {
        return epochBatches[epochId];
    }

    function getActiveNodeCount() external view returns (uint256) {
        return _activeNodeIds.length;
    }

    function getActiveNodeIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        uint256 total = _activeNodeIds.length;
        if (offset >= total) return new bytes32[](0);
        uint256 maxLimit = 200;
        uint256 effectiveLimit = limit > maxLimit ? maxLimit : limit;
        uint256 end = offset + effectiveLimit;
        if (end > total) end = total;
        uint256 count = end - offset;
        bytes32[] memory result = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = _activeNodeIds[offset + i];
        }
        return result;
    }

    function getChallenge(bytes32 challengeId) external view returns (PoSeTypesV2.ChallengeRecord memory) {
        return challenges[challengeId];
    }

    function setChallengeBondMin(uint256 newMin) external onlyOwner {
        if (newMin == 0) revert BondTooLow();
        challengeBondMin = newMin;
    }

    function setAllowEmptyWitnessSubmission(bool allowed) external onlyOwner {
        allowEmptyWitnessSubmission = allowed;
    }

    // --- Internal helpers ---

    function _validateWitnessQuorum(
        uint64 epochId,
        uint32 witnessBitmap,
        bytes[] calldata witnessSignatures,
        bytes32 merkleRoot
    ) internal view {
        bytes32[] memory witnessSet = getWitnessSet(epochId);
        uint256 m = witnessSet.length;

        if (m == 0) {
            if (msg.sender != owner) revert InvalidWitnessQuorum();
            if (witnessBitmap != 0 || witnessSignatures.length != 0) revert InvalidWitnessQuorum();
            return;
        }

        if (witnessBitmap == 0 && witnessSignatures.length == 0) {
            if (!allowEmptyWitnessSubmission || msg.sender != owner) {
                revert InvalidWitnessQuorum();
            }
            return;
        }

        uint256 required = (2 * m + 2) / 3; // ceil(2m/3)
        uint256 count = 0;

        for (uint256 i = 0; i < m && i < 32; i++) {
            if (witnessBitmap & (1 << i) != 0) {
                count += 1;
            }
        }

        if (count < required) revert InvalidWitnessQuorum();

        // Verify each set bit has a valid signature
        uint256 sigIdx = 0;
        for (uint256 i = 0; i < m && i < 32; i++) {
            if (witnessBitmap & (1 << i) != 0) {
                if (sigIdx >= witnessSignatures.length) revert InvalidWitnessQuorum();
                // Verify witness signature over the batch merkle root
                bytes32 witnessHash = keccak256(
                    abi.encodePacked(
                        "\x19\x01",
                        DOMAIN_SEPARATOR,
                        keccak256(abi.encode(
                            PoSeTypesV2.WITNESS_TYPEHASH,
                            merkleRoot, // challengeId field used as batch root
                            witnessSet[i], // nodeId = witness nodeId
                            merkleRoot, // responseBodyHash = merkle root
                            uint8(i) // witnessIndex
                        ))
                    )
                );
                address recovered = _recoverSigner(witnessHash, witnessSignatures[sigIdx]);
                // Witness must be the operator of the witness node
                if (recovered == address(0) || recovered != nodeOperator[witnessSet[i]]) {
                    revert InvalidWitnessQuorum();
                }
                sigIdx += 1;
            }
        }
    }

    /// @notice #667 — independent witness quorum verification used by
    ///         `submitBatchV2WithMetadata`. Verifies each set bit against the
    ///         original (challengeId, responseBodyHash) the witness attested
    ///         to (looked up via `metadata.witnessReceiptIndex`), and tracks
    ///         per-signature replay state via `_witnessSigUsed`.
    ///
    /// `internal` (not `view`) because the replay guard writes storage.
    function _validateWitnessQuorumV2(
        uint64 epochId,
        uint32 witnessBitmap,
        bytes[] calldata witnessSignatures,
        PoSeTypesV2.ReceiptBatchMetadata calldata metadata,
        bytes32 /* merkleRoot — only used for v1 fallback signature recovery, not needed here */
    ) internal {
        bytes32[] memory witnessSet = getWitnessSet(epochId);
        uint256 m = witnessSet.length;

        if (m == 0) {
            if (msg.sender != owner) revert InvalidWitnessQuorum();
            if (witnessBitmap != 0 || witnessSignatures.length != 0) revert InvalidWitnessQuorum();
            return;
        }

        if (witnessBitmap == 0 && witnessSignatures.length == 0) {
            if (!allowEmptyWitnessSubmission || msg.sender != owner) {
                revert InvalidWitnessQuorum();
            }
            return;
        }

        uint256 required = (2 * m + 2) / 3;
        uint256 count = 0;
        for (uint256 i = 0; i < m && i < 32; i++) {
            if (witnessBitmap & (1 << i) != 0) {
                count += 1;
            }
        }
        if (count < required) revert InvalidWitnessQuorum();

        uint256 numReceipts = metadata.leafHashes.length;
        uint256 sigIdx = 0;
        for (uint256 i = 0; i < m && i < 32; i++) {
            if (witnessBitmap & (1 << i) != 0) {
                if (sigIdx >= witnessSignatures.length) revert InvalidWitnessQuorum();

                // (a) Witness must currently be in the active node set —
                //     prevents a slashed/deactivated witness from being
                //     retroactively counted toward quorum.
                if (_activeNodeIndex[witnessSet[i]] == 0) revert WitnessNotActive();

                // (b) Resolve which receipt this witness attested to.
                uint16 receiptIdx = metadata.witnessReceiptIndex[i];
                if (receiptIdx >= numReceipts) revert BadReceiptIndex();

                // (c) Try v2 typehash first (binds epochId). Fall back to v1
                //     during the rollout window. PR-E will drop the v1 path.
                address operator = nodeOperator[witnessSet[i]];
                bytes calldata sig = witnessSignatures[sigIdx];
                bytes32 digestV2 = _buildWitnessDigestV2(
                    metadata.challengeIds[receiptIdx],
                    witnessSet[i],
                    metadata.responseBodyHashes[receiptIdx],
                    uint8(i),
                    epochId
                );
                address recovered = _recoverSigner(digestV2, sig);
                if (recovered != operator) {
                    bytes32 digestV1 = _buildWitnessDigestV1(
                        metadata.challengeIds[receiptIdx],
                        witnessSet[i],
                        metadata.responseBodyHashes[receiptIdx],
                        uint8(i)
                    );
                    recovered = _recoverSigner(digestV1, sig);
                }
                if (recovered == address(0) || recovered != operator) {
                    revert InvalidWitnessQuorum();
                }

                // (d) Anti-replay. (epochId, witnessNodeId, sigHash) uniquely
                //     identifies a witness attestation usage; same sig cannot
                //     be reused in two batches within an epoch nor (under v1
                //     fallback) across epochs.
                bytes32 replayKey = keccak256(abi.encodePacked(epochId, witnessSet[i], keccak256(sig)));
                if (_witnessSigUsed[replayKey]) revert WitnessSigReplay();
                _witnessSigUsed[replayKey] = true;

                sigIdx += 1;
            }
        }
    }

    /// @notice EIP-712 digest builder — v1 typehash (legacy, no epochId).
    ///         Retained during the versioned-typehash rollout for backwards
    ///         compatibility with witnesses still signing the old shape.
    function _buildWitnessDigestV1(
        bytes32 challengeId,
        bytes32 nodeId,
        bytes32 responseBodyHash,
        uint8 witnessIndex
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
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

    /// @notice EIP-712 digest builder — v2 typehash. Adds `epochId` so a
    ///         witness signature is permanently bound to the epoch in which
    ///         it was collected (defence-in-depth against cross-epoch replay).
    function _buildWitnessDigestV2(
        bytes32 challengeId,
        bytes32 nodeId,
        bytes32 responseBodyHash,
        uint8 witnessIndex,
        uint64 epochId
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
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

    /// @notice Rebuild a Merkle root from declared leaves using the same
    ///         construction as the off-chain aggregator. Standard pairwise
    ///         keccak256 of sorted-concatenated children with last-node
    ///         duplication for odd levels. Matches `MerkleProofLite.verify`
    ///         which itself uses sorted-concat hashing.
    ///
    /// Allocates an in-memory buffer the size of `leaves`; for typical batches
    /// (<= 500 receipts) this is well under the gas budget.
    function _rebuildMerkleRoot(bytes32[] calldata leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);

        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            level[i] = leaves[i];
        }

        // Always run at least one round so a single-leaf batch hashes to
        // `pairHash(leaf, leaf)` — matching the aggregator/sample-proof
        // convention used by `submitSingleLeafBatchV2`. Subsequent rounds
        // duplicate the last element on odd levels.
        do {
            uint256 nextN = (n + 1) / 2;
            for (uint256 i = 0; i < nextN; i++) {
                uint256 li = 2 * i;
                uint256 ri = li + 1 < n ? li + 1 : li;
                bytes32 l = level[li];
                bytes32 r = level[ri];
                level[i] = l < r
                    ? keccak256(abi.encodePacked(l, r))
                    : keccak256(abi.encodePacked(r, l));
            }
            n = nextN;
        } while (n > 1);
        return level[0];
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        uint8 v = uint8(sig[64]);
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > SECP256K1N_HALF) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _recoverSignerCalldata(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        uint8 v = uint8(sig[64]);
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > SECP256K1N_HALF) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _removeActiveNode(bytes32 nodeId) internal {
        uint256 indexPlusOne = _activeNodeIndex[nodeId];
        if (indexPlusOne == 0) return;
        uint256 idx = indexPlusOne - 1;
        uint256 lastIdx = _activeNodeIds.length - 1;
        if (idx != lastIdx) {
            bytes32 lastNode = _activeNodeIds[lastIdx];
            _activeNodeIds[idx] = lastNode;
            _activeNodeIndex[lastNode] = idx + 1;
        }
        _activeNodeIds.pop();
        delete _activeNodeIndex[nodeId];
    }

    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    function _requiredBond(uint8 existingNodeCount) internal pure returns (uint256) {
        return MIN_BOND << existingNodeCount;
    }

    function _payOrCredit(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[to] += amount;
            emit WithdrawalCredited(to, amount);
        }
    }

    function _verifyOwnership(bytes32 nodeId, bytes calldata pubkeyNode, bytes calldata sig) internal view {
        if (sig.length != 65) revert InvalidOwnershipProof();
        bytes32 messageHash = keccak256(abi.encodePacked("coc-register:", nodeId, msg.sender));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        uint8 v = uint8(sig[64]);
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "invalid v value");
        if (uint256(s) > SECP256K1N_HALF) revert InvalidOwnershipProof();
        address recovered = ecrecover(ethSignedHash, v, r, s);
        if (recovered == address(0)) revert InvalidOwnershipProof();
        address nodeAddr = _pubkeyToAddress(pubkeyNode);
        if (recovered != nodeAddr) revert InvalidOwnershipProof();
    }

    function _verifyEndpointAttestation(
        bytes32 endpointCommitment,
        bytes32 nodeId,
        bytes calldata pubkeyNode,
        bytes calldata attestation
    ) internal pure {
        if (attestation.length != 65) revert InvalidOwnershipProof();
        bytes32 messageHash = keccak256(abi.encodePacked("coc-endpoint:", endpointCommitment, nodeId));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        uint8 v = uint8(attestation[64]);
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(attestation.offset)
            s := calldataload(add(attestation.offset, 32))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "invalid attestation v value");
        if (uint256(s) > SECP256K1N_HALF) revert InvalidOwnershipProof();
        address recovered = ecrecover(ethSignedHash, v, r, s);
        if (recovered == address(0)) revert InvalidOwnershipProof();
        address nodeAddr = _pubkeyToAddress(pubkeyNode);
        if (recovered != nodeAddr) revert InvalidOwnershipProof();
    }

    function _pubkeyToAddress(bytes calldata pubkey) internal pure returns (address) {
        if (pubkey.length == 65) return address(uint160(uint256(keccak256(pubkey[1:]))));
        if (pubkey.length == 64) return address(uint160(uint256(keccak256(pubkey))));
        revert InvalidNodeId();
    }

    // Allow receiving ETH for burns
    receive() external payable {}

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // UUPS storage gap — append-only state from now on.
    // Reduced from 50 → 49 when `_witnessSigUsed` was added in #667 fix.
    uint256[49] private __gap;
}
