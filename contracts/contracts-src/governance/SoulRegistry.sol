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
        bytes32 agentId;           // unique soul id (CLI default: keccak256(owner wallet address))
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

    // Resurrection types
    enum ResurrectionTrigger {
        OwnerKey,       // Owner uses resurrection key
        GuardianVote    // Guardians vote after offline timeout
    }

    struct ResurrectionConfig {
        bytes32 resurrectionKeyHash;   // keccak256(abi.encodePacked(resurrection key address))
        uint64  maxOfflineDuration;    // max allowed offline seconds
        uint64  lastHeartbeat;         // last heartbeat timestamp
        bool    configured;            // whether configured
    }

    struct Carrier {
        bytes32 carrierId;             // unique identifier
        address owner;                 // carrier provider EOA
        string  endpoint;              // communication URL/IP
        uint64  registeredAt;
        uint64  cpuMillicores;         // CPU spec
        uint64  memoryMB;              // memory spec
        uint64  storageMB;             // storage spec
        bool    available;             // accepting new souls
        bool    active;
    }

    struct ResurrectionRequest {
        bytes32 agentId;
        bytes32 carrierId;             // target carrier
        address initiator;
        uint64  initiatedAt;
        uint8   approvalCount;
        uint8   guardianSnapshot;
        bool    executed;
        bool    carrierConfirmed;      // carrier acknowledged
        ResurrectionTrigger trigger;
    }

    // -----------------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------------

    uint256 public constant MAX_GUARDIANS = 7;
    uint256 public constant RECOVERY_DELAY = 1 days;
    uint256 public constant RESURRECTION_DELAY = 12 hours;
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
    bytes32 public constant RESURRECT_SOUL_TYPEHASH = keccak256(
        "ResurrectSoul(bytes32 agentId,bytes32 carrierId,uint64 nonce)"
    );
    bytes32 public constant HEARTBEAT_TYPEHASH = keccak256(
        "Heartbeat(bytes32 agentId,uint64 timestamp,uint64 nonce)"
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

    // Resurrection storage
    mapping(bytes32 => ResurrectionConfig) public resurrectionConfigs; // agentId => config
    mapping(bytes32 => Carrier) public carriers;                       // carrierId => carrier
    mapping(bytes32 => ResurrectionRequest) public resurrectionRequests; // requestId => request
    mapping(bytes32 => mapping(address => bool)) public resurrectionApprovals; // requestId => guardian => approved

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

    // Resurrection events
    event ResurrectionConfigured(bytes32 indexed agentId, bytes32 resurrectionKeyHash, uint64 maxOfflineDuration);
    event Heartbeat(bytes32 indexed agentId, uint64 timestamp);
    event CarrierRegistered(bytes32 indexed carrierId, address indexed owner, string endpoint);
    event CarrierDeregistered(bytes32 indexed carrierId);
    event ResurrectionInitiated(bytes32 indexed requestId, bytes32 indexed agentId, bytes32 carrierId, ResurrectionTrigger trigger);
    event ResurrectionApproved(bytes32 indexed requestId, address indexed guardian);
    event CarrierConfirmed(bytes32 indexed requestId, bytes32 indexed carrierId);
    event ResurrectionCompleted(bytes32 indexed requestId, bytes32 indexed agentId, bytes32 carrierId);
    event ResurrectionCancelled(bytes32 indexed requestId);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error AlreadyRegistered();
    error NotRegistered();
    error NotOwner();
    error InvalidAgentId();
    error InvalidSignature();
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

    // Resurrection errors
    error ResurrectionNotConfigured();
    error NotOffline();
    error CarrierNotFound();
    error CarrierNotAvailable();
    error NotCarrierOwner();
    error CarrierAlreadyRegistered();
    error ResurrectionNotFound();
    error ResurrectionAlreadyExecuted();
    error ResurrectionNotReady();
    error CarrierNotConfirmed();
    error InvalidKeyHash();

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
        if (identityCid == bytes32(0)) revert InvalidCid();
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
        if (newIdentityCid == bytes32(0)) revert InvalidCid();

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

        // Check if already added or can be reactivated
        for (uint256 i = 0; i < gs.length; i++) {
            if (gs[i].guardian == guardian) {
                if (gs[i].active) revert GuardianAlreadyAdded();
                // Reactivate existing entry instead of pushing a new one
                gs[i].active = true;
                gs[i].addedAt = uint64(block.timestamp);
                emit GuardianAdded(agentId, guardian);
                return;
            }
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
    //  Resurrection: Configuration & Heartbeat
    // -----------------------------------------------------------------------

    /// @notice Configure resurrection parameters for a soul
    function configureResurrection(
        bytes32 agentId,
        bytes32 resurrectionKeyHash,
        uint64 maxOfflineDuration
    ) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();
        if (resurrectionKeyHash == bytes32(0)) revert InvalidKeyHash();
        if (maxOfflineDuration == 0) revert InvalidAddress(); // reuse for "invalid param"

        resurrectionConfigs[agentId] = ResurrectionConfig({
            resurrectionKeyHash: resurrectionKeyHash,
            maxOfflineDuration: maxOfflineDuration,
            lastHeartbeat: uint64(block.timestamp),
            configured: true
        });

        emit ResurrectionConfigured(agentId, resurrectionKeyHash, maxOfflineDuration);
    }

    /// @notice Send heartbeat proving the agent is alive (EIP-712 signed)
    function heartbeat(
        bytes32 agentId,
        uint64 timestamp,
        bytes calldata sig
    ) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (msg.sender != soul.owner) revert NotOwner();

        ResurrectionConfig storage rc = resurrectionConfigs[agentId];
        if (!rc.configured) revert ResurrectionNotConfigured();

        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(HEARTBEAT_TYPEHASH, agentId, timestamp, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[agentId] = nonce + 1;

        rc.lastHeartbeat = uint64(block.timestamp);

        emit Heartbeat(agentId, uint64(block.timestamp));
    }

    /// @notice Check if a soul's agent is offline (heartbeat expired)
    function isOffline(bytes32 agentId) public view returns (bool) {
        ResurrectionConfig storage rc = resurrectionConfigs[agentId];
        if (!rc.configured) return false;
        return block.timestamp > rc.lastHeartbeat + rc.maxOfflineDuration;
    }

    /// @notice Get resurrection config for a soul
    function getResurrectionConfig(bytes32 agentId) external view returns (ResurrectionConfig memory) {
        return resurrectionConfigs[agentId];
    }

    // -----------------------------------------------------------------------
    //  Resurrection: Carrier Management
    // -----------------------------------------------------------------------

    /// @notice Register a new carrier (physical host for agent resurrection)
    function registerCarrier(
        bytes32 carrierId,
        string calldata endpoint,
        uint64 cpuMillicores,
        uint64 memoryMB,
        uint64 storageMB
    ) external {
        if (carrierId == bytes32(0)) revert InvalidAgentId(); // reuse for "invalid id"
        if (carriers[carrierId].active) revert CarrierAlreadyRegistered();

        carriers[carrierId] = Carrier({
            carrierId: carrierId,
            owner: msg.sender,
            endpoint: endpoint,
            registeredAt: uint64(block.timestamp),
            cpuMillicores: cpuMillicores,
            memoryMB: memoryMB,
            storageMB: storageMB,
            available: true,
            active: true
        });

        emit CarrierRegistered(carrierId, msg.sender, endpoint);
    }

    /// @notice Deregister a carrier
    function deregisterCarrier(bytes32 carrierId) external {
        Carrier storage c = carriers[carrierId];
        if (!c.active) revert CarrierNotFound();
        if (msg.sender != c.owner) revert NotCarrierOwner();

        c.active = false;
        c.available = false;

        emit CarrierDeregistered(carrierId);
    }

    /// @notice Update carrier availability
    function updateCarrierAvailability(bytes32 carrierId, bool available) external {
        Carrier storage c = carriers[carrierId];
        if (!c.active) revert CarrierNotFound();
        if (msg.sender != c.owner) revert NotCarrierOwner();

        c.available = available;
    }

    /// @notice Get carrier info
    function getCarrier(bytes32 carrierId) external view returns (Carrier memory) {
        return carriers[carrierId];
    }

    /// @notice Get aggregated readiness for a resurrection request
    function getResurrectionReadiness(bytes32 requestId) external view returns (
        bool exists,
        ResurrectionTrigger trigger,
        uint8 approvalCount,
        uint8 approvalThreshold,
        bool carrierConfirmed,
        bool offlineNow,
        uint64 readyAt,
        bool canComplete
    ) {
        ResurrectionRequest storage req = resurrectionRequests[requestId];
        if (req.initiatedAt == 0) {
            return (false, ResurrectionTrigger.OwnerKey, 0, 0, false, false, 0, false);
        }

        uint8 threshold = 0;
        uint64 executableAt = req.initiatedAt;
        if (req.trigger == ResurrectionTrigger.GuardianVote) {
            threshold = uint8((uint256(req.guardianSnapshot) * 2 + 2) / 3);
            executableAt = req.initiatedAt + uint64(RESURRECTION_DELAY);
        }

        bool currentlyOffline = isOffline(req.agentId);
        bool completeable = !req.executed && req.carrierConfirmed;
        if (req.trigger == ResurrectionTrigger.GuardianVote) {
            completeable =
                completeable &&
                currentlyOffline &&
                req.approvalCount >= threshold &&
                block.timestamp >= executableAt;
        }

        return (
            true,
            req.trigger,
            req.approvalCount,
            threshold,
            req.carrierConfirmed,
            currentlyOffline,
            executableAt,
            completeable
        );
    }

    // -----------------------------------------------------------------------
    //  Resurrection: Request Flow
    // -----------------------------------------------------------------------

    /// @notice Owner initiates resurrection using resurrection key (EIP-712 signed)
    function initiateResurrection(
        bytes32 agentId,
        bytes32 carrierId,
        bytes calldata sig
    ) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();

        ResurrectionConfig storage rc = resurrectionConfigs[agentId];
        if (!rc.configured) revert ResurrectionNotConfigured();

        Carrier storage c = carriers[carrierId];
        if (!c.active) revert CarrierNotFound();
        if (!c.available) revert CarrierNotAvailable();

        // Verify resurrection key signature
        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(RESURRECT_SOUL_TYPEHASH, agentId, carrierId, nonce)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );
        address recovered = _recoverSigner(digest, sig);
        // Verify signer's address hashes to the resurrection key hash
        if (keccak256(abi.encodePacked(recovered)) != rc.resurrectionKeyHash) revert InvalidSignature();
        nonces[agentId] = nonce + 1;

        bytes32 requestId = keccak256(
            abi.encodePacked(agentId, carrierId, block.timestamp, msg.sender, "resurrect")
        );

        resurrectionRequests[requestId] = ResurrectionRequest({
            agentId: agentId,
            carrierId: carrierId,
            initiator: msg.sender,
            initiatedAt: uint64(block.timestamp),
            approvalCount: 0,
            guardianSnapshot: 0,
            executed: false,
            carrierConfirmed: false,
            trigger: ResurrectionTrigger.OwnerKey
        });

        emit ResurrectionInitiated(requestId, agentId, carrierId, ResurrectionTrigger.OwnerKey);
    }

    /// @notice Guardian initiates resurrection after offline timeout
    function initiateGuardianResurrection(
        bytes32 agentId,
        bytes32 carrierId
    ) external {
        SoulIdentity storage soul = souls[agentId];
        if (!soul.active) revert SoulNotActive();
        if (!_isActiveGuardian(agentId, msg.sender)) revert NotGuardian();

        ResurrectionConfig storage rc = resurrectionConfigs[agentId];
        if (!rc.configured) revert ResurrectionNotConfigured();
        if (!isOffline(agentId)) revert NotOffline();

        Carrier storage c = carriers[carrierId];
        if (!c.active) revert CarrierNotFound();
        if (!c.available) revert CarrierNotAvailable();

        bytes32 requestId = keccak256(
            abi.encodePacked(agentId, carrierId, block.timestamp, msg.sender, "guardian-resurrect")
        );

        uint256 activeCount = getActiveGuardianCount(agentId);
        resurrectionRequests[requestId] = ResurrectionRequest({
            agentId: agentId,
            carrierId: carrierId,
            initiator: msg.sender,
            initiatedAt: uint64(block.timestamp),
            approvalCount: 1,
            guardianSnapshot: uint8(activeCount),
            executed: false,
            carrierConfirmed: false,
            trigger: ResurrectionTrigger.GuardianVote
        });
        resurrectionApprovals[requestId][msg.sender] = true;

        emit ResurrectionInitiated(requestId, agentId, carrierId, ResurrectionTrigger.GuardianVote);
        emit ResurrectionApproved(requestId, msg.sender);
    }

    /// @notice Guardian approves a pending resurrection request
    function approveResurrection(bytes32 requestId) external {
        ResurrectionRequest storage req = resurrectionRequests[requestId];
        if (req.initiatedAt == 0) revert ResurrectionNotFound();
        if (req.executed) revert ResurrectionAlreadyExecuted();
        if (!_isActiveGuardian(req.agentId, msg.sender)) revert NotGuardian();
        if (resurrectionApprovals[requestId][msg.sender]) revert AlreadyApproved();

        resurrectionApprovals[requestId][msg.sender] = true;
        req.approvalCount += 1;

        emit ResurrectionApproved(requestId, msg.sender);
    }

    /// @notice Carrier owner confirms willingness to host the resurrected agent
    function confirmCarrier(bytes32 requestId) external {
        ResurrectionRequest storage req = resurrectionRequests[requestId];
        if (req.initiatedAt == 0) revert ResurrectionNotFound();
        if (req.executed) revert ResurrectionAlreadyExecuted();

        Carrier storage c = carriers[req.carrierId];
        if (msg.sender != c.owner) revert NotCarrierOwner();

        req.carrierConfirmed = true;

        emit CarrierConfirmed(requestId, req.carrierId);
    }

    /// @notice Complete resurrection — conditions depend on trigger type
    function completeResurrection(bytes32 requestId) external {
        ResurrectionRequest storage req = resurrectionRequests[requestId];
        if (req.initiatedAt == 0) revert ResurrectionNotFound();
        if (req.executed) revert ResurrectionAlreadyExecuted();
        if (!req.carrierConfirmed) revert CarrierNotConfirmed();

        if (req.trigger == ResurrectionTrigger.GuardianVote) {
            // Guardian path: re-check offline status (agent may have recovered during delay)
            if (!isOffline(req.agentId)) revert NotOffline();
            // Guardian path: needs 2/3 approval + time lock
            uint256 snapshotCount = uint256(req.guardianSnapshot);
            uint256 threshold = (snapshotCount * 2 + 2) / 3; // ceil(2/3)
            if (req.approvalCount < threshold) revert ResurrectionNotReady();
            if (block.timestamp < req.initiatedAt + RESURRECTION_DELAY) revert ResurrectionNotReady();
        }
        // OwnerKey path: no approval or time lock needed, just carrier confirmation

        req.executed = true;

        // Reset heartbeat to current time so the agent is considered alive
        ResurrectionConfig storage rc = resurrectionConfigs[req.agentId];
        rc.lastHeartbeat = uint64(block.timestamp);

        emit ResurrectionCompleted(requestId, req.agentId, req.carrierId);
    }

    /// @notice Cancel a pending resurrection request
    function cancelResurrection(bytes32 requestId) external {
        ResurrectionRequest storage req = resurrectionRequests[requestId];
        if (req.initiatedAt == 0) revert ResurrectionNotFound();
        if (req.executed) revert ResurrectionAlreadyExecuted();

        // Owner or initiator can cancel
        bytes32 agentId = req.agentId;
        if (msg.sender != souls[agentId].owner && msg.sender != req.initiator) revert NotOwner();

        req.executed = true;
        emit ResurrectionCancelled(requestId);
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
