#!/usr/bin/env bash
# Generate validator key pairs for COC testnet
# Usage: bash scripts/generate-validator-keys.sh [count] [output_dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COUNT="${1:-10}"
OUT_DIR="${2:-${ROOT}/configs/prowl-testnet}"

mkdir -p "$OUT_DIR"

echo "Generating ${COUNT} validator key pairs..."

# Use a Node.js script to generate keys via ethers.js
node --experimental-strip-types -e "
import { Wallet } from 'ethers';

const count = ${COUNT};
const validators = [];

for (let i = 1; i <= count; i++) {
  const wallet = Wallet.createRandom();
  const nodeId = 'validator-' + i;

  // Base ports for this validator
  const rpcPort = 18780 + (i - 1) * 2;
  const wsPort = rpcPort + 1;
  const p2pPort = 19780 + (i - 1);
  const wirePort = 29781 + (i - 1);
  const ipfsPort = 5001 + (i - 1);
  const metricsPort = 9100 + (i - 1);

  const env = [
    '# COC Prowl Testnet - ' + nodeId,
    'COC_NODE_KEY=' + wallet.privateKey,
    'COC_NODE_ID=' + wallet.address.toLowerCase(),
    'COC_RPC_PORT=' + rpcPort,
    'COC_WS_PORT=' + wsPort,
    'COC_P2P_PORT=' + p2pPort,
    'COC_WIRE_PORT=' + wirePort,
    'COC_IPFS_PORT=' + ipfsPort,
    'COC_METRICS_PORT=' + metricsPort,
    'COC_CHAIN_ID=18780',
    '',
  ].join('\n');

  const envPath = '${OUT_DIR}/validator-' + i + '.env';
  await import('node:fs/promises').then(fs => fs.writeFile(envPath, env, { mode: 0o600 }));

  validators.push({
    index: i,
    address: wallet.address.toLowerCase(),
    nodeId,
  });

  console.log('  validator-' + i + ': ' + wallet.address.toLowerCase());
}

// Write addresses list for genesis
const addressesPath = '${OUT_DIR}/validators.json';
await import('node:fs/promises').then(fs => fs.writeFile(
  addressesPath,
  JSON.stringify(validators.map(v => v.address), null, 2) + '\n'
));

console.log('');
console.log('Generated ' + count + ' validator keys in ${OUT_DIR}');
console.log('Validator addresses written to ' + addressesPath);
"

echo "Done."
