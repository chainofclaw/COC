// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoSeManager} from "./IPoSeManager.sol";
import {PoSeTypes} from "./PoSeTypes.sol";
import {PoSeManagerStorage} from "./PoSeManagerStorage.sol";
import {MerkleProofLite} from "./MerkleProofLite.sol";

contract PoSeManager is IPoSeManager, PoSeManagerStorage {
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    error InvalidNodeId();
    error NodeAlreadyRegistered();
    error NodeNotFound();
    error NotNodeOperator();
    error InvalidBatch();
    error BatchAlreadySubmitted();
    error BatchAlreadyDisputed();
    error BatchAlreadyFinalized();
    error InvalidEpoch();
    error DisputeWindowClosed();
    error EpochAlreadyFinalized();
    error DisputeWindowNotElapsed();
    error NoFinalizableBatch();
    error InvalidSlashEvidence();
    error EvidenceAlreadyUsed();
    error AlreadyUnbonding();
    error UnlockNotReached();
    error NoBondToWithdraw();
    error TransferFailed();
    error InsufficientBond();
    error TooManyNodes();
    error InvalidOwnershipProof();
    error EndpointAlreadyRegistered();
    error NodeNotSlashable();

    function registerNode(
        bytes32 nodeId,
        bytes calldata pubkeyNode,
        uint8 serviceFlags,
        bytes32 serviceCommitment,
        bytes32 endpointCommitment,
        bytes32 metadataHash,
        bytes calldata ownershipSig
    ) external payable override {
        if (msg.value < _requiredBond(operatorNodeCount[msg.sender])) revert InsufficientBond();
        if (operatorNodeCount[msg.sender] >= MAX_NODES_PER_OPERATOR) revert TooManyNodes();
        if (nodeId == bytes32(0) || keccak256(pubkeyNode) != nodeId) revert InvalidNodeId();
        if (nodes[nodeId].active) revert NodeAlreadyRegistered();
        if (endpointCommitmentUsed[endpointCommitment]) revert EndpointAlreadyRegistered();

        _verifyOwnership(nodeId, pubkeyNode, ownershipSig);

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

        emit NodeRegistered(nodeId, msg.sender, serviceFlags, msg.value);
    }

    function updateCommitment(bytes32 nodeId, bytes32 newCommitment) external override {
        PoSeTypes.NodeRecord storage node = nodes[nodeId];
        if (!node.active) revert NodeNotFound();
        if (nodeOperator[nodeId] != msg.sender) revert NotNodeOperator();

        node.serviceCommitment = newCommitment;
        emit NodeCommitmentUpdated(nodeId, newCommitment);
    }

    function submitBatch(
        uint64 epochId,
        bytes32 merkleRoot,
        bytes32 summaryHash,
        PoSeTypes.SampleProof[] calldata sampleProofs
    ) external override returns (bytes32 batchId) {
        if (merkleRoot == bytes32(0) || summaryHash == bytes32(0)) revert InvalidBatch();
        uint64 currentEpoch = _currentEpoch();
        if (epochId > currentEpoch) revert InvalidEpoch();
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();

        if (sampleProofs.length == 0) revert InvalidBatch();
        if (sampleProofs.length > type(uint16).max) revert InvalidBatch();

        batchId = _batchId(epochId, merkleRoot, summaryHash, msg.sender);
        if (batches[batchId].merkleRoot != bytes32(0)) revert BatchAlreadySubmitted();

        bytes32 sampleCommitment = bytes32(0);
        uint32 lastLeafIndex = 0;
        bool hasLastIndex = false;
        for (uint256 i = 0; i < sampleProofs.length; i++) {
            PoSeTypes.SampleProof calldata proof = sampleProofs[i];
            if (proof.leaf == bytes32(0)) revert InvalidBatch();
            if (proof.merkleProof.length == 0) revert InvalidBatch();
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

        emit BatchSubmitted(epochId, batchId, merkleRoot, summaryHash);
    }

    function challengeBatch(bytes32 batchId, bytes32 receiptLeaf, bytes32[] calldata merkleProof)
        external
        override
        onlyRole(SLASHER_ROLE)
    {
        PoSeTypes.BatchRecord storage batch = batches[batchId];
        if (batch.merkleRoot == bytes32(0)) revert InvalidBatch();
        if (batch.finalized) revert BatchAlreadyFinalized();
        if (batch.disputed) revert BatchAlreadyDisputed();
        if (_currentEpoch() > batch.disputeDeadlineEpoch) revert DisputeWindowClosed();
        if (receiptLeaf == bytes32(0) || merkleProof.length == 0) revert InvalidBatch();
        if (!MerkleProofLite.verify(merkleProof, batch.merkleRoot, receiptLeaf)) revert InvalidBatch();
        if (batchSampledLeaf[batchId][receiptLeaf]) revert InvalidBatch();

        bytes32 replayKey = keccak256(abi.encodePacked("challenge-batch", batchId, receiptLeaf));
        if (usedReplayKeys[replayKey]) revert EvidenceAlreadyUsed();
        usedReplayKeys[replayKey] = true;

        batch.disputed = true;
        emit BatchChallenged(batchId, msg.sender, receiptLeaf);
    }

    function finalizeEpoch(uint64 epochId) external override {
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        if (_currentEpoch() <= epochId + DISPUTE_WINDOW_EPOCHS) revert DisputeWindowNotElapsed();

        bytes32[] storage batchIds = epochBatches[epochId];
        bytes32 rollingRoot = bytes32(0);
        uint32 validCount = 0;

        for (uint256 i = 0; i < batchIds.length; i++) {
            bytes32 batchId = batchIds[i];
            PoSeTypes.BatchRecord storage batch = batches[batchId];
            if (batch.finalized || batch.disputed) {
                continue;
            }
            if (_currentEpoch() <= batch.disputeDeadlineEpoch) revert DisputeWindowNotElapsed();

            batch.finalized = true;
            validCount += 1;
            rollingRoot = keccak256(abi.encodePacked(rollingRoot, batch.summaryHash, batch.merkleRoot, batch.aggregator));
        }

        if (validCount == 0) revert NoFinalizableBatch();

        epochValidBatchCount[epochId] = validCount;
        epochSettlementRoot[epochId] = rollingRoot;
        epochFinalized[epochId] = true;
        emit EpochFinalized(epochId);
    }

    function slash(bytes32 nodeId, PoSeTypes.SlashEvidence calldata evidence) external override onlyRole(SLASHER_ROLE) {
        PoSeTypes.NodeRecord storage node = nodes[nodeId];
        if (node.nodeId == bytes32(0)) revert NodeNotFound();
        if (node.bondAmount == 0) revert NodeNotSlashable();
        if (evidence.evidenceHash == bytes32(0)) revert InvalidSlashEvidence();
        if (evidence.nodeId != nodeId) revert InvalidSlashEvidence();
        if (evidence.reasonCode == 0) revert InvalidSlashEvidence();
        if (evidence.evidenceHash != keccak256(evidence.rawEvidence)) revert InvalidSlashEvidence();

        bytes32 replayKey = keccak256(abi.encodePacked("slash-evidence", nodeId, evidence.reasonCode, evidence.evidenceHash));
        if (usedReplayKeys[replayKey]) revert EvidenceAlreadyUsed();
        usedReplayKeys[replayKey] = true;

        uint16 slashBps = _slashBps(evidence.reasonCode);
        uint256 slashAmount = (node.bondAmount * slashBps) / BPS_DENOMINATOR;
        if (slashAmount == 0 && node.bondAmount > 0) {
            slashAmount = 1;
        }
        if (slashAmount > node.bondAmount) {
            slashAmount = node.bondAmount;
        }
        node.bondAmount -= slashAmount;
        if (node.bondAmount == 0) {
            node.active = false;
        }

        emit NodeSlashed(nodeId, slashAmount, evidence.reasonCode);
    }

    function requestUnbond(bytes32 nodeId) external override {
        PoSeTypes.NodeRecord storage node = nodes[nodeId];
        if (!node.active) revert NodeNotFound();
        if (nodeOperator[nodeId] != msg.sender) revert NotNodeOperator();
        if (unbondRequested[nodeId]) revert AlreadyUnbonding();

        uint64 currentEpoch = _currentEpoch();
        uint64 unlockEpoch = currentEpoch + UNBOND_DELAY_EPOCHS;
        node.unlockEpoch = unlockEpoch;
        node.active = false;
        unbondRequested[nodeId] = true;
        endpointCommitmentUsed[node.endpointCommitment] = false;
        if (operatorNodeCount[msg.sender] > 0) {
            operatorNodeCount[msg.sender] -= 1;
        }

        emit UnbondRequested(nodeId, unlockEpoch);
    }

    function withdraw(bytes32 nodeId) external override {
        PoSeTypes.NodeRecord storage node = nodes[nodeId];
        if (nodeOperator[nodeId] != msg.sender) revert NotNodeOperator();
        if (!unbondRequested[nodeId]) revert NodeNotFound();
        if (_currentEpoch() < node.unlockEpoch) revert UnlockNotReached();
        if (node.bondAmount == 0) revert NoBondToWithdraw();

        uint256 amount = node.bondAmount;
        node.bondAmount = 0;
        unbondRequested[nodeId] = false;

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(nodeId, msg.sender, amount);
    }

    function setSlasher(address account, bool enabled) external onlyOwner {
        _setRole(SLASHER_ROLE, account, enabled);
    }

    // Read helpers for off-chain indexer and relayer.
    function getNode(bytes32 nodeId) external view returns (PoSeTypes.NodeRecord memory) {
        return nodes[nodeId];
    }

    function getBatch(bytes32 batchId) external view returns (PoSeTypes.BatchRecord memory) {
        return batches[batchId];
    }

    function getEpochBatchIds(uint64 epochId) external view returns (bytes32[] memory) {
        return epochBatches[epochId];
    }

    function getBatchSampleInfo(bytes32 batchId) external view returns (uint32 sampleCount, bytes32 sampleCommitment) {
        return (batchSampleCount[batchId], batchSampleCommitment[batchId]);
    }

    function isSampleLeaf(bytes32 batchId, bytes32 leaf) external view returns (bool) {
        return batchSampledLeaf[batchId][leaf];
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

    function _pubkeyToAddress(bytes calldata pubkey) internal pure returns (address) {
        if (pubkey.length == 65) {
            return address(uint160(uint256(keccak256(pubkey[1:]))));
        }
        if (pubkey.length == 64) {
            return address(uint160(uint256(keccak256(pubkey))));
        }
        revert InvalidNodeId();
    }

    // 渐进式质押: MIN_BOND << n (0.1, 0.2, 0.4, 0.8, 1.6 ETH)
    function _requiredBond(uint8 existingNodeCount) internal pure returns (uint256) {
        return MIN_BOND << existingNodeCount;
    }

    function requiredBond(address operator) external view returns (uint256) {
        return _requiredBond(operatorNodeCount[operator]);
    }

    function _slashBps(uint8 reasonCode) internal pure returns (uint16) {
        if (reasonCode == 1) return 2000; // nonce replay / obvious fraud
        if (reasonCode == 2) return 1500; // invalid signature
        if (reasonCode == 3) return 500; // timeout / liveness fault
        if (reasonCode == 4) return 3000; // invalid storage proof
        if (reasonCode >= 5) return 1000; // generic provable fault
        return 1000;
    }
}
