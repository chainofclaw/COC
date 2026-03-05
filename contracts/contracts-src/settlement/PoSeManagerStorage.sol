// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoSeTypes} from "./PoSeTypes.sol";

abstract contract PoSeManagerStorage {
    uint64 public constant EPOCH_SECONDS = 3600;
    uint64 public constant DISPUTE_WINDOW_EPOCHS = 2;
    uint64 public constant UNBOND_DELAY_EPOCHS = 7 * 24; // 7 days in hours
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    uint256 public constant MIN_BOND = 0.1 ether;
    uint8 public constant MAX_NODES_PER_OPERATOR = 5;

    address public owner;
    mapping(bytes32 => mapping(address => bool)) internal roles;

    mapping(bytes32 => PoSeTypes.NodeRecord) internal nodes;
    mapping(bytes32 => address) public nodeOperator;
    mapping(address => uint8) public operatorNodeCount;

    mapping(uint64 => bytes32[]) internal epochBatches;
    mapping(bytes32 => PoSeTypes.BatchRecord) internal batches;
    mapping(bytes32 => uint32) internal batchSampleCount;
    mapping(bytes32 => bytes32) internal batchSampleCommitment;
    mapping(bytes32 => mapping(bytes32 => bool)) internal batchSampledLeaf;

    // Domain-separated replay guard: key = keccak256(domain || nonce)
    mapping(bytes32 => bool) internal usedReplayKeys;

    // Epoch-level state flags
    mapping(uint64 => bool) public epochFinalized;
    mapping(uint64 => bytes32) public epochSettlementRoot;
    mapping(uint64 => uint32) public epochValidBatchCount;
    mapping(bytes32 => bool) public unbondRequested;

    // Sybil防护: 全局唯一 endpointCommitment，防止同机器多节点注册
    mapping(bytes32 => bool) public endpointCommitmentUsed;

    // Reward pool
    uint256 public rewardPoolBalance;
    mapping(uint64 => bool) public epochRewardsDistributed;
    mapping(bytes32 => uint256) public pendingRewards;
    uint16 public constant MAX_REWARD_PER_NODE_BPS = 3000; // 30% cap per node

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyRole(bytes32 role) {
        require(roles[role][msg.sender], "missing role");
        _;
    }

    constructor() {
        owner = msg.sender;
        roles[SLASHER_ROLE][msg.sender] = true;
    }

    function _currentEpoch() internal view returns (uint64) {
        return uint64(block.timestamp / EPOCH_SECONDS);
    }

    function _batchId(uint64 epochId, bytes32 merkleRoot, bytes32 summaryHash, address aggregator)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(epochId, merkleRoot, summaryHash, aggregator));
    }

    function _setRole(bytes32 role, address account, bool enabled) internal {
        roles[role][account] = enabled;
    }
}
