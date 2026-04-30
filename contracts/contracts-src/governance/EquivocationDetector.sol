// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IValidatorRegistry {
    function slashValidator(bytes32 nodeId, bytes32 reason) external;
}

/**
 * @title EquivocationDetector
 * @notice On-chain BFT equivocation evidence verifier (Phase I3).
 *
 *         A validator equivocates when it signs two different block hashes
 *         at the same (height, phase). Both signed prepare/commit messages
 *         constitute cryptographic proof of misbehaviour. This contract
 *         takes those two signatures, recovers the signer, asserts the
 *         signer is the operator address embedded in nodeId, and triggers
 *         `ValidatorRegistry.slashValidator(nodeId, evidenceHash)`.
 *
 *         BFT canonical message format (must match
 *         node/src/bft-coordinator.ts:bftCanonicalMessage):
 *             "bft:" || phase || ":" || dec(height) || ":" || hex(blockHash)
 *
 *         Signing format: ethers.js `hashMessage(canonical)` — the EIP-191
 *         personal_sign envelope `\x19Ethereum Signed Message:\n<len><msg>`.
 *
 *         The contract is permissionless: anyone can submit valid evidence
 *         and trigger a slash. The submitter does NOT need to be the
 *         offender's peer; they only need access to the two conflicting
 *         signed messages from the gossip network.
 *
 *         Cooldown protects against the same evidence being replayed to
 *         drain a single validator across multiple epochs. After a slash,
 *         the same nodeId cannot be slashed again for SLASH_COOLDOWN_BLOCKS.
 *
 *         Permissions:
 *           - submitEvidence: permissionless
 *           - setSlashCooldown: only owner
 *           - transferOwnership: only owner
 *
 *         Deployment workflow:
 *           1. Deploy this contract pointing at ValidatorRegistry.
 *           2. Call `ValidatorRegistry.setSlasher(detectorAddress)` so the
 *              registry accepts slash calls from this contract.
 *           3. Off-chain bridge (runtime/coc-relayer.ts) submits evidence
 *              when the BFT coordinator detects equivocation.
 */
contract EquivocationDetector {
    // ── Constants ────────────────────────────────────────────────────────

    uint256 public constant DEFAULT_SLASH_COOLDOWN_BLOCKS = 1000;

    // ── Storage ──────────────────────────────────────────────────────────

    IValidatorRegistry public immutable validatorRegistry;
    address public owner;
    uint256 public slashCooldownBlocks;

    /// @dev nodeId → block number of last slash. Cooldown gate.
    mapping(bytes32 => uint256) public lastSlashedAtBlock;

    // ── Events ───────────────────────────────────────────────────────────

    event EquivocationProven(
        bytes32 indexed nodeId,
        address indexed signer,
        uint256 indexed height,
        bytes32 hashA,
        bytes32 hashB,
        bytes32 evidenceHash
    );
    event SlashCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────

    error InvalidPhase();
    error HashesEqual();
    error InvalidSignature();
    error SignersDiffer();
    error SignerNotNodeIdTrailer();
    error CooldownActive(uint256 unlockBlock);
    error OnlyOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address registry) {
        if (registry == address(0)) revert ZeroAddress();
        validatorRegistry = IValidatorRegistry(registry);
        owner = msg.sender;
        slashCooldownBlocks = DEFAULT_SLASH_COOLDOWN_BLOCKS;
    }

    // ── Public ───────────────────────────────────────────────────────────

    /**
     * @notice Submit two conflicting BFT signatures from the same validator
     *         to slash them on-chain. Reverts if the evidence is invalid.
     *
     * @param nodeId  Target validator's nodeId in ValidatorRegistry.
     *                The trailing 20 bytes of nodeId must equal the
     *                ecrecover'd signer address.
     * @param phase   "prepare" or "commit" — which BFT phase the signatures
     *                attest to. Must match for both signatures.
     * @param height  Block height the validator equivocated at.
     * @param hashA   First conflicting block hash.
     * @param sigA    65-byte secp256k1 signature over EIP-191 hash of the
     *                canonical message for `hashA`.
     * @param hashB   Second conflicting block hash (must differ from hashA).
     * @param sigB    Signature for `hashB` from the same signer as `sigA`.
     */
    function submitEvidence(
        bytes32 nodeId,
        string calldata phase,
        uint256 height,
        bytes32 hashA,
        bytes calldata sigA,
        bytes32 hashB,
        bytes calldata sigB
    ) external {
        if (hashA == hashB) revert HashesEqual();
        if (!_validPhase(phase)) revert InvalidPhase();

        bytes32 digestA = _bftDigest(phase, height, hashA);
        bytes32 digestB = _bftDigest(phase, height, hashB);

        address signerA = _recoverSigner(digestA, sigA);
        address signerB = _recoverSigner(digestB, sigB);
        if (signerA == address(0)) revert InvalidSignature();
        if (signerA != signerB) revert SignersDiffer();

        // The signer must be the operator address embedded in nodeId
        // (last 20 bytes; matches ecrecover output convention).
        address expected = address(uint160(uint256(nodeId)));
        if (signerA != expected) revert SignerNotNodeIdTrailer();

        // Cooldown gate
        uint256 unlock = lastSlashedAtBlock[nodeId] + slashCooldownBlocks;
        if (lastSlashedAtBlock[nodeId] != 0 && block.number < unlock) {
            revert CooldownActive(unlock);
        }
        lastSlashedAtBlock[nodeId] = block.number;

        bytes32 evidenceHash = keccak256(
            abi.encodePacked("bftEquivocation", height, hashA, hashB)
        );
        emit EquivocationProven(nodeId, signerA, height, hashA, hashB, evidenceHash);

        validatorRegistry.slashValidator(nodeId, evidenceHash);
    }

    // ── Owner ops ────────────────────────────────────────────────────────

    function setSlashCooldown(uint256 blocks_) external onlyOwner {
        emit SlashCooldownUpdated(slashCooldownBlocks, blocks_);
        slashCooldownBlocks = blocks_;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    function _validPhase(string calldata phase) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(phase));
        return h == keccak256(bytes("prepare")) || h == keccak256(bytes("commit"));
    }

    /// @dev Reproduce node-side `bftCanonicalMessage` + ethers `hashMessage`.
    function _bftDigest(string calldata phase, uint256 height, bytes32 blockHash)
        internal
        pure
        returns (bytes32)
    {
        // Canonical: "bft:<phase>:<height>:<hex blockHash>"
        bytes memory canonical = abi.encodePacked(
            "bft:",
            phase,
            ":",
            _uintToString(height),
            ":",
            _bytes32ToHex(blockHash)
        );
        // EIP-191: "\x19Ethereum Signed Message:\n<canonical.length><canonical>"
        return keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n",
                _uintToString(canonical.length),
                canonical
            )
        );
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignature();
        uint8 v;
        bytes32 r;
        bytes32 s;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // EIP-2: reject malleable s
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (value != 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buf);
    }

    /// @dev Format bytes32 as 0x-prefixed lowercase hex (66 chars).
    function _bytes32ToHex(bytes32 b) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory buf = new bytes(66);
        buf[0] = "0";
        buf[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            buf[2 + i * 2] = alphabet[uint8(b[i] >> 4)];
            buf[3 + i * 2] = alphabet[uint8(b[i] & 0x0f)];
        }
        return string(buf);
    }
}
