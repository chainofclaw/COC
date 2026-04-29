// Deployer for ValidatorRegistry (Sprint 3 of Phase F+G).
//
// Usage:
//   node deploy-validator-registry.mjs                          # deploy only
//   node deploy-validator-registry.mjs --bootstrap-anvil-keys   # deploy + register the 3 hardhat keys
//
// The --bootstrap-anvil-keys path stakes 32 ETH from each of the first 3
// canonical anvil/hardhat private keys so the contract is immediately
// usable as a BFT validator source. Off by default — prod deploys should
// run the contract empty and let real operators register.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers"
import { dirname, join } from "node:path"

// ── Config ─────────────────────────────────────────────────────────────

const PEERS = [
  "http://199.192.16.79:28780",
  "http://199.192.16.79:28782",
  "http://199.192.16.79:28784",
]
const TARGET_URL = process.env.COC_RPC_URL || "http://199.192.16.79:28782"
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY
  || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const DEPLOYER_ADDR = new Wallet(DEPLOYER_PK).address

// First 3 anvil/hardhat default keys (also the BFT validator set on testnet).
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
]

const ART = "/home/baominghao/COC/contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json"

// ── Helpers ────────────────────────────────────────────────────────────

async function pollMaxNonce(addr) {
  let max = 0
  for (const url of PEERS) {
    try {
      const p = new JsonRpcProvider(url)
      const n = await p.getTransactionCount(addr, "pending")
      if (n > max) max = n
    } catch {}
  }
  return max
}

async function awaitReceipt(txHash, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const url of PEERS) {
      try {
        const p = new JsonRpcProvider(url)
        const r = await p.getTransactionReceipt(txHash)
        if (r) return { receipt: r, peer: url }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`receipt for ${txHash} not seen on any peer within ${timeoutMs}ms`)
}

async function verifyCodeOnAnyPeer(address) {
  for (const url of PEERS) {
    try {
      const p = new JsonRpcProvider(url)
      const code = await p.getCode(address)
      if (code && code !== "0x") return { peer: url, codeLen: code.length }
    } catch {}
  }
  return null
}

/**
 * Derive (nodeId, pubkey65) from a private key — matches the
 * `keccak256(uncompressedPubkey[1:])` convention the contract enforces.
 */
function nodeIdFor(privateKey) {
  const w = new Wallet(privateKey)
  const pubkey = w.signingKey.publicKey            // 0x04 || X || Y, 65 B
  const xy = "0x" + pubkey.slice(4)                 // strip 0x04 prefix
  const nodeId = keccak256(xy)
  return { wallet: w, pubkey, nodeId, address: getAddress(w.address) }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const bootstrap = args.includes("--bootstrap-anvil-keys")

  console.log(`deployer: ${DEPLOYER_ADDR}`)
  console.log(`target rpc: ${TARGET_URL}`)
  console.log(`bootstrap mode: ${bootstrap ? "ON (will stake 3 anvil keys)" : "OFF (deploy only)"}`)

  if (!existsSync(ART)) {
    throw new Error(
      `artifact missing — run 'cd contracts && npx hardhat compile' first.\n  expected: ${ART}`,
    )
  }

  const provider = new JsonRpcProvider(TARGET_URL)
  const deployer = new Wallet(DEPLOYER_PK, provider)

  // ── Deploy ────────────────────────────────────────────────────────────

  const { abi, bytecode } = JSON.parse(await readFile(ART, "utf-8"))
  const factory = new ContractFactory(abi, bytecode, deployer)

  const nonce = await pollMaxNonce(DEPLOYER_ADDR)
  console.log(`using nonce=${nonce}`)

  const deployTx = await factory.getDeployTransaction()
  deployTx.nonce = nonce
  deployTx.gasLimit = 3_000_000n
  deployTx.gasPrice = 2_000_000_000n // 2 gwei

  console.log("deploying ValidatorRegistry…")
  const sent = await deployer.sendTransaction(deployTx)
  console.log(`tx: ${sent.hash}`)

  const { receipt, peer } = await awaitReceipt(sent.hash)
  if (receipt.status !== 1) throw new Error(`deploy failed status=${receipt.status}`)
  const address = receipt.contractAddress
  console.log(`✓ deployed at ${address} (block ${receipt.blockNumber}, peer ${peer})`)

  const v = await verifyCodeOnAnyPeer(address)
  if (!v) throw new Error(`no bytecode at ${address} on any peer`)
  console.log(`✓ bytecode confirmed (${v.codeLen} chars on ${v.peer})`)

  // ── Optional bootstrap: stake the 3 anvil keys ──────────────────────

  let stakedNodeIds = []
  if (bootstrap) {
    console.log("\nstaking 3 anvil validators…")
    const registry = factory.attach(address).connect(deployer)

    let stakeNonce = nonce + 1 // deployer's next slot
    for (let i = 0; i < ANVIL_KEYS.length; i++) {
      const op = nodeIdFor(ANVIL_KEYS[i])
      console.log(`  [${i}] ${op.address}  nodeId=${op.nodeId}`)

      const opWallet = new Wallet(ANVIL_KEYS[i], provider)
      const opNonce = await pollMaxNonce(op.address)

      const txOp = await registry
        .connect(opWallet)
        .stake(op.nodeId, op.pubkey, {
          value: 32n * 10n ** 18n,
          nonce: opNonce,
          gasLimit: 250_000n,
          gasPrice: 2_000_000_000n,
        })
      console.log(`    stake tx: ${txOp.hash}`)
      const stakeRcpt = await awaitReceipt(txOp.hash)
      if (stakeRcpt.receipt.status !== 1) {
        throw new Error(`stake[${i}] failed: status=${stakeRcpt.receipt.status}`)
      }
      stakedNodeIds.push(op.nodeId)
    }

    // Sanity: read-back active set.
    const active = await registry.getActiveValidators()
    console.log(`✓ active set on-chain: ${active.length} validators`)
    for (const id of active) console.log(`  - ${id}`)
  }

  // ── Persist deploy summary ─────────────────────────────────────────

  const outDir = "/home/baominghao/COC/contracts/artifacts-coc"
  await mkdir(outDir, { recursive: true })
  const out = join(outDir, "validator-registry-deploy.json")
  const summary = {
    network: { rpcUrl: TARGET_URL, chainId: 18780 },
    deployer: DEPLOYER_ADDR,
    deployedAt: new Date().toISOString(),
    validatorRegistry: {
      address,
      txHash: sent.hash,
      block: receipt.blockNumber,
      bootstrap: bootstrap ? { stakedNodeIds } : null,
    },
  }
  await writeFile(out, JSON.stringify(summary, null, 2) + "\n")
  console.log(`✓ summary: ${out}`)

  console.log(`\n── DONE ──\nValidatorRegistry: ${address}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
