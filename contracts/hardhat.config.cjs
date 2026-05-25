require("@nomicfoundation/hardhat-ethers")
require("@nomicfoundation/hardhat-chai-matchers")
require("@openzeppelin/hardhat-upgrades")
require("hardhat-gas-reporter")
require("solidity-coverage")

/** @type import('hardhat/config').HardhatUserConfig */
const cocNetwork = {
  url: process.env.COC_RPC_URL || process.env.PROWL_RPC_URL || "http://127.0.0.1:18780",
  chainId: parseInt(process.env.COC_CHAIN_ID || process.env.PROWL_CHAIN_ID || "18780"),
  accounts: process.env.DEPLOYER_PRIVATE_KEY
    ? [process.env.DEPLOYER_PRIVATE_KEY]
    : [],
}

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 200 }
        }
      }
    ],
    overrides: {
      // 2026-05-26: after the #737/#738/#741 audit batch, PoSeManagerV2
      // bytecode hit 24624 B — 48 B past the EIP-170 24576 B ceiling.
      // Local override to runs:1 trims ~hundreds of bytes; runtime gas
      // is a touch higher for V2-internal logic but storage-bound paths
      // (the majority of finalizeEpochV2 / submitBatchV2 cost) are
      // largely unaffected. Keep the rest of the suite at runs:200.
      "contracts-src/settlement/PoSeManagerV2.sol": {
        version: "0.8.24",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 1 }
        }
      }
    }
  },
  paths: {
    sources: "./contracts-src",
    tests: "test",
    cache: "cache",
    artifacts: "artifacts"
  },
  networks: {
    coc: cocNetwork,
    prowl: cocNetwork,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: "gas-report.txt",
    noColors: true,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY
  }
}
