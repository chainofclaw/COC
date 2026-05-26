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
      // After the #737/#738/#741 audit batch (dynamic domain separator,
      // receipts cap, operator dedup, etc.) PoSeManagerV2 bytecode hit
      // 24624 B — 48 B past the EIP-170 24576 B ceiling. The default
      // `runs:200` optimizer therefore produced a contract that
      // hardhat-upgrades refuses to deploy ("code is too large"), which
      // broke every test that deploys PoSeManagerV2 via the upgrades
      // plugin (UUPS upgrade-safety suite, v2 E2E lifecycle, #667
      // witness-quorum, #686 ownership transfer).
      //
      // Dropping the optimizer to `runs:1` for PoSeManagerV2 only trims
      // ~hundreds of bytes; runtime gas is a touch higher for V2-internal
      // logic but storage-bound paths (the majority of finalizeEpochV2 /
      // submitBatchV2 cost) are largely unaffected. The rest of the suite
      // keeps `runs:200`.
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
