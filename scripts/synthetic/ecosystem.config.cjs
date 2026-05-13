// PM2 config for COC production synthetic + active health loops.
//
// Two processes:
//   coc-synthetic   — passive HTTP/RPC invariants, 60s interval (fast MTTD)
//   coc-health-loop — active txs + auto-remediation, 30 min interval
//
// Deploy:  pm2 startOrReload scripts/synthetic/ecosystem.config.cjs && pm2 save
// Logs:    pm2 logs coc-synthetic   /   pm2 logs coc-health-loop
module.exports = {
  apps: [
    {
      name: 'coc-synthetic',
      script: 'check-prod.mjs',
      cwd: __dirname,
      args: '--watch --json /var/log/coc-synthetic/last.json',
      autorestart: true,
      max_restarts: 50,
      max_memory_restart: '256M',
      env: {
        COC_CHAIN_ID: '88780',
        COC_RPC_URL: 'https://clawchain.io/api/testnet/rpc',
        COC_WS_URL: 'wss://clawchain.io/api/testnet/ws',
        COC_FAUCET_URL: 'https://faucet.clawchain.io',
        COC_FAUCET_ADDRESS: '0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF',
        COC_FAUCET_MIN_BALANCE: '100',
        COC_WEBSITE_URL: 'https://clawchain.io',
        COC_EXPLORER_URL: 'https://explorer.clawchain.io',
        COC_IPFS_URL: 'https://ipfs.clawchain.io',
        COC_BLOCK_FRESHNESS_SEC: '60',
        CHECK_INTERVAL_SEC: '60',
      },
    },
    {
      name: 'coc-health-loop',
      script: 'health-loop.mjs',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      max_memory_restart: '512M',
      env: {
        // Active probe knobs — use loopback on prod to avoid hairpin-NAT cold-start
        PROBE_RPC: 'http://127.0.0.1:28780',
        PROBE_CHAIN_ID: '88780',
        PROBE_PK: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // Hardhat #5, prefunded 1000 COC
        PROBE_TX_TIMEOUT_MS: '30000',
        // Remediation knobs
        DEPLOYER_PK: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // Hardhat #0, ~10M COC
        FAUCET_ADDR: '0x47f9940cCf9777C0407F094A1B0d8c50b0DD01BF',
        FAUCET_MIN_COC: '1000',
        FAUCET_REFUND_COC: '50000',
        BLOCK_FRESHNESS_LIMIT_SEC: '300',
        SSH_KEY: '/root/.ssh/coc-automation',
        REMEDIATE_STATE: '/var/lib/coc-synthetic/state.json',
        // Loop cadence
        HEALTH_LOOP_INTERVAL_SEC: '1800', // 30 min
        HEALTH_STRESS_EVERY: '4',  // run stress probe every 4 ticks (~2 hours)
        STRESS_N: '32',
        STRESS_MODE: 'mixed',
        HEALTH_REPORT_DIR: '/var/log/coc-synthetic',
      },
    },
  ],
}
