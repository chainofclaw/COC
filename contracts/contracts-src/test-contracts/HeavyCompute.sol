// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title HeavyCompute
 * @dev High gas consumption contract for EVM performance benchmarking.
 *      Each function exercises a different EVM resource dimension.
 */
contract HeavyCompute {
    mapping(uint256 => uint256) public store;
    uint256 public storeCount;

    event BatchWriteComplete(uint256 count, uint256 gasUsed);
    event HashLoopComplete(uint256 iterations, bytes32 finalHash);

    /// @dev Iterative fibonacci — CPU-intensive loop
    function fibonacci(uint256 n) external pure returns (uint256) {
        if (n <= 1) return n;
        uint256 a = 0;
        uint256 b = 1;
        for (uint256 i = 2; i <= n; i++) {
            uint256 c = a + b;
            a = b;
            b = c;
        }
        return b;
    }

    /// @dev Bubble sort — O(n^2) loop stress test
    function sortArray(uint256[] memory arr) external pure returns (uint256[] memory) {
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            for (uint256 j = 0; j < len - 1 - i; j++) {
                if (arr[j] > arr[j + 1]) {
                    uint256 tmp = arr[j];
                    arr[j] = arr[j + 1];
                    arr[j + 1] = tmp;
                }
            }
        }
        return arr;
    }

    /// @dev Write n storage slots — SSTORE heavy
    function batchWrite(uint256 n) external {
        uint256 startGas = gasleft();
        for (uint256 i = 0; i < n; i++) {
            store[storeCount + i] = i * 7 + block.timestamp;
        }
        storeCount += n;
        emit BatchWriteComplete(n, startGas - gasleft());
    }

    /// @dev Read n storage slots — SLOAD heavy
    function batchRead(uint256 n) external view returns (uint256 sum) {
        uint256 limit = n > storeCount ? storeCount : n;
        for (uint256 i = 0; i < limit; i++) {
            sum += store[i];
        }
    }

    /// @dev Consecutive keccak256 hashes — precompile stress
    function hashLoop(uint256 n) external returns (bytes32 result) {
        result = keccak256(abi.encodePacked(block.timestamp, msg.sender));
        for (uint256 i = 1; i < n; i++) {
            result = keccak256(abi.encodePacked(result, i));
        }
        emit HashLoopComplete(n, result);
    }

    /// @dev Expand memory to specified size (bytes) — MSTORE/MLOAD stress
    function memoryExpand(uint256 sizeBytes) external pure returns (uint256 checksum) {
        uint256 words = (sizeBytes + 31) / 32;
        uint256[] memory data = new uint256[](words);
        for (uint256 i = 0; i < words; i++) {
            data[i] = i;
            checksum += i;
        }
    }

    /// @dev Combined stress: write + hash + read in one tx
    function combinedStress(uint256 writeCount, uint256 hashCount) external returns (uint256 sum, bytes32 hash) {
        // Phase 1: storage writes
        for (uint256 i = 0; i < writeCount; i++) {
            store[storeCount + i] = i;
        }
        storeCount += writeCount;

        // Phase 2: hash loop
        hash = keccak256(abi.encodePacked(block.timestamp));
        for (uint256 i = 1; i < hashCount; i++) {
            hash = keccak256(abi.encodePacked(hash, i));
        }

        // Phase 3: read back
        for (uint256 i = 0; i < writeCount; i++) {
            sum += store[storeCount - writeCount + i];
        }
    }
}
