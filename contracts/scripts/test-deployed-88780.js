/**
 * Smoke test all deployed contracts on 88780 R3.2 testnet.
 * Reads from each contract + does 1 sample mutation to verify on-chain.
 */
const { ethers } = require("hardhat")
const fs = require("fs")
const path = require("path")

async function main() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "configs", "deployed-contracts-88780.json"), "utf8"),
  )
  const { contracts } = manifest
  const [deployer] = await ethers.getSigners()
  console.log(`=== Smoke test deployed contracts on chainId ${manifest.chainId} ===`)
  console.log(`Deployer: ${deployer.address}`)
  console.log("")

  const results = {}

  // 1. FactionRegistry — read owner
  {
    const c = await ethers.getContractAt("FactionRegistry", contracts.FactionRegistry)
    const owner = await c.owner()
    const ok = owner.toLowerCase() === deployer.address.toLowerCase()
    results.FactionRegistry = { read_owner: owner, pass: ok }
    console.log(`[FactionRegistry] owner=${owner} ${ok ? "✓" : "✗"}`)
  }

  // 2. GovernanceDAO — read params
  {
    const c = await ethers.getContractAt("GovernanceDAO", contracts.GovernanceDAO)
    const vp = await c.votingPeriod()
    const td = await c.timelockDelay()
    const tr = await c.treasury()
    const ok = vp === 259200n && td === 86400n && tr.toLowerCase() === contracts.Treasury.toLowerCase()
    results.GovernanceDAO = { votingPeriod: vp.toString(), timelock: td.toString(), treasury: tr, pass: ok }
    console.log(`[GovernanceDAO] votingPeriod=${vp}s timelock=${td}s treasury=${tr} ${ok ? "✓" : "✗"}`)
  }

  // 3. Treasury — read governance + signer[0]
  {
    const c = await ethers.getContractAt("Treasury", contracts.Treasury)
    const gov = await c.governance()
    const s0 = await c.signers(0)
    const ok = gov.toLowerCase() === contracts.GovernanceDAO.toLowerCase()
    results.Treasury = { governance: gov, signer0: s0, pass: ok }
    console.log(`[Treasury] governance=${gov} signer[0]=${s0} ${ok ? "✓" : "✗"}`)
  }

  // 4. SoulRegistry — count zero
  {
    const c = await ethers.getContractAt("SoulRegistry", contracts.SoulRegistry)
    const code = await ethers.provider.getCode(contracts.SoulRegistry)
    const hasCode = code.length > 2
    results.SoulRegistry = { codeBytes: (code.length - 2) / 2, pass: hasCode }
    console.log(`[SoulRegistry] code=${(code.length - 2) / 2} bytes ${hasCode ? "✓" : "✗"}`)
  }

  // 5. DIDRegistry — has soulRegistry binding
  {
    const c = await ethers.getContractAt("DIDRegistry", contracts.DIDRegistry)
    const sr = await c.soulRegistry()
    const ok = sr.toLowerCase() === contracts.SoulRegistry.toLowerCase()
    results.DIDRegistry = { soulRegistry: sr, pass: ok }
    console.log(`[DIDRegistry] soulRegistry=${sr} ${ok ? "✓" : "✗"}`)
  }

  // 6. CidRegistry — code exists
  {
    const code = await ethers.provider.getCode(contracts.CidRegistry)
    const ok = code.length > 2
    results.CidRegistry = { codeBytes: (code.length - 2) / 2, pass: ok }
    console.log(`[CidRegistry] code=${(code.length - 2) / 2} bytes ${ok ? "✓" : "✗"}`)
  }

  // 7. PoSeManager (v1) — code exists
  {
    const code = await ethers.provider.getCode(contracts.PoSeManager)
    const ok = code.length > 2
    results.PoSeManager = { codeBytes: (code.length - 2) / 2, pass: ok }
    console.log(`[PoSeManager] code=${(code.length - 2) / 2} bytes ${ok ? "✓" : "✗"}`)
  }

  // 8. PoSeManagerV2 — code exists
  {
    const code = await ethers.provider.getCode(contracts.PoSeManagerV2)
    const ok = code.length > 2
    results.PoSeManagerV2 = { codeBytes: (code.length - 2) / 2, pass: ok }
    console.log(`[PoSeManagerV2] code=${(code.length - 2) / 2} bytes ${ok ? "✓" : "✗"}`)
  }

  // 9. ValidatorRegistry
  {
    const code = await ethers.provider.getCode(contracts.ValidatorRegistry)
    const ok = code.length > 2
    results.ValidatorRegistry = { codeBytes: (code.length - 2) / 2, pass: ok }
    console.log(`[ValidatorRegistry] code=${(code.length - 2) / 2} bytes ${ok ? "✓" : "✗"}`)
  }

  // 10. EquivocationDetector — validatorRegistry binding
  {
    const c = await ethers.getContractAt("EquivocationDetector", contracts.EquivocationDetector)
    const vr = await c.validatorRegistry()
    const ok = vr.toLowerCase() === contracts.ValidatorRegistry.toLowerCase()
    results.EquivocationDetector = { validatorRegistry: vr, pass: ok }
    console.log(`[EquivocationDetector] validatorRegistry=${vr} ${ok ? "✓" : "✗"}`)
  }

  // 11. InsuranceFund — governance binding
  {
    const c = await ethers.getContractAt("InsuranceFund", contracts.InsuranceFund)
    const gov = await c.governance()
    const ok = gov.toLowerCase() === contracts.GovernanceDAO.toLowerCase()
    results.InsuranceFund = { governance: gov, pass: ok }
    console.log(`[InsuranceFund] governance=${gov} ${ok ? "✓" : "✗"}`)
  }

  // 12. DelayedInbox — sequencer binding
  {
    const c = await ethers.getContractAt("DelayedInbox", contracts.DelayedInbox)
    const seq = await c.sequencer()
    const ok = seq.toLowerCase() === deployer.address.toLowerCase()
    results.DelayedInbox = { sequencer: seq, pass: ok }
    console.log(`[DelayedInbox] sequencer=${seq} ${ok ? "✓" : "✗"}`)
  }

  // 13. RollupStateManager — code exists
  {
    const code = await ethers.provider.getCode(contracts.RollupStateManager)
    const ok = code.length > 2
    results.RollupStateManager = { codeBytes: (code.length - 2) / 2, pass: ok }
    console.log(`[RollupStateManager] code=${(code.length - 2) / 2} bytes ${ok ? "✓" : "✗"}`)
  }

  // Mutation test: send 1 ETH from deployer to v1 validator address to verify chain accepts tx
  console.log("")
  console.log("=== Mutation test: send 1 ETH to v1 validator ===")
  const v1addr = "0xde4e7889aa9007318ff261b1ee675f1305153590"
  const balBefore = await ethers.provider.getBalance(v1addr)
  const tx = await deployer.sendTransaction({ to: v1addr, value: ethers.parseEther("1") })
  const rcpt = await tx.wait()
  const balAfter = await ethers.provider.getBalance(v1addr)
  const delta = balAfter - balBefore
  const mutationOk = delta === ethers.parseEther("1")
  console.log(`  tx ${tx.hash.slice(0, 20)}... block ${rcpt.blockNumber} status=${rcpt.status} delta=${ethers.formatEther(delta)} ETH ${mutationOk ? "✓" : "✗"}`)

  // Summary
  console.log("")
  console.log("=== Summary ===")
  const passed = Object.values(results).filter((r) => r.pass).length + (mutationOk ? 1 : 0)
  const total = Object.keys(results).length + 1
  console.log(`${passed}/${total} tests passed`)
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${r.pass ? "✓" : "✗"} ${name}`)
  }
  console.log(`  ${mutationOk ? "✓" : "✗"} ETH transfer mutation`)

  if (passed < total) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
