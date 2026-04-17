/**
 * COC Testnet Performance Tests
 *
 * Measures gas consumption and throughput for heavy EVM operations:
 *   - HeavyCompute: fibonacci, sort, batchWrite, hashLoop, memoryExpand
 *   - Throughput: concurrent ETH transfers, ERC-20 transfers, contract deploys
 *
 * Run locally:  npx hardhat test test/testnet-perf.test.cjs
 * Run on testnet: COC_RPC_URL=http://199.192.16.79:28780 \
 *   DEPLOYER_PRIVATE_KEY=0xac09... npx hardhat test test/testnet-perf.test.cjs --network coc
 */
const { expect } = require("chai")
const { ethers } = require("hardhat")

const REPORT = []

function report(name, data) {
  REPORT.push({ name, ...data })
  const gasStr = data.gas ? `gas=${data.gas}` : ""
  const timeStr = data.ms ? `${data.ms}ms` : ""
  const extraStr = data.tps ? `TPS=${data.tps}` : ""
  console.log(`      ${data.ok ? "PASS" : "FAIL"} ${name} ${gasStr} ${timeStr} ${extraStr}`)
}

describe("COC Testnet Performance", function () {
  this.timeout(180_000) // 3 min for heavy operations

  let deployer
  let wallets

  before(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0]

    wallets = []
    for (let i = 0; i < 10; i++) {
      wallets.push(ethers.Wallet.createRandom().connect(ethers.provider))
    }
    // Fund wallets
    for (const w of wallets) {
      await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("5") })).wait()
    }
  })

  after(function () {
    console.log("\n  ═══════════════════════════════════════════════════")
    console.log("  Performance Report")
    console.log("  ═══════════════════════════════════════════════════")
    console.log("  " + "Operation".padEnd(35) + "Gas".padEnd(15) + "Time(ms)".padEnd(12) + "Status")
    console.log("  " + "─".repeat(70))
    for (const r of REPORT) {
      const gas = r.gas ? String(r.gas).padEnd(15) : "N/A".padEnd(15)
      const ms = r.ms ? String(r.ms).padEnd(12) : "N/A".padEnd(12)
      const status = r.ok ? "PASS" : "FAIL"
      const extra = r.tps ? ` (${r.tps} TPS)` : ""
      console.log("  " + r.name.padEnd(35) + gas + ms + status + extra)
    }
    console.log("  ═══════════════════════════════════════════════════\n")
  })

  // ─── 1. HeavyCompute Gas Benchmarks ───

  describe("1. HeavyCompute Gas Benchmarks", function () {
    let heavy

    before(async function () {
      const Factory = await ethers.getContractFactory("HeavyCompute", deployer)
      heavy = await Factory.deploy()
      await heavy.waitForDeployment()
      console.log(`      HeavyCompute deployed at ${await heavy.getAddress()}`)
    })

    it("fibonacci(50) — CPU loop", async function () {
      const start = Date.now()
      const result = await heavy.fibonacci(50)
      const ms = Date.now() - start
      expect(result).to.equal(12586269025n)
      report("fibonacci(50)", { gas: "view", ms, ok: true })
    })

    it("fibonacci(200) — extended CPU", async function () {
      const start = Date.now()
      const result = await heavy.fibonacci(200)
      const ms = Date.now() - start
      expect(result).to.be.gt(0n)
      report("fibonacci(200)", { gas: "view", ms, ok: true })
    })

    it("sortArray(100) — O(n^2) loop", async function () {
      const arr = Array.from({ length: 100 }, (_, i) => 100 - i) // reverse sorted
      const start = Date.now()
      const sorted = await heavy.sortArray(arr)
      const ms = Date.now() - start
      expect(sorted[0]).to.equal(1n)
      expect(sorted[99]).to.equal(100n)
      report("sortArray(100)", { gas: "view", ms, ok: true })
    })

    it("batchWrite(100) — 100 SSTORE", async function () {
      const start = Date.now()
      const tx = await heavy.batchWrite(100)
      const receipt = await tx.wait()
      const ms = Date.now() - start
      report("batchWrite(100)", { gas: receipt.gasUsed.toString(), ms, ok: receipt.status === 1 })
    })

    it("batchWrite(200) — 200 SSTORE", async function () {
      const start = Date.now()
      const tx = await heavy.batchWrite(200)
      const receipt = await tx.wait()
      const ms = Date.now() - start
      report("batchWrite(200)", { gas: receipt.gasUsed.toString(), ms, ok: receipt.status === 1 })
    })

    it("batchWrite(500) — 500 SSTORE", async function () {
      const start = Date.now()
      const tx = await heavy.batchWrite(500)
      const receipt = await tx.wait()
      const ms = Date.now() - start
      report("batchWrite(500)", { gas: receipt.gasUsed.toString(), ms, ok: receipt.status === 1 })
    })

    it("batchRead(500) — 500 SLOAD", async function () {
      const start = Date.now()
      const sum = await heavy.batchRead(500)
      const ms = Date.now() - start
      expect(sum).to.be.gt(0n)
      report("batchRead(500)", { gas: "view", ms, ok: true })
    })

    it("hashLoop(1000) — keccak256 chain", async function () {
      const start = Date.now()
      const tx = await heavy.hashLoop(1000)
      const receipt = await tx.wait()
      const ms = Date.now() - start
      report("hashLoop(1000)", { gas: receipt.gasUsed.toString(), ms, ok: receipt.status === 1 })
    })

    it("hashLoop(5000) — extended keccak256", async function () {
      const start = Date.now()
      const tx = await heavy.hashLoop(5000)
      const receipt = await tx.wait()
      const ms = Date.now() - start
      report("hashLoop(5000)", { gas: receipt.gasUsed.toString(), ms, ok: receipt.status === 1 })
    })

    it("memoryExpand(32KB)", async function () {
      const start = Date.now()
      const result = await heavy.memoryExpand(32768)
      const ms = Date.now() - start
      expect(result).to.be.gt(0n)
      report("memoryExpand(32KB)", { gas: "view", ms, ok: true })
    })

    it("memoryExpand(64KB)", async function () {
      const start = Date.now()
      const result = await heavy.memoryExpand(65536)
      const ms = Date.now() - start
      expect(result).to.be.gt(0n)
      report("memoryExpand(64KB)", { gas: "view", ms, ok: true })
    })

    it("combinedStress(100 writes, 1000 hashes)", async function () {
      const start = Date.now()
      const tx = await heavy.combinedStress(100, 1000)
      const receipt = await tx.wait()
      const ms = Date.now() - start
      report("combined(100w+1000h)", { gas: receipt.gasUsed.toString(), ms, ok: receipt.status === 1 })
    })
  })

  // ─── 2. Throughput Benchmarks ───

  describe("2. Throughput Benchmarks", function () {
    it("50 concurrent ETH transfers", async function () {
      const start = Date.now()
      const promises = []
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 10; j++) {
          const sender = wallets[i]
          const receiver = wallets[(i + j + 1) % wallets.length]
          promises.push(
            sender.sendTransaction({ to: receiver.address, value: ethers.parseEther("0.01") })
              .then((tx) => tx.wait())
              .then((receipt) => ({ ok: true, gas: receipt.gasUsed, block: receipt.blockNumber }))
              .catch((err) => ({ ok: false, error: err.message })),
          )
        }
      }
      const results = await Promise.allSettled(promises)
      const ms = Date.now() - start
      const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.ok).length
      const tps = Math.round((succeeded / ms) * 1000 * 100) / 100
      report("50x ETH transfer", { ms, ok: succeeded > 0, tps })
      console.log(`      ${succeeded}/50 succeeded in ${ms}ms`)
    })

    it("20 concurrent ERC-20 transfers", async function () {
      // Deploy a fresh token
      const Factory = await ethers.getContractFactory("ERC20Mock", deployer)
      const token = await Factory.deploy(ethers.parseEther("10000000"))
      await token.waitForDeployment()

      // Distribute tokens
      for (const w of wallets) {
        await (await token.transfer(w.address, ethers.parseEther("10000"))).wait()
      }

      const start = Date.now()
      const promises = []
      for (let i = 0; i < wallets.length; i++) {
        for (let j = 0; j < 2; j++) {
          const sender = wallets[i]
          const receiver = wallets[(i + 1) % wallets.length]
          promises.push(
            token.connect(sender).transfer(receiver.address, ethers.parseEther("1"))
              .then((tx) => tx.wait())
              .then((receipt) => ({ ok: true, gas: receipt.gasUsed }))
              .catch((err) => ({ ok: false, error: err.message })),
          )
        }
      }
      const results = await Promise.allSettled(promises)
      const ms = Date.now() - start
      const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.ok).length
      const tps = Math.round((succeeded / ms) * 1000 * 100) / 100
      report("20x ERC20 transfer", { ms, ok: succeeded > 0, tps })
      console.log(`      ${succeeded}/20 succeeded in ${ms}ms`)
    })

    it("10 sequential contract deployments", async function () {
      const Factory = await ethers.getContractFactory("ERC20Mock", deployer)
      const start = Date.now()
      let totalGas = 0n
      for (let i = 0; i < 10; i++) {
        const c = await Factory.deploy(ethers.parseEther("1000"))
        const receipt = await c.deploymentTransaction().wait()
        totalGas += receipt.gasUsed
      }
      const ms = Date.now() - start
      const tps = Math.round((10 / ms) * 1000 * 100) / 100
      report("10x contract deploy", { gas: (totalGas / 10n).toString(), ms, ok: true, tps })
    })
  })

  // ─── 3. Gas Limit Boundary ───

  describe("3. Gas Limit Boundary Tests", function () {
    let heavy

    before(async function () {
      const Factory = await ethers.getContractFactory("HeavyCompute", deployer)
      heavy = await Factory.deploy()
      await heavy.waitForDeployment()
    })

    it("batchWrite near block gas limit (1000 slots)", async function () {
      try {
        const tx = await heavy.batchWrite(1000, { gasLimit: 25_000_000 })
        const receipt = await tx.wait()
        report("batchWrite(1000)", { gas: receipt.gasUsed.toString(), ok: receipt.status === 1 })
      } catch (err) {
        report("batchWrite(1000)", { ok: false })
        console.log(`      Reverted: ${err.message.slice(0, 100)}`)
      }
    })

    it("hashLoop(10000) — heavy keccak chain", async function () {
      try {
        const tx = await heavy.hashLoop(10000, { gasLimit: 20_000_000 })
        const receipt = await tx.wait()
        report("hashLoop(10000)", { gas: receipt.gasUsed.toString(), ok: receipt.status === 1 })
      } catch (err) {
        report("hashLoop(10000)", { ok: false })
        console.log(`      Reverted: ${err.message.slice(0, 100)}`)
      }
    })

    it("combinedStress(200 writes, 5000 hashes)", async function () {
      try {
        const tx = await heavy.combinedStress(200, 5000, { gasLimit: 25_000_000 })
        const receipt = await tx.wait()
        report("combined(200w+5000h)", { gas: receipt.gasUsed.toString(), ok: receipt.status === 1 })
      } catch (err) {
        report("combined(200w+5000h)", { ok: false })
        console.log(`      Reverted: ${err.message.slice(0, 100)}`)
      }
    })
  })
})
