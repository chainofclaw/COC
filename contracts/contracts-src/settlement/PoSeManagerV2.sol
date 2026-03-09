// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoSeManagerV2} from "./IPoSeManagerV2.sol";
import {PoSeTypes} from "./PoSeTypes.sol";
import {PoSeTypesV2} from "./PoSeTypesV2.sol";
import {PoSeManagerStorage} from "./PoSeManagerStorage.sol";
import {MerkleProofLite} from "./MerkleProofLite.sol";

contract PoSeManagerV2 is IPoSeManagerV2, PoSeManagerStorage {
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 public constant SLASH_EPOCH_CAP_BPS = 500;      // 5% per epoch
    uint16 public constant SLASH_BURN_BPS = 5000;           // 50% burned
    uint16 public constant SLASH_CHALLENGER_BPS = 3000;     // 30% to challenger
    uint16 public constant SLASH_INSURANCE_BPS = 2000;      // 20% to insurance
    uint64 public constant REVEAL_WINDOW_EPOCHS = 2;
    uint64 public constant ADJUDICATION_WINDOW_EPOCHS = 2;

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

    uint256 public challengeBondMin;
    uint256 public insuranceBalance;
    bytes32 public DOMAIN_SEPARATOR;
    bool public allowEmptyWitnessSubmission = false;
    uint256 private _challengeCounter;

    // Active node tracking for witness set selection
    bytes32[] internal _activeNodeIds;
    mapping(bytes32 => uint256) internal _activeNodeIndex; // nodeId => index+1 (0 = not present)

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

    function initialize(uint256 chainId, address verifyingContract, uint256 _challengeBondMin) external onlyOwner {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("COCPoSe"),
                keccak256("2"),
                chainId,
                verifyingContract
            )
        );
        challengeBondMin = _challengeBondMin;
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
        // Transition mode: allow empty witness set/signatures to avoid deadlock during rollout.
        _validateWitnessQuorum(epochId, witnessBitmap, witnessSignatures, merkleRoot);

        batchId = _batchId(epochId, merkleRoot, summaryHash, msg.sender);
        if (batches[batchId].merkleRoot != bytes32(0)) revert BatchAlreadySubmitted();

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

                // Transfer challenger reward + refund bond
                (bool ok,) = payable(record.challenger).call{value: challengerAmount + record.bond}("");
                if (!ok) revert TransferFailed();

                if (node.bondAmount == 0) {
                    node.active = false;
                    _removeActiveNode(record.targetNodeId);
                }

                emit SlashDistributed(record.targetNodeId, burnAmount, challengerAmount, insuranceAmount);
                emit ChallengeSettled(challengeId, true, slashAmount);
            } else {
                // Slash cap reached, refund bond
                (bool ok,) = payable(record.challenger).call{value: record.bond}("");
                if (!ok) revert TransferFailed();
                emit ChallengeSettled(challengeId, false, 0);
            }
        } else {
            // Invalid fault proof: forfeit bond to insurance
            insuranceBalance += record.bond;
            emit ChallengeSettled(challengeId, false, 0);
        }
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

        // Finalize all valid batches for this epoch
        bytes32[] storage batchIds = epochBatches[epochId];
        uint32 validCount = 0;

        for (uint256 i = 0; i < batchIds.length; i++) {
            PoSeTypes.BatchRecord storage batch = batches[batchIds[i]];
            if (batch.finalized || batch.disputed) continue;
            if (_currentEpoch() <= batch.disputeDeadlineEpoch) continue;
            batch.finalized = true;
            validCount += 1;
        }

        // v2: empty epochs are allowed (validCount can be 0)
        epochValidBatchCount[epochId] = validCount;
        epochRewardRoots[epochId] = rewardRoot;
        epochTotalReward[epochId] = totalReward;
        epochSlashTotal[epochId] = slashTotal;
        epochTreasuryDelta[epochId] = treasuryDelta;
        epochFinalized[epochId] = true;

        // Deduct rewards from pool
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
        if (witnessBitmap == 0 && witnessSignatures.length == 0) {
            if (!allowEmptyWitnessSubmission && getWitnessSet(epochId).length > 0) {
                revert InvalidWitnessQuorum();
            }
            return;
        }
        bytes32[] memory witnessSet = getWitnessSet(epochId);
        uint256 m = witnessSet.length;
        if (m == 0) return; // no witnesses required if no active nodes

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
}
