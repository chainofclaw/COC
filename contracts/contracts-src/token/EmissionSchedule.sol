// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EmissionSchedule
 * @notice Calculates per-epoch mining emission with annual decay.
 *
 * Emission schedule:
 *   Year 0 (epochs 0–8759):    8.0% of MINING_SUPPLY_CAP per year
 *   Year 1 (epochs 8760–17519): 6.0%
 *   Year 2:                     4.0%
 *   Year 3:                     3.0%
 *   Year 4+:                    2.0% (terminal rate)
 *
 * Per-epoch emission = MINING_SUPPLY_CAP × annualRate / EPOCHS_PER_YEAR
 *
 * Hard cap: cumulative emission never exceeds MINING_SUPPLY_CAP (800M COC).
 * Once reached, getEpochEmission() returns 0.
 */
library EmissionSchedule {
    uint256 internal constant MINING_SUPPLY_CAP = 800_000_000 ether;  // 800M COC
    uint256 internal constant EPOCHS_PER_YEAR = 8_760;                 // 365 × 24
    uint256 internal constant BPS = 10_000;

    // Annual emission rates in basis points (of MINING_SUPPLY_CAP)
    uint256 internal constant RATE_YEAR_0 = 800;   // 8.0%
    uint256 internal constant RATE_YEAR_1 = 600;   // 6.0%
    uint256 internal constant RATE_YEAR_2 = 400;   // 4.0%
    uint256 internal constant RATE_YEAR_3 = 300;   // 3.0%
    uint256 internal constant RATE_TERMINAL = 200; // 2.0%

    /**
     * @notice Get the emission amount for a given epoch.
     * @param epochId       The epoch number (0-based from genesis)
     * @param totalMinted   Cumulative tokens already minted via mining
     * @return emission     Tokens to mint this epoch (0 if cap reached)
     */
    function getEpochEmission(
        uint64 epochId,
        uint256 totalMinted
    ) internal pure returns (uint256 emission) {
        if (totalMinted >= MINING_SUPPLY_CAP) {
            return 0;
        }

        uint256 year = uint256(epochId) / EPOCHS_PER_YEAR;
        uint256 rateBps = _annualRate(year);

        // emission = MINING_SUPPLY_CAP × rateBps / BPS / EPOCHS_PER_YEAR
        emission = (MINING_SUPPLY_CAP * rateBps) / (BPS * EPOCHS_PER_YEAR);

        // Clamp to remaining supply
        uint256 remaining = MINING_SUPPLY_CAP - totalMinted;
        if (emission > remaining) {
            emission = remaining;
        }
    }

    /**
     * @notice Get the annual emission rate for a given year.
     * @param year  Year number (0-based)
     * @return rateBps  Rate in basis points
     */
    function _annualRate(uint256 year) private pure returns (uint256) {
        if (year == 0) return RATE_YEAR_0;
        if (year == 1) return RATE_YEAR_1;
        if (year == 2) return RATE_YEAR_2;
        if (year == 3) return RATE_YEAR_3;
        return RATE_TERMINAL;
    }

    /**
     * @notice Calculate cumulative emission up to a given epoch (for verification).
     * @param upToEpoch  Calculate through this epoch (inclusive)
     * @return total     Cumulative emission
     */
    function cumulativeEmission(uint64 upToEpoch) internal pure returns (uint256 total) {
        total = 0;
        uint256 epoch = 0;
        while (epoch <= uint256(upToEpoch) && total < MINING_SUPPLY_CAP) {
            uint256 year = epoch / EPOCHS_PER_YEAR;
            uint256 rateBps = _annualRate(year);
            uint256 perEpoch = (MINING_SUPPLY_CAP * rateBps) / (BPS * EPOCHS_PER_YEAR);

            // How many epochs remain in this year?
            uint256 yearEnd = (year + 1) * EPOCHS_PER_YEAR - 1;
            uint256 batchEnd = yearEnd < uint256(upToEpoch) ? yearEnd : uint256(upToEpoch);
            uint256 count = batchEnd - epoch + 1;

            uint256 batchTotal = perEpoch * count;
            uint256 remaining = MINING_SUPPLY_CAP - total;
            if (batchTotal > remaining) {
                batchTotal = remaining;
            }
            total += batchTotal;
            epoch = batchEnd + 1;
        }
    }

    /**
     * @notice Estimate years until mining supply is exhausted at current rates.
     * @return years  Approximate years
     */
    function estimatedExhaustionYears() internal pure returns (uint256) {
        // Year 0-3 emit: 8+6+4+3 = 21% = 168M
        // Year 4+ emit: 2% = 16M/year
        // Remaining after Y3: 800M - 168M = 632M
        // 632M / 16M = ~39.5 years
        // Total: ~43 years
        return 43;
    }
}
