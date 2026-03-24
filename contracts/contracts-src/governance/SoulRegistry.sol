// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProofLite} from "../settlement/MerkleProofLite.sol";

/// @title SoulRegistry - On-chain soul identity and backup anchoring for OpenClaw agents
/// @notice Enables AI agents to persist their identity, memory, and chat history to IPFS
///         with on-chain CID anchoring and social recovery via guardians.
contract SoulRegistry {
    // -----------------------------------------------------------------------
    //  Types
    // -----------------------------------------------------------------------

    struct SoulIdentity {
        bytes32 agentId;           // keccak256(Ed25519 pubkey)
        address owner;             // EOA controlling this soul
        bytes32 identityCid;       // IDENTITY.md + SOUL.md IPFS CID
        bytes32 latestSnapshotCid; // latest full backup manifest CID
        uint64  registeredAt;
        uint64  lastBackupAt;
        uint32  backupCount;
        uint16  version;           // schema version (forward compat)
        bool    active;
    }

    struct BackupAnchor {
        bytes32 manifestCid;       // backup manifest IPFS CID
        bytes32 dataMerkleRoot;    // Merkle root of all file hashes
        uint64  anchoredAt;
        uint32  fileCount;
        uint64  totalBytes;
        uint8   backupType;        // 0=full, 1=incremental
        bytes32 parentManifestCid; // parent CID for incremental backups
    }

    struct RecoveryGuardian {
        address guardian;
        uint64  addedAt;
        bool    active;
    }

    struct RecoveryRequest {
        bytes32 agentId;
        address newOwner;
        address initiator;
        uint64  initiatedAt;
        uint8   approvalCount;
        uint8   guardianSnapshot; // active guardian count at initiation
        bool    executed;
    }

    // -----------------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------------

    uint256 public constant MAX_GUARDIANS = 7;
    uint256 public constant RECOVERY_DELAY = 1 days;
    uint16  public constant CURRENT_VERSION = 1;

    // EIP-712 domain
    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant REGISTER_SOUL_TYPEHASH = keccak256(
        "RegisterSoul(bytes32 agentId,bytes32 identityCid,address owner,uint64 nonce)"
    );
    bytes32 public constant ANCHOR_BACKUP_TYPEHASH = keccak256(
        "AnchorBackup(bytes32 agentId,bytes32 manifestCid,bytes32 dataMerkleRoot,uint32 fileCount,uint64 totalBytes,uint8 backupType,bytes32 parentManifestCid,uint64 nonce)"
    );
    bytes32 public constant UPDATE_IDENTITY_TYPEHASH = keccak256(
        "UpdateIdentity(bytes32 agentId,bytes32 newIdentityCid,uint64 nonce)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // -----------------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------------

    mapping(bytes32 => SoulIdentity) public souls;
    mapping(address => bytes32) public ownerToAgent;
    mapping(bytes32 => BackupAnchor[]) internal _backupHistory;
    mapping(bytes32 => RecoveryGuardian[]) internal _guardians;
    mapping(bytes32 => RecoveryRequest) public recoveryRequests;
    mapping(bytes32 => mapping(address => bool)) public recoveryApprovals;
    mapping(bytes32 => uint64) public nonces;

    uint256 public soulCount;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event SoulRegistered(bytes32 indexed agentId, address indexed owner, bytes32 identityCid);
    event BackupAnchored(bytes32 indexed agentId, bytes32 manifestCid, bytes32 dataMerkleRoot, uint8 backupType);
    event IdentityUpdated(bytes32 indexed agentId, bytes32 newIdentityCid);
    event GuardianAdded(bytes32 indexed agentId, address indexed guardian);
    event GuardianRemoved(bytes32 indexed agentId, address indexed guardian);
    event RecoveryInitiated(bytes32 indexed requestId, bytes32 indexed agentId, address newOwner);
    event RecoveryApproved(bytes32 indexed requestId, address indexed guardian);
    event RecoveryCompleted(bytes32 indexed requestId, bytes32 indexed agentId, address newOwner);
    event RecoveryCancelled(bytes32 indexed requestId, bytes32 indexed agentId);
    event SoulDeactivated(bytes32 indexed agentId, address indexed owner);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error AlreadyRegistered();
    error NotRegistered();
    error NotOwner();
    error InvalidAgentId();
    error InvalidSignature();
    error InvalidNonce();
    error AgentIdTaken();
    error SoulNotActive();
    error GuardianLimitReached();
    error GuardianAlreadyAdded();
    error GuardianNotFound();
    error CannotGuardSelf();
    error RecoveryNotFound();
    error RecoveryAlreadyExecuted();
    error RecoveryNotReady();
    error AlreadyApproved();
    error NotGuardian();
    error InvalidBackupType();
    error ParentCidRequired();
    error InvalidAddress();
    error InvalidCid();

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("COCSoulRegistry"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // -----------------------------------------------------------------------
    //  Core: Registration
    // -----------------------------------------------------------------------

    /// @notice Register a new soul identity
    /// @param agentId keccak256 of the agent's Ed25519 public key
    /// @param identityCid IPFS CID of the identity files
    /// @param ownershipSig EIP-712 signature proving ownership
    function registerSoul(
        bytes32 agentId,
        bytes32 identityCid,
        bytes calldata ownershipSig
    ) external {
        if (agentId == bytes32(0)) revert InvalidAgentId();
        if (souls[agentId].active) revert AlreadyRegistered();
        if (ownerToAgent[msg.sender] != bytes32(0)) revert AlreadyRegistered();

        // Verify EIP-712 signature
        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(REGISTER_SOUL_TYPEHASH, agentId, identityCid, msg.sender, nonce)
        );
        _verifySig(structHash, ownershipSig, msg.sender);
        nonces[agentId] = nonce + 1;

        souls[agentId] = SoulIdentity({
            agentId: agentId,
            owner: msg.sender,
            identityCid: identityCid,
            latestSnapshotCid: bytes32(0),
            registeredAt: uint64(block.timestamp),
            lastBackupAt: 0,
            backupCount: 0,
            version: CURRENT_VERSION,
            active: true
        });
        ownerToAgent[msg.sender] = agentId;
        soulCount += 1;

        emit SoulRegistered(agentId, msg.sender, identityCid);
    }

    // -----------------------------------------------------------------------
    //  Core: Backup Anchoring
    // -----------------------------------------------------------------------

    /// @notice Anchor a backup manifest on-chain
    function anchorBackup(
        bytes32 agentId,
        bytes32 manifestCid,
        bytes32 dataMerkleRoot,
        uint32 fileCount,
        uint64 totalBytes,
        uint8 backupType,
        bytes32 parentManifestCid,
        bytes calldata sig
    ) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();
        if (manifestCid == bytes32(0) || dataMerkleRoot == bytes32(0)) revert InvalidCid();
        if (backupType > 1) revert InvalidBackupType();
        if (backupType == 1 && parentManifestCid == bytes32(0)) revert ParentCidRequired();

        // Verify EIP-712 signature
        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(
                ANCHOR_BACKUP_TYPEHASH,
                agentId, manifestCid, dataMerkleRoot,
                fileCount, totalBytes, backupType,
                parentManifestCid, nonce
            )
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[agentId] = nonce + 1;

        _backupHistory[agentId].push(BackupAnchor({
            manifestCid: manifestCid,
            dataMerkleRoot: dataMerkleRoot,
            anchoredAt: uint64(block.timestamp),
            fileCount: fileCount,
            totalBytes: totalBytes,
            backupType: backupType,
            parentManifestCid: parentManifestCid
        }));

        soul.latestSnapshotCid = manifestCid;
        soul.lastBackupAt = uint64(block.timestamp);
        soul.backupCount += 1;

        emit BackupAnchored(agentId, manifestCid, dataMerkleRoot, backupType);
    }

    // -----------------------------------------------------------------------
    //  Core: Identity Update
    // -----------------------------------------------------------------------

    /// @notice Update the identity CID
    function updateIdentity(
        bytes32 agentId,
        bytes32 newIdentityCid,
        bytes calldata sig
    ) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();

        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(UPDATE_IDENTITY_TYPEHASH, agentId, newIdentityCid, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[agentId] = nonce + 1;

        soul.identityCid = newIdentityCid;

        emit IdentityUpdated(agentId, newIdentityCid);
    }

    // -----------------------------------------------------------------------
    //  Views
    // -----------------------------------------------------------------------

    function getSoul(bytes32 agentId) external view returns (SoulIdentity memory) {
        return souls[agentId];
    }

    function getLatestBackup(bytes32 agentId) external view returns (BackupAnchor memory) {
        BackupAnchor[] storage history = _backupHistory[agentId];
        if (history.length == 0) {
            return BackupAnchor(bytes32(0), bytes32(0), 0, 0, 0, 0, bytes32(0));
        }
        return history[history.length - 1];
    }

    function getBackupHistory(
        bytes32 agentId,
        uint256 offset,
        uint256 limit
    ) external view returns (BackupAnchor[] memory) {
        BackupAnchor[] storage history = _backupHistory[agentId];
        if (offset >= history.length) {
            return new BackupAnchor[](0);
        }
        uint256 end = offset + limit;
        if (end > history.length) end = history.length;
        uint256 length = end - offset;
        BackupAnchor[] memory result = new BackupAnchor[](length);
        for (uint256 i = 0; i < length; i++) {
            result[i] = history[offset + i];
        }
        return result;
    }

    function getBackupCount(bytes32 agentId) external view returns (uint256) {
        return _backupHistory[agentId].length;
    }

    function getGuardians(bytes32 agentId) external view returns (RecoveryGuardian[] memory) {
        return _guardians[agentId];
    }

    function getActiveGuardianCount(bytes32 agentId) public view returns (uint256) {
        RecoveryGuardian[] storage gs = _guardians[agentId];
        uint256 count = 0;
        for (uint256 i = 0; i < gs.length; i++) {
            if (gs[i].active) count++;
        }
        return count;
    }

    // -----------------------------------------------------------------------
    //  Social Recovery: Guardian Management
    // -----------------------------------------------------------------------

    function addGuardian(bytes32 agentId, address guardian) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();
        if (guardian == msg.sender) revert CannotGuardSelf();
        if (getActiveGuardianCount(agentId) >= MAX_GUARDIANS) revert GuardianLimitReached();

        RecoveryGuardian[] storage gs = _guardians[agentId];

        // Check if already added
        for (uint256 i = 0; i < gs.length; i++) {
            if (gs[i].guardian == guardian && gs[i].active) revert GuardianAlreadyAdded();
        }

        gs.push(RecoveryGuardian({
            guardian: guardian,
            addedAt: uint64(block.timestamp),
            active: true
        }));

        emit GuardianAdded(agentId, guardian);
    }

    function removeGuardian(bytes32 agentId, address guardian) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();

        RecoveryGuardian[] storage gs = _guardians[agentId];
        bool found = false;
        for (uint256 i = 0; i < gs.length; i++) {
            if (gs[i].guardian == guardian && gs[i].active) {
                gs[i].active = false;
                found = true;
                break;
            }
        }
        if (!found) revert GuardianNotFound();

        emit GuardianRemoved(agentId, guardian);
    }

    // -----------------------------------------------------------------------
    //  Social Recovery: Recovery Process
    // -----------------------------------------------------------------------

    /// @notice Initiate recovery — must be called by an active guardian
    function initiateRecovery(bytes32 agentId, address newOwner) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (newOwner == address(0)) revert InvalidAddress();
        if (!_isActiveGuardian(agentId, msg.sender)) revert NotGuardian();

        bytes32 requestId = keccak256(
            abi.encodePacked(agentId, newOwner, block.timestamp, msg.sender)
        );

        uint256 activeCount = getActiveGuardianCount(agentId);
        recoveryRequests[requestId] = RecoveryRequest({
            agentId: agentId,
            newOwner: newOwner,
            initiator: msg.sender,
            initiatedAt: uint64(block.timestamp),
            approvalCount: 1,
            guardianSnapshot: uint8(activeCount),
            executed: false
        });
        recoveryApprovals[requestId][msg.sender] = true;

        emit RecoveryInitiated(requestId, agentId, newOwner);
        emit RecoveryApproved(requestId, msg.sender);
    }

    /// @notice Approve a pending recovery request
    function approveRecovery(bytes32 requestId) external {
        RecoveryRequest storage req = recoveryRequests[requestId];
        if (req.initiatedAt == 0) revert RecoveryNotFound();
        if (req.executed) revert RecoveryAlreadyExecuted();
        if (!_isActiveGuardian(req.agentId, msg.sender)) revert NotGuardian();
        if (recoveryApprovals[requestId][msg.sender]) revert AlreadyApproved();

        recoveryApprovals[requestId][msg.sender] = true;
        req.approvalCount += 1;

        emit RecoveryApproved(requestId, msg.sender);
    }

    /// @notice Complete recovery — requires 2/3 guardian approval + time delay
    function completeRecovery(bytes32 requestId) external {
        RecoveryRequest storage req = recoveryRequests[requestId];
        if (req.initiatedAt == 0) revert RecoveryNotFound();
        if (req.executed) revert RecoveryAlreadyExecuted();

        uint256 snapshotCount = uint256(req.guardianSnapshot);
        uint256 threshold = (snapshotCount * 2 + 2) / 3; // ceil(2/3)
        if (req.approvalCount < threshold) revert RecoveryNotReady();
        if (block.timestamp < req.initiatedAt + RECOVERY_DELAY) revert RecoveryNotReady();

        // Enforce one-to-one: newOwner must not already own another soul
        if (ownerToAgent[req.newOwner] != bytes32(0)) revert AlreadyRegistered();

        req.executed = true;

        SoulIdentity storage soul = souls[req.agentId];
        address oldOwner = soul.owner;

        // Transfer ownership
        delete ownerToAgent[oldOwner];
        soul.owner = req.newOwner;
        ownerToAgent[req.newOwner] = req.agentId;

        emit RecoveryCompleted(requestId, req.agentId, req.newOwner);
    }

    /// @notice Cancel a pending recovery request — only the soul owner
    function cancelRecovery(bytes32 requestId) external {
        RecoveryRequest storage req = recoveryRequests[requestId];
        if (req.initiatedAt == 0) revert RecoveryNotFound();
        if (req.executed) revert RecoveryAlreadyExecuted();
        if (msg.sender != souls[req.agentId].owner) revert NotOwner();

        req.executed = true;
        emit RecoveryCancelled(requestId, req.agentId);
    }

    // -----------------------------------------------------------------------
    //  Soul Lifecycle
    // -----------------------------------------------------------------------

    /// @notice Deactivate a soul — releases the owner→agent binding
    function deactivateSoul(bytes32 agentId) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();

        soul.active = false;
        delete ownerToAgent[msg.sender];

        emit SoulDeactivated(agentId, msg.sender);
    }

    // -----------------------------------------------------------------------
    //  Internal
    // -----------------------------------------------------------------------

    function _verifySig(
        bytes32 structHash,
        bytes calldata sig,
        address expectedSigner
    ) internal view {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );
        address recovered = _recoverSigner(digest, sig);
        if (recovered != expectedSigner) revert InvalidSignature();
    }

    function _recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignature();

        uint8 v = uint8(sig[64]);
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        // EIP-2: reject non-canonical s to prevent signature malleability
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }

        address recovered = ecrecover(hash, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }

    function _isActiveGuardian(bytes32 agentId, address addr) internal view returns (bool) {
        RecoveryGuardian[] storage gs = _guardians[agentId];
        for (uint256 i = 0; i < gs.length; i++) {
            if (gs[i].guardian == addr && gs[i].active) return true;
        }
        return false;
    }
}
