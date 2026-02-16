#!/usr/bin/env bash
# Generate genesis configuration for COC testnet
# Usage: bash scripts/generate-genesis.sh [validators_count] [output_dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALIDATORS="${1:-10}"
OUT_DIR="${2:-${ROOT}/configs/prowl-testnet}"

mkdir -p "$OUT_DIR"

# Generate validator keys if not already present
VALIDATORS_FILE="${OUT_DIR}/validators.json"
if [[ ! -f "$VALIDATORS_FILE" ]]; then
  echo "Generating validator keys first..."
  bash "${ROOT}/scripts/generate-validator-keys.sh" "$VALIDATORS" "$OUT_DIR"
fi

echo "Generating genesis configuration..."

node --experimental-strip-types -e "
import { readFile, writeFile } from 'node:fs/promises';
import { Wallet } from 'ethers';

const outDir = '${OUT_DIR}';
const validatorsRaw = await readFile(outDir + '/validators.json', 'utf-8');
const validators = JSON.parse(validatorsRaw);

// Generate faucet and deployer accounts
const faucetWallet = Wallet.createRandom();
const deployerWallet = Wallet.createRandom();

const genesis = {
  chainId: 18780,
  chainName: 'COC Prowl Testnet',
  blockTimeMs: 3000,
  syncIntervalMs: 5000,
  validators,
  prefund: [
    { address: faucetWallet.address, balanceEth: '1000000' },
    { address: deployerWallet.address, balanceEth: '100000' },
    // Hardhat test account for developer convenience
    { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', balanceEth: '10000' },
  ],
  enableBft: true,
  enableWireProtocol: true,
  enableDht: true,
  enableSnapSync: true,
  finalityDepth: 3,
  maxTxPerBlock: 100,
  minGasPriceWei: '1',
  poseEpochMs: 3600000,
  p2pInboundAuthMode: 'enforce',
  poseInboundAuthMode: 'enforce',
};

await writeFile(outDir + '/genesis.json', JSON.stringify(genesis, null, 2) + '\n');

// Save faucet and deployer keys
const specialAccounts = {
  faucet: {
    address: faucetWallet.address,
    privateKey: faucetWallet.privateKey,
  },
  deployer: {
    address: deployerWallet.address,
    privateKey: deployerWallet.privateKey,
  },
};
await writeFile(outDir + '/special-accounts.json', JSON.stringify(specialAccounts, null, 2) + '\n', { mode: 0o600 });

console.log('Genesis configuration written to ' + outDir + '/genesis.json');
console.log('Faucet address: ' + faucetWallet.address);
console.log('Deployer address: ' + deployerWallet.address);
console.log('Special account keys in ' + outDir + '/special-accounts.json');
"

echo "Done."
