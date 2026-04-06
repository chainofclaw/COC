// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CidRegistry
 * @notice Maps keccak256(CID) → original IPFS CID string.
 *         Deployed as a standalone companion to SoulRegistry so that
 *         off-chain recovery can resolve bytes32 backup anchors back to
 *         actual IPFS CIDs without maintaining an external indexer.
 *
 *         Registration is permissionless: anyone who knows the CID can
 *         register the mapping (the hash preimage proves knowledge).
 *         Once written, entries are immutable — CIDs are content-addressed,
 *         so a given hash always maps to the same string.
 */
contract CidRegistry {
    // ── Storage ──────────────────────────────────────────────────────────

    /// @dev cidHash → original CID string (empty string means not registered)
    mapping(bytes32 => string) private _cidMap;

    // ── Events ───────────────────────────────────────────────────────────

    event CidRegistered(bytes32 indexed cidHash, string cid, address indexed registrant);

    // ── Errors ───────────────────────────────────────────────────────────

    error HashMismatch(bytes32 expected, bytes32 actual);
    error AlreadyRegistered(bytes32 cidHash);
    error EmptyCid();

    // ── External functions ───────────────────────────────────────────────

    /**
     * @notice Register a CID mapping.  The caller must provide the original
     *         CID string whose keccak256 equals `cidHash`.
     * @param cidHash  keccak256(abi.encodePacked(cid))
     * @param cid      The original IPFS CID string (e.g. "QmYw...")
     */
    function registerCid(bytes32 cidHash, string calldata cid) external {
        if (bytes(cid).length == 0) revert EmptyCid();

        bytes32 computed = keccak256(abi.encodePacked(cid));
        if (computed != cidHash) revert HashMismatch(cidHash, computed);

        // Immutable: once set, cannot be overwritten
        if (bytes(_cidMap[cidHash]).length != 0) revert AlreadyRegistered(cidHash);

        _cidMap[cidHash] = cid;
        emit CidRegistered(cidHash, cid, msg.sender);
    }

    /**
     * @notice Batch-register multiple CID mappings in one transaction.
     * @param cidHashes  Array of keccak256 hashes
     * @param cids       Corresponding original CID strings
     */
    function registerCidBatch(
        bytes32[] calldata cidHashes,
        string[] calldata cids
    ) external {
        require(cidHashes.length == cids.length, "Length mismatch");
        for (uint256 i = 0; i < cidHashes.length; i++) {
            if (bytes(cids[i]).length == 0) revert EmptyCid();

            bytes32 computed = keccak256(abi.encodePacked(cids[i]));
            if (computed != cidHashes[i]) revert HashMismatch(cidHashes[i], computed);

            if (bytes(_cidMap[cidHashes[i]]).length != 0) continue; // skip duplicates silently in batch
            _cidMap[cidHashes[i]] = cids[i];
            emit CidRegistered(cidHashes[i], cids[i], msg.sender);
        }
    }

    // ── View functions ───────────────────────────────────────────────────

    /**
     * @notice Resolve a CID hash back to the original CID string.
     * @param cidHash  The keccak256 hash to look up
     * @return cid     The original CID string, or empty string if not registered
     */
    function resolveCid(bytes32 cidHash) external view returns (string memory cid) {
        return _cidMap[cidHash];
    }

    /**
     * @notice Check whether a CID hash has been registered.
     */
    function isRegistered(bytes32 cidHash) external view returns (bool) {
        return bytes(_cidMap[cidHash]).length != 0;
    }
}
