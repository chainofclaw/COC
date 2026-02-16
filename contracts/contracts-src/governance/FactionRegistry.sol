// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FactionRegistry - Maps addresses to Human or Claw factions
/// @notice Faction is immutable once registered to prevent speculative switching
contract FactionRegistry {
    enum Faction { None, Human, Claw }

    struct Identity {
        Faction faction;
        uint64 registeredAt;
        bytes32 attestationHash;
        bool verified;
    }

    address public owner;
    address public verifier;

    mapping(address => Identity) public identities;
    mapping(bytes32 => address) public agentIdToAddress;

    uint256 public humanCount;
    uint256 public clawCount;

    event HumanRegistered(address indexed account, uint64 registeredAt);
    event ClawRegistered(address indexed account, bytes32 indexed agentId, uint64 registeredAt);
    event IdentityVerified(address indexed account, address indexed verifiedBy);
    event VerifierUpdated(address indexed newVerifier);

    error AlreadyRegistered();
    error NotRegistered();
    error AlreadyVerified();
    error NotOwner();
    error NotVerifier();
    error InvalidAgentId();
    error AgentIdTaken();
    error InvalidAttestation();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier && msg.sender != owner) revert NotVerifier();
        _;
    }

    constructor() {
        owner = msg.sender;
        verifier = msg.sender;
    }

    /// @notice Register as Human (called via MetaMask)
    function registerHuman() external {
        if (identities[msg.sender].faction != Faction.None) revert AlreadyRegistered();

        identities[msg.sender] = Identity({
            faction: Faction.Human,
            registeredAt: uint64(block.timestamp),
            attestationHash: bytes32(0),
            verified: false
        });
        humanCount += 1;

        emit HumanRegistered(msg.sender, uint64(block.timestamp));
    }

    /// @notice Register as Claw (called via OpenClaw wallet with agent attestation)
    /// @param agentId Unique identifier of the AI agent
    /// @param attestation Agent runtime signature proving agentId ownership
    function registerClaw(bytes32 agentId, bytes calldata attestation) external {
        if (identities[msg.sender].faction != Faction.None) revert AlreadyRegistered();
        if (agentId == bytes32(0)) revert InvalidAgentId();
        if (agentIdToAddress[agentId] != address(0)) revert AgentIdTaken();
        if (attestation.length < 65) revert InvalidAttestation();

        // Verify attestation: the attestation is a signature of keccak256(agentId, msg.sender)
        bytes32 messageHash = keccak256(abi.encodePacked(agentId, msg.sender));
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        address recovered = _recoverSigner(ethSignedHash, attestation);
        if (recovered != msg.sender) revert InvalidAttestation();

        bytes32 attHash = keccak256(attestation);
        identities[msg.sender] = Identity({
            faction: Faction.Claw,
            registeredAt: uint64(block.timestamp),
            attestationHash: attHash,
            verified: false
        });
        agentIdToAddress[agentId] = msg.sender;
        clawCount += 1;

        emit ClawRegistered(msg.sender, agentId, uint64(block.timestamp));
    }

    /// @notice Off-chain verifier confirms identity (optional second verification)
    function verify(address account) external onlyVerifier {
        Identity storage id = identities[account];
        if (id.faction == Faction.None) revert NotRegistered();
        if (id.verified) revert AlreadyVerified();

        id.verified = true;
        emit IdentityVerified(account, msg.sender);
    }

    function setVerifier(address newVerifier) external onlyOwner {
        verifier = newVerifier;
        emit VerifierUpdated(newVerifier);
    }

    function getFaction(address account) external view returns (Faction) {
        return identities[account].faction;
    }

    function getIdentity(address account) external view returns (Identity memory) {
        return identities[account];
    }

    function isRegistered(address account) external view returns (bool) {
        return identities[account].faction != Faction.None;
    }

    function isVerified(address account) external view returns (bool) {
        return identities[account].verified;
    }

    function _recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
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

        return ecrecover(hash, v, r, s);
    }
}
