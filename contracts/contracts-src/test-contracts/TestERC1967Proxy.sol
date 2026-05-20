// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Concrete OZ ERC1967Proxy that the integration-test harness can deploy
/// from raw artifact + bytecode. The standalone tests live outside hardhat's
/// upgrades plugin (they start a real Hardhat node and talk to it via
/// JsonRpcProvider), so they need a concrete proxy contract to compile into
/// `artifacts/`.
contract TestERC1967Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
