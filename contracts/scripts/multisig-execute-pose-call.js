/**
 * Generic multisig-executed call to a contract owned by the 88780 3-of-5
 * MultiSigWallet (`0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E`).
 *
 * Mirrors `multisig-execute-security-upgrades.js` but encodes an arbitrary
 * function call instead of `upgradeToAndCall`. Use cases include:
 *   - `setV2SunsetEpoch(uint64)` (#746 PR-5)
 *   - `setV1SunsetEpoch(uint64)` (#748)
 *   - other one-off owner-only calls that aren't proxy upgrades
 *
 * USAGE
 *   COC_RPC_URL=https://clawchain.io/api/testnet/rpc \
 *   COC_CHAIN_ID=88780 \
 *   DEPLOYER_PRIVATE_KEY=0x<...> \
 *   PHASE_B_INPUT=tmp/<your-prepared.json> \
 *   npx hardhat run scripts/multisig-execute-pose-call.js --network coc
 *
 * PHASE_B_INPUT JSON shape (one batch can contain multiple calls):
 *   {
 *     "chainId": 88780,
 *     "multisig": "0x3c055D83...",
 *     "calls": [
 *       {
 *         "name": "setV2SunsetEpoch",
 *         "target": "0x256eb949...",        // contract to call (e.g. PoSeManagerV2 proxy)
 *         "value": "0",                      // wei (string, parsed via BigInt)
 *         "signature": "setV2SunsetEpoch(uint64)",
 *         "args": ["495256"],                // strings; encoded via ethers Interface
 *         "issue": "#746",
 *         "pr": "PR #?",
 *         // Optional: post-call sanity check
 *         "verify": {
 *           "signature": "v2SunsetEpoch() view returns (uint64)",
 *           "expected": "495256"
 *         }
 *       }
 *     ]
 *   }
 */

const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { ethers } = require("hardhat")

const MULTISIG_KEYS_DIR = path.join(os.homedir(), ".coc", "keys", "88780-multisig")
const PREPARED_PATH = process.env.PHASE_B_INPUT
  ? path.resolve(process.env.PHASE_B_INPUT)
  : path.join(__dirname, "..", "tmp", "multisig-call-prepared.json")

const MULTISIG_ABI = [
  "function submitTransaction(address to, uint256 value, bytes calldata data) external returns (uint256)",
  "function confirmTransaction(uint256 txId) external",
  "function executeTransaction(uint256 txId) external",
  "function getTransactionCount() external view returns (uint256)",
  "function transactions(uint256) external view returns (address to, uint256 value, bytes data, bool executed, uint256 confirmCount)",
  "event Submit(uint256 indexed txId, address indexed to, uint256 value)",
]

function loadOwnerWallet(i, provider) {
  const keyPath = path.join(MULTISIG_KEYS_DIR, `owner-${i}.json`)
  const data = JSON.parse(fs.readFileSync(keyPath, "utf8"))
  return new ethers.Wallet(data.privateKey, provider)
}

async function topUpOwner(deployer, owner, target) {
  const bal = await ethers.provider.getBalance(owner.address)
  if (bal >= target) {
    return { funded: false, balance: bal }
  }
  const need = target - bal
  const tx = await deployer.sendTransaction({ to: owner.address, value: need })
  await tx.wait()
  const newBal = await ethers.provider.getBalance(owner.address)
  return { funded: true, sent: need, balance: newBal }
}

function encodeCall(call) {
  const iface = new ethers.Interface([`function ${call.signature}`])
  // function name is the first token before `(`
  const fnName = call.signature.split("(")[0].trim()
  return iface.encodeFunctionData(fnName, call.args)
}

async function verifyAfter(call) {
  if (!call.verify) return
  const iface = new ethers.Interface([`function ${call.verify.signature}`])
  const fnName = call.verify.signature.split("(")[0].trim()
  const data = iface.encodeFunctionData(fnName, [])
  const result = await ethers.provider.call({ to: call.target, data })
  const decoded = iface.decodeFunctionResult(fnName, result)
  const actual = decoded[0].toString()
  if (actual !== String(call.verify.expected)) {
    throw new Error(`verify failed for ${call.name}: got ${actual}, expected ${call.verify.expected}`)
  }
  return actual
}

async function main() {
  const prepared = JSON.parse(fs.readFileSync(PREPARED_PATH, "utf8"))
  if (prepared.chainId !== 88780) throw new Error(`prepared chainId mismatch: ${prepared.chainId}`)

  const network = await ethers.provider.getNetwork()
  if (Number(network.chainId) !== 88780) {
    throw new Error(`network mismatch: connected to chainId=${network.chainId}, expected 88780`)
  }
  console.log(`multisig generic call — executing via ${prepared.multisig}`)
  console.log("")

  const [deployer] = await ethers.getSigners()
  console.log(`deployer: ${deployer.address}`)
  const deployerBal = await ethers.provider.getBalance(deployer.address)
  console.log(`  balance: ${ethers.formatEther(deployerBal)} ETH`)
  console.log("")

  // Load 3 owners + top-up gas (mirrors security-upgrades flow)
  const owners = []
  for (let i = 1; i <= 3; i++) {
    owners.push(loadOwnerWallet(i, ethers.provider))
  }
  const GAS_TARGETS = [ethers.parseEther("0.3"), ethers.parseEther("0.1"), ethers.parseEther("0.1")]
  for (let i = 0; i < 3; i++) {
    const result = await topUpOwner(deployer, owners[i], GAS_TARGETS[i])
    if (result.funded) {
      console.log(`  funded owner-${i + 1} (${owners[i].address}): +${ethers.formatEther(result.sent)} ETH → balance ${ethers.formatEther(result.balance)} ETH`)
    } else {
      console.log(`  owner-${i + 1} (${owners[i].address}) already at ${ethers.formatEther(result.balance)} ETH (no top-up)`)
    }
  }
  console.log("")

  const msigO1 = new ethers.Contract(prepared.multisig, MULTISIG_ABI, owners[0])
  const msigO2 = new ethers.Contract(prepared.multisig, MULTISIG_ABI, owners[1])
  const msigO3 = new ethers.Contract(prepared.multisig, MULTISIG_ABI, owners[2])

  const results = []
  for (const call of prepared.calls) {
    console.log(`[${call.pr || call.issue || "call"}] ${call.name}`)
    console.log(`    target:    ${call.target}`)
    console.log(`    signature: ${call.signature}`)
    console.log(`    args:      [${call.args.join(", ")}]`)
    console.log(`    value:     ${call.value || "0"} wei`)

    const data = encodeCall(call)
    const value = BigInt(call.value || "0")

    // 1. submit
    const submitTx = await msigO1.submitTransaction(call.target, value, data)
    const submitReceipt = await submitTx.wait()
    const submitTopic = ethers.id("Submit(uint256,address,uint256)")
    const submitLog = submitReceipt.logs.find(
      (l) => l.address.toLowerCase() === prepared.multisig.toLowerCase() && l.topics[0] === submitTopic,
    )
    if (!submitLog) throw new Error(`Submit event not found for ${call.name}`)
    const txId = Number(BigInt(submitLog.topics[1]))
    console.log(`    submitted txId=${txId} (tx ${submitTx.hash})`)

    // 2. confirm × 3
    for (let i = 0; i < 3; i++) {
      const msig = [msigO1, msigO2, msigO3][i]
      const ctx = await msig.confirmTransaction(txId)
      await ctx.wait()
      console.log(`      confirmed by owner-${i + 1} (${owners[i].address.slice(0, 10)}…)`)
    }

    // 3. execute
    const execTx = await msigO1.executeTransaction(txId)
    const execReceipt = await execTx.wait()
    if (execReceipt.status !== 1) throw new Error(`execute failed for txId=${txId}`)
    console.log(`    executed (tx ${execTx.hash})`)

    // 4. verify (optional)
    if (call.verify) {
      const actual = await verifyAfter(call)
      console.log(`    ✓ verify: ${call.verify.signature.split("(")[0]} = ${actual} (matches expected ${call.verify.expected})`)
    }

    console.log("")
    results.push({
      ...call,
      txId,
      submitTxHash: submitTx.hash,
      executedTxHash: execTx.hash,
    })
  }

  const out = {
    chainId: 88780,
    multisig: prepared.multisig,
    executedAt: new Date().toISOString(),
    results,
  }
  const outPath = path.join(__dirname, "..", "tmp", "multisig-call-executed.json")
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n")
  console.log(`wrote ${outPath}`)
  console.log("")
  console.log(`All ${results.length} multisig calls complete.`)
  for (const r of results) {
    console.log(`  ${r.pr || r.issue || "call"} ${r.name} → txId=${r.txId}, exec=${r.executedTxHash}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
