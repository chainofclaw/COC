// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DIDRegistry - DID management for AI agents on COC blockchain
/// @notice Extends SoulRegistry with key rotation, delegation, credentials,
///         ephemeral identities, and agent lineage tracking.
///         References SoulRegistry for identity verification (does not modify it).
interface ISoulRegistry {
    struct SoulIdentity {
        bytes32 agentId;
        address owner;
        bytes32 identityCid;
        bytes32 latestSnapshotCid;
        uint64  registeredAt;
        uint64  lastBackupAt;
        uint32  backupCount;
        uint16  version;
        bool    active;
    }
    function souls(bytes32 agentId) external view returns (
        bytes32, address, bytes32, bytes32, uint64, uint64, uint32, uint16, bool
    );
    function getSoul(bytes32 agentId) external view returns (SoulIdentity memory);
}

contract DIDRegistry {
    // -----------------------------------------------------------------------
    //  Types
    // -----------------------------------------------------------------------

    struct VerificationMethod {
        bytes32 keyId;          // keccak256 of key label (e.g. keccak256("operational"))
        address keyAddress;
        uint8   keyPurpose;     // bitmask: 1=auth, 2=assertion, 4=capInvocation, 8=capDelegation
        uint64  addedAt;
        uint64  revokedAt;      // 0 = active
        bool    active;
    }

    struct DelegationRecord {
        bytes32 delegator;      // agentId of delegator
        bytes32 delegatee;      // agentId of delegatee
        bytes32 parentDelegation; // bytes32(0) for root delegation
        bytes32 scopeHash;      // keccak256 of canonical scope encoding
        uint64  issuedAt;
        uint64  expiresAt;
        uint8   depth;          // chain depth (0 = direct from principal)
        bool    revoked;
    }

    struct EphemeralIdentity {
        bytes32 parentAgentId;
        address ephemeralAddress;
        bytes32 scopeHash;
        uint64  createdAt;
        uint64  expiresAt;
        bool    active;
    }

    struct Lineage {
        bytes32 parentAgentId;  // bytes32(0) for genesis agents
        uint64  forkHeight;
        uint8   generation;
    }

    struct CredentialAnchor {
        bytes32 credentialHash; // keccak256 of full credential
        bytes32 issuerAgentId;
        bytes32 subjectAgentId;
        bytes32 credentialCid;  // IPFS CID hash of credential
        uint64  issuedAt;
        uint64  expiresAt;
        bool    revoked;
    }

    // -----------------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------------

    uint8   public constant MAX_DELEGATION_DEPTH = 3;
    uint64  public constant MIN_DELEGATION_INTERVAL = 60; // 1 minute
    uint256 public constant MAX_VERIFICATION_METHODS = 8;
    uint256 public constant MAX_DELEGATIONS_PER_AGENT = 32;

    // Key purpose bitmask
    uint8 public constant PURPOSE_AUTH = 0x01;
    uint8 public constant PURPOSE_ASSERTION = 0x02;
    uint8 public constant PURPOSE_CAP_INVOCATION = 0x04;
    uint8 public constant PURPOSE_CAP_DELEGATION = 0x08;

    // EIP-712
    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant UPDATE_DID_DOCUMENT_TYPEHASH = keccak256(
        "UpdateDIDDocument(bytes32 agentId,bytes32 newDocumentCid,uint64 nonce)"
    );
    bytes32 public constant ADD_VERIFICATION_METHOD_TYPEHASH = keccak256(
        "AddVerificationMethod(bytes32 agentId,bytes32 keyId,address keyAddress,uint8 keyPurpose,uint64 nonce)"
    );
    bytes32 public constant REVOKE_VERIFICATION_METHOD_TYPEHASH = keccak256(
        "RevokeVerificationMethod(bytes32 agentId,bytes32 keyId,uint64 nonce)"
    );
    bytes32 public constant GRANT_DELEGATION_TYPEHASH = keccak256(
        "GrantDelegation(bytes32 delegator,bytes32 delegatee,bytes32 parentDelegation,bytes32 scopeHash,uint64 expiresAt,uint8 depth,uint64 nonce)"
    );
    bytes32 public constant REVOKE_DELEGATION_TYPEHASH = keccak256(
        "RevokeDelegation(bytes32 delegationId,uint64 nonce)"
    );
    bytes32 public constant CREATE_EPHEMERAL_IDENTITY_TYPEHASH = keccak256(
        "CreateEphemeralIdentity(bytes32 parentAgentId,bytes32 ephemeralId,address ephemeralAddress,bytes32 scopeHash,uint64 expiresAt,uint64 nonce)"
    );
    bytes32 public constant ANCHOR_CREDENTIAL_TYPEHASH = keccak256(
        "AnchorCredential(bytes32 credentialHash,bytes32 issuerAgentId,bytes32 subjectAgentId,bytes32 credentialCid,uint64 expiresAt,uint64 nonce)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;
    ISoulRegistry public immutable soulRegistry;

    // -----------------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------------

    // DID document CID
    mapping(bytes32 => bytes32) public didDocumentCid;
    mapping(bytes32 => uint64) public didDocumentUpdatedAt;

    // Verification methods
    mapping(bytes32 => VerificationMethod[]) internal _verificationMethods;

    // Delegations
    mapping(bytes32 => DelegationRecord) public delegations;
    mapping(bytes32 => bytes32[]) internal _agentDelegations;
    mapping(bytes32 => uint64) public lastDelegationTimestamp;
    mapping(bytes32 => uint64) public globalRevocationEpoch;

    // Capabilities
    mapping(bytes32 => uint16) public agentCapabilities;

    // Ephemeral identities
    mapping(bytes32 => EphemeralIdentity) public ephemeralIdentities;

    // Lineage
    mapping(bytes32 => Lineage) public agentLineage;

    // Credentials
    mapping(bytes32 => CredentialAnchor) public credentials;

    // Nonces (per agentId)
    mapping(bytes32 => uint64) public nonces;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event DIDDocumentUpdated(bytes32 indexed agentId, bytes32 newCid);
    event VerificationMethodAdded(bytes32 indexed agentId, bytes32 keyId, address keyAddress, uint8 purpose);
    event VerificationMethodRevoked(bytes32 indexed agentId, bytes32 keyId);
    event DelegationGranted(bytes32 indexed delegationId, bytes32 indexed delegator, bytes32 indexed delegatee, uint64 expiresAt);
    event DelegationRevoked(bytes32 indexed delegationId);
    event GlobalRevocationSet(bytes32 indexed agentId, uint64 epoch);
    event EphemeralIdentityCreated(bytes32 indexed parentAgentId, bytes32 indexed ephemeralId);
    event EphemeralIdentityDeactivated(bytes32 indexed ephemeralId);
    event CapabilitiesUpdated(bytes32 indexed agentId, uint16 capabilities);
    event LineageRecorded(bytes32 indexed agentId, bytes32 indexed parentAgentId, uint8 generation);
    event CredentialAnchored(bytes32 indexed credentialId, bytes32 indexed issuer, bytes32 indexed subject);
    event CredentialRevoked(bytes32 indexed credentialId);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error SoulNotActive();
    error NotOwner();
    error InvalidSignature();
    error InvalidAgentId();
    error InvalidKeyId();
    error InvalidKeyAddress();
    error KeyLimitReached();
    error KeyAlreadyExists();
    error KeyNotFound();
    error DelegationTooDeep();
    error DelegationRateLimited();
    error DelegationLimitReached();
    error DelegationNotFound();
    error DelegationAlreadyRevoked();
    error DelegationExpired();
    error InvalidExpiry();
    error EphemeralNotFound();
    error EphemeralAlreadyExists();
    error CredentialNotFound();
    error CredentialAlreadyRevoked();
    error InvalidCredentialHash();

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor(address _soulRegistry) {
        soulRegistry = ISoulRegistry(_soulRegistry);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("COCDIDRegistry"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // -----------------------------------------------------------------------
    //  Modifiers
    // -----------------------------------------------------------------------

    modifier onlySoulOwner(bytes32 agentId) {
        ISoulRegistry.SoulIdentity memory soul = soulRegistry.getSoul(agentId);
        if (!soul.active) revert SoulNotActive();
        if (soul.owner != msg.sender) revert NotOwner();
        _;
    }

    // -----------------------------------------------------------------------
    //  DID Document Management
    // -----------------------------------------------------------------------

    /// @notice Update the DID Document CID for an agent
    function updateDIDDocument(
        bytes32 agentId,
        bytes32 newDocumentCid,
        bytes calldata sig
    ) external onlySoulOwner(agentId) {
        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(UPDATE_DID_DOCUMENT_TYPEHASH, agentId, newDocumentCid, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[agentId] = nonce + 1;

        didDocumentCid[agentId] = newDocumentCid;
        didDocumentUpdatedAt[agentId] = uint64(block.timestamp);
        emit DIDDocumentUpdated(agentId, newDocumentCid);
    }

    // -----------------------------------------------------------------------
    //  Verification Method Management (Key Rotation)
    // -----------------------------------------------------------------------

    /// @notice Add a new verification method (key) for an agent
    function addVerificationMethod(
        bytes32 agentId,
        bytes32 keyId,
        address keyAddress,
        uint8   keyPurpose,
        bytes calldata sig
    ) external onlySoulOwner(agentId) {
        if (keyId == bytes32(0)) revert InvalidKeyId();
        if (keyAddress == address(0)) revert InvalidKeyAddress();
        if (_verificationMethods[agentId].length >= MAX_VERIFICATION_METHODS) revert KeyLimitReached();

        // Check for duplicate active key
        VerificationMethod[] storage methods = _verificationMethods[agentId];
        for (uint256 i = 0; i < methods.length; i++) {
            if (methods[i].keyId == keyId && methods[i].active) revert KeyAlreadyExists();
        }

        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(ADD_VERIFICATION_METHOD_TYPEHASH, agentId, keyId, keyAddress, keyPurpose, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[agentId] = nonce + 1;

        methods.push(VerificationMethod({
            keyId: keyId,
            keyAddress: keyAddress,
            keyPurpose: keyPurpose,
            addedAt: uint64(block.timestamp),
            revokedAt: 0,
            active: true
        }));

        emit VerificationMethodAdded(agentId, keyId, keyAddress, keyPurpose);
    }

    /// @notice Revoke a verification method
    function revokeVerificationMethod(
        bytes32 agentId,
        bytes32 keyId,
        bytes calldata sig
    ) external onlySoulOwner(agentId) {
        uint64 nonce = nonces[agentId];
        bytes32 structHash = keccak256(
            abi.encode(REVOKE_VERIFICATION_METHOD_TYPEHASH, agentId, keyId, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[agentId] = nonce + 1;

        bool found = false;
        VerificationMethod[] storage methods = _verificationMethods[agentId];
        for (uint256 i = 0; i < methods.length; i++) {
            if (methods[i].keyId == keyId && methods[i].active) {
                methods[i].active = false;
                methods[i].revokedAt = uint64(block.timestamp);
                found = true;
                break;
            }
        }
        if (!found) revert KeyNotFound();

        emit VerificationMethodRevoked(agentId, keyId);
    }

    /// @notice Get all verification methods for an agent
    function getVerificationMethods(bytes32 agentId) external view returns (VerificationMethod[] memory) {
        return _verificationMethods[agentId];
    }

    /// @notice Get only active verification methods
    function getActiveVerificationMethods(bytes32 agentId) external view returns (VerificationMethod[] memory) {
        VerificationMethod[] storage methods = _verificationMethods[agentId];
        uint256 count = 0;
        for (uint256 i = 0; i < methods.length; i++) {
            if (methods[i].active) count++;
        }
        VerificationMethod[] memory result = new VerificationMethod[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < methods.length; i++) {
            if (methods[i].active) {
                result[idx++] = methods[i];
            }
        }
        return result;
    }

    // -----------------------------------------------------------------------
    //  Delegation Management
    // -----------------------------------------------------------------------

    /// @notice Grant a delegation credential
    function grantDelegation(
        bytes32 delegator,
        bytes32 delegatee,
        bytes32 parentDelegation,
        bytes32 scopeHash,
        uint64  expiresAt,
        uint8   depth,
        bytes calldata sig
    ) external onlySoulOwner(delegator) {
        if (delegatee == bytes32(0)) revert InvalidAgentId();
        if (expiresAt <= uint64(block.timestamp)) revert InvalidExpiry();
        if (depth > MAX_DELEGATION_DEPTH) revert DelegationTooDeep();
        if (_agentDelegations[delegator].length >= MAX_DELEGATIONS_PER_AGENT) revert DelegationLimitReached();

        // Rate limiting
        if (uint64(block.timestamp) < lastDelegationTimestamp[delegator] + MIN_DELEGATION_INTERVAL) {
            revert DelegationRateLimited();
        }

        // If depth > 0, verify parent delegation exists and is valid
        if (depth > 0) {
            DelegationRecord storage parent = delegations[parentDelegation];
            if (parent.delegator == bytes32(0)) revert DelegationNotFound();
            if (parent.revoked) revert DelegationAlreadyRevoked();
            if (parent.expiresAt < uint64(block.timestamp)) revert DelegationExpired();
            // Delegatee of parent must be our delegator
            if (parent.delegatee != delegator) revert NotOwner();
            // Expiry ceiling: child cannot outlive parent
            if (expiresAt > parent.expiresAt) revert InvalidExpiry();
            // Depth must be exactly parent + 1
            if (depth != parent.depth + 1) revert DelegationTooDeep();
        }

        uint64 nonce = nonces[delegator];
        bytes32 structHash = keccak256(
            abi.encode(GRANT_DELEGATION_TYPEHASH, delegator, delegatee, parentDelegation, scopeHash, expiresAt, depth, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[delegator] = nonce + 1;

        bytes32 delegationId = keccak256(
            abi.encode(delegator, delegatee, nonce, block.chainid)
        );

        delegations[delegationId] = DelegationRecord({
            delegator: delegator,
            delegatee: delegatee,
            parentDelegation: parentDelegation,
            scopeHash: scopeHash,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            depth: depth,
            revoked: false
        });

        _agentDelegations[delegator].push(delegationId);
        lastDelegationTimestamp[delegator] = uint64(block.timestamp);

        emit DelegationGranted(delegationId, delegator, delegatee, expiresAt);
    }

    /// @notice Revoke a specific delegation
    function revokeDelegation(
        bytes32 delegationId,
        bytes calldata sig
    ) external {
        DelegationRecord storage d = delegations[delegationId];
        if (d.delegator == bytes32(0)) revert DelegationNotFound();
        if (d.revoked) revert DelegationAlreadyRevoked();

        // Only delegator's owner can revoke
        ISoulRegistry.SoulIdentity memory soul = soulRegistry.getSoul(d.delegator);
        if (soul.owner != msg.sender) revert NotOwner();

        uint64 nonce = nonces[d.delegator];
        bytes32 structHash = keccak256(
            abi.encode(REVOKE_DELEGATION_TYPEHASH, delegationId, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[d.delegator] = nonce + 1;

        d.revoked = true;
        emit DelegationRevoked(delegationId);
    }

    /// @notice Revoke all delegations from an agent (emergency)
    function revokeAllDelegations(bytes32 agentId) external onlySoulOwner(agentId) {
        globalRevocationEpoch[agentId] = uint64(block.timestamp);
        emit GlobalRevocationSet(agentId, uint64(block.timestamp));
    }

    /// @notice Get delegations issued by an agent
    function getAgentDelegations(bytes32 agentId) external view returns (bytes32[] memory) {
        return _agentDelegations[agentId];
    }

    /// @notice Check if a delegation is currently valid
    function isDelegationValid(bytes32 delegationId) external view returns (bool) {
        DelegationRecord storage d = delegations[delegationId];
        if (d.delegator == bytes32(0)) return false;
        if (d.revoked) return false;
        if (d.expiresAt < uint64(block.timestamp)) return false;
        if (d.issuedAt < globalRevocationEpoch[d.delegator]) return false;
        return true;
    }

    // -----------------------------------------------------------------------
    //  Capabilities
    // -----------------------------------------------------------------------

    /// @notice Update capability bitmask for an agent
    function updateCapabilities(bytes32 agentId, uint16 capabilities) external onlySoulOwner(agentId) {
        agentCapabilities[agentId] = capabilities;
        emit CapabilitiesUpdated(agentId, capabilities);
    }

    // -----------------------------------------------------------------------
    //  Ephemeral Identities
    // -----------------------------------------------------------------------

    /// @notice Create an ephemeral sub-identity
    function createEphemeralIdentity(
        bytes32 parentAgentId,
        bytes32 ephemeralId,
        address ephemeralAddress,
        bytes32 scopeHash,
        uint64  expiresAt,
        bytes calldata sig
    ) external onlySoulOwner(parentAgentId) {
        if (ephemeralId == bytes32(0)) revert InvalidAgentId();
        if (ephemeralIdentities[ephemeralId].parentAgentId != bytes32(0)) revert EphemeralAlreadyExists();
        if (expiresAt <= uint64(block.timestamp)) revert InvalidExpiry();

        uint64 nonce = nonces[parentAgentId];
        bytes32 structHash = keccak256(
            abi.encode(CREATE_EPHEMERAL_IDENTITY_TYPEHASH, parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[parentAgentId] = nonce + 1;

        ephemeralIdentities[ephemeralId] = EphemeralIdentity({
            parentAgentId: parentAgentId,
            ephemeralAddress: ephemeralAddress,
            scopeHash: scopeHash,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            active: true
        });

        emit EphemeralIdentityCreated(parentAgentId, ephemeralId);
    }

    /// @notice Deactivate an ephemeral identity
    function deactivateEphemeralIdentity(bytes32 ephemeralId) external {
        EphemeralIdentity storage eph = ephemeralIdentities[ephemeralId];
        if (eph.parentAgentId == bytes32(0)) revert EphemeralNotFound();

        ISoulRegistry.SoulIdentity memory soul = soulRegistry.getSoul(eph.parentAgentId);
        if (soul.owner != msg.sender) revert NotOwner();

        eph.active = false;
        emit EphemeralIdentityDeactivated(ephemeralId);
    }

    // -----------------------------------------------------------------------
    //  Agent Lineage
    // -----------------------------------------------------------------------

    /// @notice Record agent lineage (fork relationship)
    function recordLineage(
        bytes32 agentId,
        bytes32 parentAgentId,
        uint64  forkHeight,
        uint8   generation
    ) external onlySoulOwner(agentId) {
        agentLineage[agentId] = Lineage({
            parentAgentId: parentAgentId,
            forkHeight: forkHeight,
            generation: generation
        });
        emit LineageRecorded(agentId, parentAgentId, generation);
    }

    // -----------------------------------------------------------------------
    //  Verifiable Credential Anchoring
    // -----------------------------------------------------------------------

    /// @notice Anchor a verifiable credential hash on-chain
    function anchorCredential(
        bytes32 credentialHash,
        bytes32 issuerAgentId,
        bytes32 subjectAgentId,
        bytes32 credentialCid,
        uint64  expiresAt,
        bytes calldata sig
    ) external onlySoulOwner(issuerAgentId) {
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (expiresAt <= uint64(block.timestamp)) revert InvalidExpiry();

        uint64 nonce = nonces[issuerAgentId];
        bytes32 structHash = keccak256(
            abi.encode(ANCHOR_CREDENTIAL_TYPEHASH, credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, nonce)
        );
        _verifySig(structHash, sig, msg.sender);
        nonces[issuerAgentId] = nonce + 1;

        bytes32 credentialId = keccak256(
            abi.encode(credentialHash, issuerAgentId, nonce)
        );

        credentials[credentialId] = CredentialAnchor({
            credentialHash: credentialHash,
            issuerAgentId: issuerAgentId,
            subjectAgentId: subjectAgentId,
            credentialCid: credentialCid,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            revoked: false
        });

        emit CredentialAnchored(credentialId, issuerAgentId, subjectAgentId);
    }

    /// @notice Revoke a credential
    function revokeCredential(bytes32 credentialId) external {
        CredentialAnchor storage c = credentials[credentialId];
        if (c.issuerAgentId == bytes32(0)) revert CredentialNotFound();
        if (c.revoked) revert CredentialAlreadyRevoked();

        ISoulRegistry.SoulIdentity memory soul = soulRegistry.getSoul(c.issuerAgentId);
        if (soul.owner != msg.sender) revert NotOwner();

        c.revoked = true;
        emit CredentialRevoked(credentialId);
    }

    // -----------------------------------------------------------------------
    //  Internal: EIP-712 signature verification
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

        address recovered = ecrecover(hash, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
