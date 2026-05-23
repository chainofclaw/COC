// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollupStateManager} from "../rollup/RollupStateManager.sol";

/// @dev Test-only subclass exposing post-deploy mutation of `PROPOSER_BOND`.
///      On the production contract the bond parameters are storage variables
///      documented as "mutable across upgrades" but have no setter — they can
///      only change via a UUPS upgrade. This subclass simulates such a change
///      so #717 (refund/slash must use the bond actually escrowed, not the
///      live global) can be regression-tested without performing a full
///      proxy upgrade in the test harness.
contract RollupStateManagerBondConfigurable is RollupStateManager {
    function setProposerBondForTest(uint256 newBond) external {
        PROPOSER_BOND = newBond;
    }
}
