require("@nomicfoundation/hardhat-ethers")
require("@nomicfoundation/hardhat-chai-matchers")
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
    version: "0.8.24",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200
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
