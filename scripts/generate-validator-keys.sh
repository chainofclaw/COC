#!/usr/bin/env bash
# Generate validator key pairs for COC testnet
# Usage: bash scripts/generate-validator-keys.sh [count] [output_dir]
#
# Outputs:
#   validator-N.env    - per-validator private key + config (mode 0600)
#   validators.json    - public addresses only (safe to share)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COUNT="${1:-3}"
OUT_DIR="${2:-${ROOT}/configs/prowl-testnet}"

mkdir -p "$OUT_DIR"

echo "Generating ${COUNT} validator key pairs..."

node --experimental-strip-types -e "
import { writeFile } from 'node:fs/promises';
import { Wallet } from 'ethers';

const count = ${COUNT};
const outDir = '${OUT_DIR}';
const addresses = [];
const fullInfo = [];

for (let i = 1; i <= count; i++) {
  const wallet = Wallet.createRandom();
  const addr = wallet.address.toLowerCase();

  addresses.push(addr);
  fullInfo.push({ index: i, address: addr, privateKey: wallet.privateKey });

  // Per-validator .env (private, mode 0600)
  const env = [
    '# COC Prowl Testnet - validator-' + i,
    'COC_NODE_KEY=' + wallet.privateKey,
    'COC_NODE_ID=' + addr,
    '',
  ].join('\n');

  await writeFile(outDir + '/validator-' + i + '.env', env, { mode: 0o600 });
  console.log('  validator-' + i + ': ' + addr);
}

// Public addresses only (safe to distribute)
await writeFile(outDir + '/validators.json', JSON.stringify(addresses, null, 2) + '\n');

// Full validator info for genesis generation (private, mode 0600)
await writeFile(outDir + '/validators-private.json', JSON.stringify(fullInfo, null, 2) + '\n', { mode: 0o600 });

console.log('');
console.log('Generated ' + count + ' validator key pairs in ' + outDir);
console.log('  validators.json        - public addresses (safe to share)');
console.log('  validators-private.json - includes private keys (DO NOT share)');
console.log('  validator-N.env        - per-node env files (DO NOT share)');
"

echo "Done."
