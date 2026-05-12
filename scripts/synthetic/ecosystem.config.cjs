// PM2 config for the COC production synthetic E2E check loop.
// Deploy:  pm2 start scripts/synthetic/ecosystem.config.cjs
// Logs:    pm2 logs coc-synthetic
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
        // Override any of these via /etc/coc/synthetic.env or pm2 ecosystem update.
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
  ],
}
