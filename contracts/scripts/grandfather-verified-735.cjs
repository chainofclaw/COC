#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * grandfather-verified-735.cjs
 *
 * Operational companion to the #735 GovernanceDAO patch (onlyRegistered now
 * requires `isVerified` on FactionRegistry). On any deployment that already
 * has registered-but-unverified accounts (the entire 88780 testnet at the
 * time of the patch), the gate will silently lock everyone out of
 * createProposal/vote until the verifier runs `verify(account)` for each
 * legitimate registrant.
 *
 * What this script does (read-only, no transactions):
 *
 *   1. Loads FactionRegistry address from configs/deployed-contracts-88780.json
 *      (or the env-var network specified by --network / FR_ADDRESS).
 *   2. Replays `HumanRegistered` + `ClawRegistered` events from the deployment
 *      block to head and collects the unique set of registered addresses.
 *   3. For each, calls `isVerified(addr)` to filter the ones that still need
 *      grandfathering.
 *   4. Emits, on stdout, two artefacts:
 *
 *      - `grandfather-verified-735-plan.json` — the address list + per-address
 *        status (already verified vs needs verify), so operators can review
 *        before signing.
 *      - `grandfather-verified-735-multisig.json` — a single MultiSigWallet
 *        proposal for the 88780 multisig (owner of FactionRegistry as of
 *        gen-4), where each entry contains:
 *          { to: <FactionRegistry>, value: 0, data: <calldata for verify(addr)> }
 *        Operators feed each entry through `MultiSigWallet.submitProposal` and
 *        collect the 3-of-5 confirmations as usual. The script does NOT
 *        broadcast anything itself — it produces signable artefacts only.
 *
 * Usage:
 *
 *   # against the default 88780 manifest
 *   node contracts/scripts/grandfather-verified-735.cjs
 *
 *   # against a custom deployment
 *   FR_ADDRESS=0x... RPC_URL=http://... node contracts/scripts/grandfather-verified-735.cjs
 *
 *   # skip addresses already verified (default is to include them as no-ops)
 *   FILTER_ONLY_UNVERIFIED=1 node contracts/scripts/grandfather-verified-735.cjs
 *
 * Safety notes:
 *
 * - Honest open-registration users do not need to re-register; one verify()
 *   per address restores their voting rights.
 * - Suspected sybils can simply be omitted from the multisig batch — the
 *   gate naturally excludes them.
 * - This script never moves funds and never sends a transaction; the worst
 *   it can do is produce a wrong plan that a multisig signer must still
 *   approve manually.
 *
 * Refs: chainofclaw/COC#735.
 */

const path = require("node:path")
const fs = require("node:fs")
const { ethers } = require("ethers")

const MANIFEST_PATH = path.join(
  __dirname,
  "..",
  "..",
  "configs",
  "deployed-contracts-88780.json",
)

const FACTION_REGISTRY_ABI = [
  "event HumanRegistered(address indexed account, uint64 registeredAt)",
  "event ClawRegistered(address indexed account, bytes32 indexed agentId, uint64 registeredAt)",
  "function isVerified(address account) view returns (bool)",
  "function verify(address account)",
]

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found at ${MANIFEST_PATH}`)
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
}

function getEnvOrDefault(name, fallback) {
  const v = process.env[name]
  return v && v.length > 0 ? v : fallback
}

async function main() {
  const manifest = loadManifest()
  const factionRegistryAddress =
    process.env.FR_ADDRESS || manifest.contracts.FactionRegistry
  const multisigAddress = manifest.owner
  const rpcUrl = getEnvOrDefault("RPC_URL", "http://209.74.64.88:38780")
  const fromBlock = parseInt(getEnvOrDefault("FROM_BLOCK", "0"), 10)
  const filterOnlyUnverified = !!process.env.FILTER_ONLY_UNVERIFIED

  console.error(`# FactionRegistry: ${factionRegistryAddress}`)
  console.error(`# Multisig (FR owner): ${multisigAddress}`)
  console.error(`# RPC: ${rpcUrl}`)
  console.error(`# Scanning events from block ${fromBlock}…`)

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const fr = new ethers.Contract(
    factionRegistryAddress,
    FACTION_REGISTRY_ABI,
    provider,
  )

  // Two query passes — Human and Claw register events. Chunk the scan
  // because many 88780-class RPC endpoints cap eth_getLogs at 10k blocks.
  const head = await provider.getBlockNumber()
  const chunkSize = parseInt(getEnvOrDefault("LOG_CHUNK_BLOCKS", "9000"), 10)
  const humanFilter = fr.filters.HumanRegistered()
  const clawFilter = fr.filters.ClawRegistered()
  const humanEvents = []
  const clawEvents = []
  for (let start = fromBlock; start <= head; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, head)
    const [h, c] = await Promise.all([
      fr.queryFilter(humanFilter, start, end),
      fr.queryFilter(clawFilter, start, end),
    ])
    humanEvents.push(...h)
    clawEvents.push(...c)
    if ((start - fromBlock) % (chunkSize * 10) === 0) {
      console.error(`#   scanned ${end - fromBlock + 1}/${head - fromBlock + 1} blocks (human=${humanEvents.length} claw=${clawEvents.length})`)
    }
  }

  const seen = new Map() // address → { faction, registeredAtBlock }
  for (const ev of humanEvents) {
    const addr = ev.args.account.toLowerCase()
    if (!seen.has(addr)) {
      seen.set(addr, { faction: "Human", block: ev.blockNumber })
    }
  }
  for (const ev of clawEvents) {
    const addr = ev.args.account.toLowerCase()
    if (!seen.has(addr)) {
      seen.set(addr, { faction: "Claw", block: ev.blockNumber })
    }
  }

  console.error(`# Found ${seen.size} unique registered addresses.`)

  // Resolve verified state for each, in small batches to avoid RPC flood.
  const addresses = Array.from(seen.keys())
  const plan = []
  const BATCH = 25
  for (let i = 0; i < addresses.length; i += BATCH) {
    const slice = addresses.slice(i, i + BATCH)
    const statuses = await Promise.all(slice.map(a => fr.isVerified(a)))
    for (let j = 0; j < slice.length; j++) {
      const addr = slice[j]
      const meta = seen.get(addr)
      plan.push({
        address: ethers.getAddress(addr),
        faction: meta.faction,
        registeredAtBlock: meta.block,
        alreadyVerified: statuses[j],
      })
    }
  }

  const needsVerify = plan.filter(e => !e.alreadyVerified)
  console.error(
    `# Plan: ${plan.length} total, ${needsVerify.length} need verify(), ${plan.length - needsVerify.length} already verified.`,
  )

  // Persist plan artefact.
  const planArtefact = {
    issue: "https://github.com/chainofclaw/COC/issues/735",
    factionRegistry: ethers.getAddress(factionRegistryAddress),
    multisig: ethers.getAddress(multisigAddress),
    scannedAt: new Date().toISOString(),
    fromBlock,
    totalRegistered: plan.length,
    needingVerify: needsVerify.length,
    alreadyVerified: plan.length - needsVerify.length,
    entries: plan,
  }
  const planPath = path.join(process.cwd(), "grandfather-verified-735-plan.json")
  fs.writeFileSync(planPath, JSON.stringify(planArtefact, null, 2))
  console.error(`# Wrote plan → ${planPath}`)

  // Persist multisig calldata bundle.
  const verifyFragment = fr.interface.getFunction("verify")
  const targetSet = filterOnlyUnverified ? needsVerify : plan
  const calls = targetSet.map(e => ({
    to: ethers.getAddress(factionRegistryAddress),
    value: "0",
    data: fr.interface.encodeFunctionData(verifyFragment, [e.address]),
    description: `FactionRegistry.verify(${e.address}) — ${e.faction}, registered block ${e.registeredAtBlock}`,
  }))
  const multisigArtefact = {
    issue: "https://github.com/chainofclaw/COC/issues/735",
    multisig: ethers.getAddress(multisigAddress),
    factionRegistry: ethers.getAddress(factionRegistryAddress),
    filterOnlyUnverified,
    count: calls.length,
    notes: [
      "Feed each call into MultiSigWallet.submitProposal({to,value,data}) and gather 3/5 confirmations.",
      "Calls are independent — failing one does not block the others.",
      "Re-running this script after partial execution is safe; already-verified entries become no-ops in the gate but verify() itself reverts AlreadyVerified.",
      "Set FILTER_ONLY_UNVERIFIED=1 to exclude already-verified addresses from the bundle (avoids the AlreadyVerified revert).",
    ],
    calls,
  }
  const multisigPath = path.join(
    process.cwd(),
    "grandfather-verified-735-multisig.json",
  )
  fs.writeFileSync(multisigPath, JSON.stringify(multisigArtefact, null, 2))
  console.error(`# Wrote multisig bundle → ${multisigPath}`)

  // Also dump address list to stdout (machine-friendly).
  console.log(JSON.stringify({ plan: planArtefact, multisig: multisigArtefact }, null, 2))
}

main().catch(err => {
  console.error(err.stack || err.message || err)
  process.exit(1)
})
