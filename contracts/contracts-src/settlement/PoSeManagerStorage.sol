// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PoSeTypes} from "./PoSeTypes.sol";

abstract contract PoSeManagerStorage is Initializable {
    uint64 public constant EPOCH_SECONDS = 3600;
    uint64 public constant DISPUTE_WINDOW_EPOCHS = 2;
    uint64 public constant UNBOND_DELAY_EPOCHS = 7 * 24; // 7 days in hours
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    uint256 public constant MIN_BOND = 0.02 ether; // ~50 USDT equivalent (COC native token, `ether` is 10^18 unit)
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

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error MissingRole();
    error ZeroOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRole(bytes32 role) {
        if (!roles[role][msg.sender]) revert MissingRole();
        _;
    }

    /// @dev Chained initializer for upgradeable derived contracts (PoSeManager
    ///      v1 and PoSeManagerV2). Each derived contract calls this from its
    ///      own `initialize(...)` function under the `initializer` modifier.
    function __PoSeManagerStorage_init(address initialOwner) internal onlyInitializing {
        if (initialOwner == address(0)) revert ZeroOwner();
        owner = initialOwner;
        roles[SLASHER_ROLE][initialOwner] = true;
    }

    /// @notice Transfer contract ownership (#686 — moves owner to a multisig).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
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

    // --- #748 (#667 F5) — v1 witness typehash sunset cap ---
    //
    // `_validateWitnessQuorumV2` tries the v2 typehash (which binds
    // epochId) first and falls back to v1 (which does not). v1 sigs
    // can therefore be replayed across epochs as long as the witness
    // is in both epochs' witnessSets and the (challengeId, bodyHash)
    // pair matches the replay target. PR-E will drop v1 entirely; until
    // then this storage slot lets the owner hard-cap the v1 fallback
    // to `epochId <= v1SunsetEpoch`. Set to `type(uint64).max` at
    // initialize() so legacy in-flight batches stay accepted by default
    // (no behaviour change on the upgrade); operators tighten it once
    // the agent fleet finishes the v2 typehash migration.
    uint64 public v1SunsetEpoch;

    // --- #746 (#667 F1+F3) — v2 witness typehash sunset cap ---
    //
    // Same shape as `v1SunsetEpoch`. `_validateWitnessQuorumV2` now tries
    // the v3 typehash (which binds `resultCode` — closes the F1 semantic
    // rubber-stamp and F3 leaf-binding gaps) first; v2 and v1 are
    // accepted as fallbacks gated by `v2SunsetEpoch` and `v1SunsetEpoch`
    // respectively. Default 0 = unlimited preserves pre-#746 behaviour
    // on upgrade (witness sigs that don't bind resultCode keep settling).
    // Multisig tightens once the agent fleet finishes the v3 migration.
    uint64 public v2SunsetEpoch;

    // UUPS storage gap (base class) — append-only state from now on.
    // Reduced from 50 → 49 when `v1SunsetEpoch` was added in #748 (#667 F5),
    // then 49 → 48 when `v2SunsetEpoch` was added in #746 (#667 F1+F3).
    uint256[48] private __gap;
}
