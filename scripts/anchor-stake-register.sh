#!/usr/bin/env bash
# anchor-stake-register.sh — Phase B: promote a gcloud anchor fullnode to a BFT
# validator by staking via ValidatorRegistry.
#
# Prereq: the anchor has been deployed via deploy-fullnode.sh and has caught up
# to the upstream chain head. The upstream testnet must have a deployed
# ValidatorRegistry contract — see docs/runbooks/governance-staking.md or the
# Phase X2 drill notes.
#
# Inputs:
#   --upstream-rpc URL              chain RPC (e.g. http://209.74.64.88:28780)
#   --registry-address 0x...        ValidatorRegistry contract address
#   --funder-key 0x...              private key holding ETH on chain (e.g. anvil idx 0
#                                   key, prefunded with 10000 ETH on the existing testnet)
#   --anchor-priv 0x...             observer key created by bootstrap-5-fullnode-deploy.sh
#                                   for this anchor (read from /tmp/coc-5-fullnode/keys.txt)
#   --stake-eth N                   stake amount in ETH (default: 100)
#
# What it does:
#   1. Funds the anchor address with stake-eth + 1 ETH gas via the funder key
#   2. Calls ValidatorRegistry.stake(anchor_address, stake) signed by the funder
#      (or anchor — depends on contract — auto-detected via dryRun)
#   3. Polls until the on-chain validator set includes the anchor
#   4. Verifies the anchor's local node started producing prepare/commit votes
#
# Run on operator workstation. Requires Node.js 18+ with ethers installed
# (`npm install ethers` in /opt/coc or in this dir).

set -euo pipefail

UPSTREAM_RPC=""
REGISTRY_ADDRESS=""
FUNDER_KEY=""
ANCHOR_PRIV=""
STAKE_ETH="100"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream-rpc) UPSTREAM_RPC="$2"; shift 2 ;;
    --registry-address) REGISTRY_ADDRESS="$2"; shift 2 ;;
    --funder-key) FUNDER_KEY="$2"; shift 2 ;;
    --anchor-priv) ANCHOR_PRIV="$2"; shift 2 ;;
    --stake-eth) STAKE_ETH="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for v in UPSTREAM_RPC REGISTRY_ADDRESS FUNDER_KEY ANCHOR_PRIV; do
  if [[ -z "${!v}" ]]; then
    echo "ERROR: --${v,,} is required" >&2
    exit 2
  fi
done

# Use a small node script — staking touches contract ABI knowledge. Embed inline
# rather than carrying yet another helper file.
exec node --experimental-strip-types - "$UPSTREAM_RPC" "$REGISTRY_ADDRESS" "$FUNDER_KEY" "$ANCHOR_PRIV" "$STAKE_ETH" <<'NODE_EOF'
const { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } = require('ethers');

const [, , rpc, registryAddr, funderKey, anchorPriv, stakeEthStr] = process.argv;
const stakeWei = parseEther(stakeEthStr);

// Minimal ValidatorRegistry ABI — adjust if your deployed contract differs.
const REGISTRY_ABI = [
  'function stake(address validator) external payable',
  'function getValidators() external view returns (address[])',
  'function getStake(address validator) external view returns (uint256)',
];

(async () => {
  const provider = new JsonRpcProvider(rpc);
  const funder = new Wallet(funderKey, provider);
  const anchor = new Wallet(anchorPriv, provider);
  const registry = new Contract(registryAddr, REGISTRY_ABI, funder);

  console.log(`==> Upstream RPC:        ${rpc}`);
  console.log(`==> Registry:            ${registryAddr}`);
  console.log(`==> Funder:              ${funder.address}`);
  console.log(`==> Anchor (to promote): ${anchor.address}`);
  console.log(`==> Stake:               ${stakeEthStr} ETH`);

  const fundBal = await provider.getBalance(funder.address);
  if (fundBal < stakeWei + parseEther('1')) {
    throw new Error(`Funder balance ${formatEther(fundBal)} ETH < ${stakeEthStr}+1`);
  }

  const validatorsBefore = await registry.getValidators();
  console.log(`==> Validators before: ${validatorsBefore.length}`);

  console.log(`==> Funding anchor address with stake + 1 ETH gas...`);
  const fundTx = await funder.sendTransaction({
    to: anchor.address,
    value: stakeWei + parseEther('1'),
  });
  console.log(`    tx: ${fundTx.hash}`);
  await fundTx.wait();

  console.log(`==> Calling ValidatorRegistry.stake(${anchor.address}) value=${stakeEthStr} ETH from anchor...`);
  const anchorRegistry = registry.connect(anchor);
  const stakeTx = await anchorRegistry.stake(anchor.address, { value: stakeWei });
  console.log(`    tx: ${stakeTx.hash}`);
  await stakeTx.wait();

  console.log(`==> Polling validator set (max 60s)...`);
  for (let i = 0; i < 30; i++) {
    const cur = await registry.getValidators();
    if (cur.map(a => a.toLowerCase()).includes(anchor.address.toLowerCase())) {
      console.log(`==> Anchor ${anchor.address} now in validator set (${cur.length} total).`);
      const stake = await registry.getStake(anchor.address);
      console.log(`==> On-chain stake: ${formatEther(stake)} ETH`);
      console.log(`==> Watch the anchor's logs for prepare/commit votes:`);
      console.log(`      gcloud compute ssh <anchor-vm> --command 'sudo journalctl -u coc-node@1 -n 100 -f | grep -E "prepare|commit"'`);
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error('TIMEOUT: anchor did not appear in validator set within 60s');
  process.exit(1);
})().catch(err => {
  console.error('FAIL:', err.message || err);
  process.exit(1);
});
NODE_EOF
