/**
 * COC Testnet TPS Benchmark
 *
 * Measures actual on-chain TPS by:
 *   1. Funding sender wallets
 *   2. Sending N transactions concurrently
 *   3. Polling block heights to count mined tx
 *   4. Reporting actual TPS, gas, latency
 *
 * Usage: node --experimental-strip-types scripts/testnet-tps.ts [rpc_url]
 */
import { ethers } from "ethers"

const RPC = process.argv[2] || "http://199.192.16.79:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const NUM_SENDERS = 8
const FUND_EACH = ethers.parseEther("50")

const provider = new ethers.JsonRpcProvider(RPC)
const deployer = new ethers.Wallet(DEPLOYER_KEY, provider)

interface BenchResult {
  name: string
  sent: number
  confirmed: number
  elapsed: number
  tps: number
  avgGas?: string
  errors: number
}

const RESULTS: BenchResult[] = []

function report(r: BenchResult) {
  RESULTS.push(r)
  const tpsStr = r.tps.toFixed(2)
  console.log(`  ${r.confirmed === r.sent ? "PASS" : "PARTIAL"} ${r.name}: ${r.confirmed}/${r.sent} confirmed, ${r.elapsed}ms, TPS=${tpsStr}${r.errors > 0 ? `, errors=${r.errors}` : ""}`)
}

async function waitForTx(hash: string, timeoutMs = 60000): Promise<ethers.TransactionReceipt | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await provider.getTransactionReceipt(hash)
      if (receipt) return receipt
    } catch {}
    await new Promise(r => setTimeout(r, 2000)) // 2s polling to avoid rate limits
  }
  return null
}

async function waitForHeight(target: number, timeoutMs = 120000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await provider.getBlockNumber()
      if (h >= target) return h
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  return await provider.getBlockNumber()
}

async function fundSenders(senders: ethers.Wallet[]): Promise<void> {
  console.log(`  Funding ${senders.length} senders with ${ethers.formatEther(FUND_EACH)} ETH each...`)
  let nonce = await provider.getTransactionCount(deployer.address)
  let funded = 0
  for (const s of senders) {
    const tx = await deployer.sendTransaction({
      to: s.address,
      value: FUND_EACH,
      nonce: nonce++,
    })
    const receipt = await waitForTx(tx.hash, 30000)
    if (receipt) funded++
  }
  console.log(`  ${funded}/${senders.length} funded`)
}

async function benchETHTransfers(senders: ethers.Wallet[], count: number): Promise<void> {
  console.log(`\n── Bench: ${count} ETH transfers (${senders.length} senders) ──`)

  // Get nonces
  const nonces = await Promise.all(senders.map(s => provider.getTransactionCount(s.address, "pending")))

  const startHeight = await provider.getBlockNumber()
  const startTime = Date.now()
  const hashes: string[] = []
  let errors = 0

  // Send all transactions as fast as possible
  const promises: Promise<void>[] = []
  for (let i = 0; i < count; i++) {
    const sIdx = i % senders.length
    const sender = senders[sIdx]
    const receiver = senders[(sIdx + 1) % senders.length]
    const nonce = nonces[sIdx]++
    promises.push(
      sender.sendTransaction({
        to: receiver.address,
        value: ethers.parseEther("0.001"),
        nonce,
      })
        .then(tx => { hashes.push(tx.hash) })
        .catch(() => { errors++ })
    )
  }
  await Promise.all(promises)
  const sendTime = Date.now() - startTime
  console.log(`  Sent ${hashes.length} txs in ${sendTime}ms (errors: ${errors})`)

  // Wait for blocks to advance enough to include all txs (assume ~3s/block, ~100 tx/block)
  const blocksNeeded = Math.ceil(hashes.length / 50) + 2
  console.log(`  Waiting for ~${blocksNeeded} blocks to mine all txs...`)
  const targetHeight = startHeight + blocksNeeded
  await waitForHeight(targetHeight, 120000)

  // Batch check receipts (with throttled polling)
  let confirmed = 0
  let totalGas = 0n
  for (let i = 0; i < hashes.length; i += 10) {
    const batch = hashes.slice(i, i + 10)
    const receipts = await Promise.all(batch.map(h => provider.getTransactionReceipt(h).catch(() => null)))
    for (const r of receipts) {
      if (r && r.status === 1) {
        confirmed++
        totalGas += r.gasUsed
      }
    }
    if (i + 10 < hashes.length) await new Promise(r => setTimeout(r, 200)) // throttle
  }

  const endHeight = await provider.getBlockNumber()
  const elapsed = Date.now() - startTime
  const tps = (confirmed / elapsed) * 1000
  const avgGas = confirmed > 0 ? (totalGas / BigInt(confirmed)).toString() : "N/A"

  report({ name: `${count}x ETH transfer`, sent: count, confirmed, elapsed, tps, avgGas, errors })
  console.log(`  Blocks: ${startHeight} → ${endHeight} (${endHeight - startHeight} blocks)`)
}

async function benchERC20(senders: ethers.Wallet[], count: number): Promise<void> {
  console.log(`\n── Bench: ERC-20 deploy + ${count} transfers ──`)

  // Deploy ERC20
  const abi = [
    "constructor(uint256 initialSupply)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ]
  const bytecode = await (await import("node:fs/promises")).readFile(
    new URL("../contracts/artifacts/contracts-src/test-contracts/ERC20Mock.sol/ERC20Mock.json", import.meta.url), "utf-8"
  ).then(raw => JSON.parse(raw).bytecode)

  const factory = new ethers.ContractFactory(abi, bytecode, deployer)
  console.log(`  Deploying ERC20Mock...`)
  const deployStart = Date.now()
  const contract = await factory.deploy(ethers.parseEther("100000000"))
  const deployReceipt = await waitForTx(contract.deploymentTransaction()!.hash, 60000)
  const deployTime = Date.now() - deployStart
  console.log(`  Deployed in ${deployTime}ms, gas=${deployReceipt?.gasUsed}`)

  const tokenAddr = await contract.getAddress()
  const token = new ethers.Contract(tokenAddr, abi, deployer)

  // Distribute tokens to senders
  const distNonce = await provider.getTransactionCount(deployer.address, "pending")
  for (let i = 0; i < senders.length; i++) {
    const tx = await token.transfer(senders[i].address, ethers.parseEther("100000"), { nonce: distNonce + i })
    await waitForTx(tx.hash, 30000)
  }
  console.log(`  Distributed tokens to ${senders.length} senders`)

  // Benchmark transfers
  const nonces = await Promise.all(senders.map(s => provider.getTransactionCount(s.address, "pending")))
  const startTime = Date.now()
  const hashes: string[] = []
  let errors = 0

  const iface = new ethers.Interface(abi)

  for (let i = 0; i < count; i++) {
    const sIdx = i % senders.length
    const sender = senders[sIdx]
    const receiver = senders[(sIdx + 1) % senders.length]
    const nonce = nonces[sIdx]++
    const data = iface.encodeFunctionData("transfer", [receiver.address, ethers.parseEther("1")])

    sender.sendTransaction({
      to: tokenAddr,
      data,
      nonce,
      gasLimit: 60000,
    })
      .then(tx => { hashes.push(tx.hash) })
      .catch(() => { errors++ })
  }

  // Wait a bit for all sends to complete
  await new Promise(r => setTimeout(r, 3000))

  console.log(`  Sent ${hashes.length} txs (errors: ${errors}), waiting for blocks...`)
  const startHeight = await provider.getBlockNumber()
  await waitForHeight(startHeight + Math.ceil(hashes.length / 50) + 2, 120000)

  let confirmed = 0
  let totalGas = 0n
  for (let i = 0; i < hashes.length; i += 10) {
    const batch = hashes.slice(i, i + 10)
    const receipts = await Promise.all(batch.map(h => provider.getTransactionReceipt(h).catch(() => null)))
    for (const r of receipts) {
      if (r && r.status === 1) { confirmed++; totalGas += r.gasUsed }
    }
    if (i + 10 < hashes.length) await new Promise(r => setTimeout(r, 200))
  }

  const elapsed = Date.now() - startTime
  const tps = (confirmed / elapsed) * 1000
  const avgGas = confirmed > 0 ? (totalGas / BigInt(confirmed)).toString() : "N/A"

  report({ name: `${count}x ERC20 transfer`, sent: count, confirmed, elapsed, tps, avgGas, errors })
}

async function benchContractDeploy(count: number): Promise<void> {
  console.log(`\n── Bench: ${count} contract deployments ──`)

  const bytecode = await (await import("node:fs/promises")).readFile(
    new URL("../contracts/artifacts/contracts-src/test-contracts/ERC20Mock.sol/ERC20Mock.json", import.meta.url), "utf-8"
  ).then(raw => JSON.parse(raw).bytecode)

  const abi = ["constructor(uint256 initialSupply)"]
  const factory = new ethers.ContractFactory(abi, bytecode, deployer)

  const nonce = await provider.getTransactionCount(deployer.address, "pending")
  const startTime = Date.now()
  const hashes: string[] = []
  let errors = 0

  for (let i = 0; i < count; i++) {
    try {
      const tx = await factory.getDeployTransaction(ethers.parseEther("1000"))
      const sent = await deployer.sendTransaction({ ...tx, nonce: nonce + i })
      hashes.push(sent.hash)
    } catch { errors++ }
  }

  console.log(`  Sent ${hashes.length} deploys (errors: ${errors}), waiting for blocks...`)
  const startHeight = await provider.getBlockNumber()
  await waitForHeight(startHeight + Math.ceil(hashes.length / 10) + 2, 120000)

  let confirmed = 0
  let totalGas = 0n
  for (const h of hashes) {
    const r = await provider.getTransactionReceipt(h).catch(() => null)
    if (r && r.status === 1) { confirmed++; totalGas += r.gasUsed }
    await new Promise(r => setTimeout(r, 100))
  }

  const elapsed = Date.now() - startTime
  const tps = (confirmed / elapsed) * 1000
  const avgGas = confirmed > 0 ? (totalGas / BigInt(confirmed)).toString() : "N/A"

  report({ name: `${count}x contract deploy`, sent: count, confirmed, elapsed, tps, avgGas, errors })
}

async function benchHeavyCompute(): Promise<void> {
  console.log(`\n── Bench: HeavyCompute gas consumption ──`)

  const artifact = await (await import("node:fs/promises")).readFile(
    new URL("../contracts/artifacts/contracts-src/test-contracts/HeavyCompute.sol/HeavyCompute.json", import.meta.url), "utf-8"
  ).then(raw => JSON.parse(raw))

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer)
  console.log(`  Deploying HeavyCompute...`)
  const contract = await factory.deploy()
  await waitForTx(contract.deploymentTransaction()!.hash, 60000)
  const heavy = new ethers.Contract(await contract.getAddress(), artifact.abi, deployer)
  console.log(`  Deployed at ${await contract.getAddress()}`)

  const tests = [
    { name: "batchWrite(100)", fn: () => heavy.batchWrite(100) },
    { name: "batchWrite(200)", fn: () => heavy.batchWrite(200) },
    { name: "batchWrite(500)", fn: () => heavy.batchWrite(500) },
    { name: "hashLoop(1000)", fn: () => heavy.hashLoop(1000) },
    { name: "hashLoop(5000)", fn: () => heavy.hashLoop(5000) },
    { name: "combined(100w,1000h)", fn: () => heavy.combinedStress(100, 1000) },
  ]

  for (const t of tests) {
    const start = Date.now()
    try {
      const tx = await t.fn()
      const receipt = await waitForTx(tx.hash, 60000)
      const elapsed = Date.now() - start
      if (receipt) {
        console.log(`  PASS ${t.name}: gas=${receipt.gasUsed}, ${elapsed}ms, block=${receipt.blockNumber}`)
      } else {
        console.log(`  TIMEOUT ${t.name}: tx sent but not confirmed in 60s`)
      }
    } catch (err: any) {
      console.log(`  FAIL ${t.name}: ${err.message?.slice(0, 80)}`)
    }
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════")
  console.log("  COC Testnet TPS Benchmark")
  console.log("══════════════════════════════════════════════════════")
  console.log(`  RPC: ${RPC}`)

  const network = await provider.getNetwork()
  console.log(`  Chain ID: ${network.chainId}`)
  const height = await provider.getBlockNumber()
  console.log(`  Block height: ${height}`)
  const bal = await provider.getBalance(deployer.address)
  console.log(`  Deployer balance: ${ethers.formatEther(bal)} ETH\n`)

  // Create sender wallets
  const senders: ethers.Wallet[] = []
  for (let i = 0; i < NUM_SENDERS; i++) {
    senders.push(ethers.Wallet.createRandom().connect(provider))
  }

  await fundSenders(senders)

  // Run benchmarks
  await benchETHTransfers(senders, 50)
  await benchETHTransfers(senders, 100)
  await benchERC20(senders, 50)
  await benchContractDeploy(10)
  await benchHeavyCompute()

  // Final report
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  TPS Benchmark Report")
  console.log("══════════════════════════════════════════════════════")
  console.log("  " + "Test".padEnd(28) + "Sent".padEnd(8) + "OK".padEnd(8) + "Time(ms)".padEnd(12) + "TPS".padEnd(10) + "Avg Gas")
  console.log("  " + "─".repeat(76))
  for (const r of RESULTS) {
    console.log(
      "  " +
      r.name.padEnd(28) +
      String(r.sent).padEnd(8) +
      String(r.confirmed).padEnd(8) +
      String(r.elapsed).padEnd(12) +
      r.tps.toFixed(2).padEnd(10) +
      (r.avgGas ?? "N/A")
    )
  }
  console.log("══════════════════════════════════════════════════════\n")
}

main().catch(err => { console.error("Fatal:", err); process.exit(1) })
