#!/usr/bin/env bash
# Generate genesis configuration + per-node config files for COC testnet
# Usage: bash scripts/generate-genesis.sh [validators_count] [output_dir]
#
# Environment variables:
#   COC_CHAIN_ID    - chain ID (default: 18780)
#   COC_BOOT_HOST   - single host for all nodes (bare-metal mode)
#   COC_DOCKER=1    - Docker mode: each node same ports, hostname=node-N
#
# Outputs:
#   genesis.json          - shared chain parameters
#   special-accounts.json - faucet & deployer keys (mode 0600)
#   node-config-N.json    - per-validator node config
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALIDATORS="${1:-3}"
OUT_DIR="${2:-${ROOT}/configs/prowl-testnet}"
CHAIN_ID="${COC_CHAIN_ID:-18780}"
BOOT_HOST="${COC_BOOT_HOST:-}"
DOCKER_MODE="${COC_DOCKER:-0}"

mkdir -p "$OUT_DIR"

# Generate validator keys if not already present
VALIDATORS_FILE="${OUT_DIR}/validators.json"
if [[ ! -f "$VALIDATORS_FILE" ]]; then
  echo "Generating validator keys first..."
  bash "${ROOT}/scripts/generate-validator-keys.sh" "$VALIDATORS" "$OUT_DIR"
fi

echo "Generating genesis and per-node configs..."

node --experimental-strip-types -e "
import { readFile, writeFile } from 'node:fs/promises';
import { Wallet } from 'ethers';

const outDir = '${OUT_DIR}';
const chainId = ${CHAIN_ID};
const bootHost = '${BOOT_HOST}';
const dockerMode = '${DOCKER_MODE}' === '1';
const validatorsRaw = await readFile(outDir + '/validators.json', 'utf-8');
const validators = JSON.parse(validatorsRaw);
const count = validators.length;

// Read private keys for per-node configs
let privateKeys = [];
try {
  const raw = await readFile(outDir + '/validators-private.json', 'utf-8');
  privateKeys = JSON.parse(raw);
} catch {
  // Fall back: read from .env files
  for (let i = 1; i <= count; i++) {
    try {
      const env = await readFile(outDir + '/validator-' + i + '.env', 'utf-8');
      const match = env.match(/COC_NODE_KEY=(.+)/);
      if (match) privateKeys.push({ index: i, address: validators[i-1], privateKey: match[1].trim() });
    } catch {}
  }
}

// Generate faucet and deployer accounts
const faucetWallet = Wallet.createRandom();
const deployerWallet = Wallet.createRandom();

// Genesis: shared chain parameters
const genesis = {
  chainId,
  chainName: 'COC Prowl Testnet',
  blockTimeMs: 3000,
  syncIntervalMs: 5000,
  finalityDepth: 3,
  maxTxPerBlock: 100,
  minGasPriceWei: '1',
  validators,
  prefund: [
    { address: faucetWallet.address, balanceEth: '1000000' },
    { address: deployerWallet.address, balanceEth: '100000' },
    { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', balanceEth: '10000' },
  ],
  enableBft: true,
  enableWireProtocol: true,
  enableDht: true,
  enableSnapSync: true,
  poseEpochMs: 3600000,
  p2pInboundAuthMode: 'enforce',
  poseInboundAuthMode: 'enforce',
};

await writeFile(outDir + '/genesis.json', JSON.stringify(genesis, null, 2) + '\n');

// Save faucet/deployer keys (private)
const specialAccounts = {
  faucet: { address: faucetWallet.address, privateKey: faucetWallet.privateKey },
  deployer: { address: deployerWallet.address, privateKey: deployerWallet.privateKey },
};
await writeFile(outDir + '/special-accounts.json', JSON.stringify(specialAccounts, null, 2) + '\n', { mode: 0o600 });

// Base ports
const BASE_RPC = 18780;
const BASE_WS  = 18781;
const BASE_P2P = 19780;
const BASE_WIRE = 19781;
const BASE_IPFS = 5001;
const BASE_METRICS = 9100;

// Docker mode: all nodes use same internal ports, hostname = node-N
// Bare-metal mode: ports offset by index, bootHost = single host IP
for (let i = 0; i < count; i++) {
  const idx = i + 1;
  const nodeId = validators[i];
  const portOffset = dockerMode ? 0 : i;

  // Peers: all validators except self
  const peers = validators
    .filter((_, j) => j !== i)
    .map(addr => {
      const j = validators.indexOf(addr);
      const peerOffset = dockerMode ? 0 : j;
      const host = bootHost || ('node-' + (j + 1));
      return { id: addr, url: 'http://' + host + ':' + (BASE_P2P + peerOffset) };
    });

  // DHT bootstrap peers
  const dhtPeers = validators
    .filter((_, j) => j !== i)
    .map(addr => {
      const j = validators.indexOf(addr);
      const peerOffset = dockerMode ? 0 : j;
      const host = bootHost || ('node-' + (j + 1));
      return { id: addr, address: host, port: BASE_WIRE + peerOffset };
    });

  const nodeConfig = {
    nodeId,
    chainId,
    rpcBind: '0.0.0.0',
    rpcPort: BASE_RPC + portOffset,
    p2pBind: '0.0.0.0',
    p2pPort: BASE_P2P + portOffset,
    wsBind: '0.0.0.0',
    wsPort: BASE_WS + portOffset,
    ipfsBind: '0.0.0.0',
    wireBind: '0.0.0.0',
    wirePort: BASE_WIRE + portOffset,
    validators,
    peers,
    prefund: genesis.prefund,
    enableBft: true,
    enableWireProtocol: true,
    enableDht: true,
    enableSnapSync: true,
    blockTimeMs: genesis.blockTimeMs,
    finalityDepth: genesis.finalityDepth,
    maxTxPerBlock: genesis.maxTxPerBlock,
    dhtBootstrapPeers: dhtPeers,
    p2pInboundAuthMode: 'enforce',
    poseInboundAuthMode: 'enforce',
  };

  await writeFile(
    outDir + '/node-config-' + idx + '.json',
    JSON.stringify(nodeConfig, null, 2) + '\n'
  );
  console.log('  node-config-' + idx + '.json  (nodeId: ' + nodeId.slice(0,10) + '...)');
}

console.log('');
console.log('Genesis:    ' + outDir + '/genesis.json');
console.log('Faucet:     ' + faucetWallet.address);
console.log('Deployer:   ' + deployerWallet.address);
console.log('Keys:       ' + outDir + '/special-accounts.json');
console.log('Node count: ' + count);
"

echo "Done."
