#!/usr/bin/env bash
# Generate boot node configuration and DNS seed records for COC testnet
# Usage: bash scripts/setup-boot-nodes.sh [config_dir] [domain]
#
# Outputs:
#   boot-nodes.json     - boot node list with endpoints
#   dns-seed-records.txt - DNS TXT records to publish
#   dht-seeds.json      - DHT bootstrap peer config snippet
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${1:-${ROOT}/configs/prowl-testnet}"
DNS_DOMAIN="${2:-_coc-prowl._tcp.chainofclaw.io}"

if [[ ! -f "${CONFIG_DIR}/validators.json" ]]; then
  echo "Error: ${CONFIG_DIR}/validators.json not found. Run generate-genesis.sh first."
  exit 1
fi

echo "Generating boot node configuration..."

node --experimental-strip-types -e "
import { readFile, writeFile } from 'node:fs/promises';

const configDir = '${CONFIG_DIR}';
const dnsDomain = '${DNS_DOMAIN}';

const validators = JSON.parse(await readFile(configDir + '/validators.json', 'utf-8'));

// Boot nodes: first 3 validators (or all if fewer)
const bootCount = Math.min(validators.length, 3);
const bootNodes = [];
const dnsRecords = [];
const dhtSeeds = [];

for (let i = 0; i < bootCount; i++) {
  const addr = validators[i];
  const idx = i + 1;
  // Placeholder IPs - operator fills in real values
  const ip = 'BOOT_NODE_' + idx + '_IP';
  const p2pPort = 19780 + i;
  const wirePort = 19781 + i;
  const rpcPort = 18780 + i;

  bootNodes.push({
    index: idx,
    nodeId: addr,
    p2pUrl: 'http://' + ip + ':' + p2pPort,
    wireAddress: ip,
    wirePort,
    rpcUrl: 'http://' + ip + ':' + rpcPort,
  });

  // DNS TXT record: coc-peer:<nodeId>:<p2p_url>
  dnsRecords.push(dnsDomain + '  TXT  \"coc-peer:' + addr + ':http://' + ip + ':' + p2pPort + '\"');

  dhtSeeds.push({ id: addr, address: ip, port: wirePort });
}

await writeFile(configDir + '/boot-nodes.json', JSON.stringify(bootNodes, null, 2) + '\n');
await writeFile(configDir + '/dns-seed-records.txt', dnsRecords.join('\n') + '\n');
await writeFile(configDir + '/dht-seeds.json', JSON.stringify(dhtSeeds, null, 2) + '\n');

console.log('Boot nodes (' + bootCount + '):');
bootNodes.forEach(n => console.log('  node-' + n.index + ': ' + n.nodeId.slice(0,10) + '...'));
console.log('');
console.log('Files:');
console.log('  ' + configDir + '/boot-nodes.json      - boot node endpoints');
console.log('  ' + configDir + '/dns-seed-records.txt  - DNS TXT records to publish');
console.log('  ' + configDir + '/dht-seeds.json        - DHT bootstrap peers config');
console.log('');
console.log('Next steps:');
console.log('  1. Replace BOOT_NODE_N_IP with actual server IPs in all files');
console.log('  2. Publish DNS TXT records to ' + dnsDomain);
console.log('  3. Add dnsSeeds to node config: [\"' + dnsDomain + '\"]');
console.log('  4. Copy dht-seeds.json entries to each node\\'s dhtBootstrapPeers config');
"

echo "Done."
