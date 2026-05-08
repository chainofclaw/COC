/**
 * Functional smoke test for the 5 registries deployed via
 * deploy-all-registries-newchain.mjs. Uses the addresses persisted in
 * deployed-registries-newchain.json. One read + (where appropriate) one
 * write per contract — bare minimum to confirm the bytecode + state
 * actually do what the ABI says.
 */
import { JsonRpcProvider, Wallet, ethers } from "ethers"
import { readFileSync } from "node:fs"

const RPC = process.env.RPC || "http://209.74.64.88:28780"
const KEY = process.env.DEPLOYER_KEY
  || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const deployed = JSON.parse(readFileSync(
  "/passinger/projects/ClawdBot/COC/contracts/deployed-registries-newchain.json",
  "utf8",
))

const provider = new JsonRpcProvider(RPC)
const wallet = new Wallet(KEY, provider)
const gasPrice = ((await provider.getFeeData()).gasPrice ?? 2_000_000_000n) * 2n
const baseTxOpts = { gasPrice, type: 0, gasLimit: 500_000 }

const results = []
const ok = (name, msg) => { results.push({ name, status: "PASS", msg }); console.log(`  ✓ ${name}: ${msg}`) }
const bad = (name, msg) => { results.push({ name, status: "FAIL", msg }); console.log(`  ✗ ${name}: ${msg}`) }

console.log(`# Smoke test (chainId=18780, deployer=${wallet.address})\n`)

// ── 1. CidRegistry — full register/resolve roundtrip ───────────────────────
console.log("[1] CidRegistry register/resolve roundtrip")
const cidAbi = [
  "function registerCid(bytes32 cidHash, string cid) external",
  "function isRegistered(bytes32 cidHash) external view returns (bool)",
  "function resolveCid(bytes32 cidHash) external view returns (string)",
]
const cid = new ethers.Contract(deployed.contracts.CidRegistry.address, cidAbi, wallet)
const sample = `bafybei-smoke-${Date.now()}`
const cidHash = ethers.keccak256(ethers.toUtf8Bytes(sample))
const cidTx = await cid.registerCid(cidHash, sample, baseTxOpts)
const cidR = await cidTx.wait(1)
if (cidR.status !== 1) bad("CidRegistry.registerCid", `tx status=${cidR.status}`)
else {
  const reg = await cid.isRegistered(cidHash)
  const back = await cid.resolveCid(cidHash)
  if (reg && back === sample) ok("CidRegistry", `register+resolve OK (block ${cidR.blockNumber})`)
  else bad("CidRegistry", `roundtrip mismatch: reg=${reg} back=${back} expected=${sample}`)
}

// ── 2. ValidatorRegistry — getActiveValidators on empty contract ───────────
console.log("\n[2] ValidatorRegistry initial state + constants")
const vrAbi = [
  "function getActiveValidators() view returns (bytes32[])",
  "function activeValidatorCount() view returns (uint256)",
  "function MIN_STAKE() view returns (uint256)",
]
const vr = new ethers.Contract(deployed.contracts.ValidatorRegistry.address, vrAbi, provider)
const list = await vr.getActiveValidators()
const count = await vr.activeValidatorCount()
const minStake = await vr.MIN_STAKE().catch(() => null)
if (list.length === 0 && count === 0n) ok("ValidatorRegistry", `fresh deploy state OK (active=0, MIN_STAKE=${minStake ? ethers.formatEther(minStake) + " ETH" : "n/a"})`)
else bad("ValidatorRegistry", `unexpected non-fresh state: count=${count} listLen=${list.length}`)

// ── 3. SoulRegistry — query a constant + DOMAIN_SEPARATOR is non-zero ──────
console.log("\n[3] SoulRegistry constants + EIP-712 domain")
const srAbi = [
  "function CURRENT_VERSION() view returns (uint16)",
  "function MAX_GUARDIANS() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]
const sr = new ethers.Contract(deployed.contracts.SoulRegistry.address, srAbi, provider)
try {
  const ver = await sr.CURRENT_VERSION()
  const maxG = await sr.MAX_GUARDIANS()
  const dom = await sr.DOMAIN_SEPARATOR()
  if (dom !== "0x" + "00".repeat(32) && ver > 0n && maxG > 0n) {
    ok("SoulRegistry", `version=${ver} maxGuardians=${maxG} DOMAIN_SEPARATOR=${dom.slice(0,18)}…`)
  } else bad("SoulRegistry", `unexpected: ver=${ver} maxG=${maxG} dom=${dom}`)
} catch (e) {
  bad("SoulRegistry", `view call threw: ${e.message?.slice(0,80)}`)
}

// ── 4. DIDRegistry — domain separator + max-delegation-depth ───────────────
console.log("\n[4] DIDRegistry constants")
const drAbi = [
  "function MAX_DELEGATION_DEPTH() view returns (uint8)",
  "function MAX_DELEGATIONS_PER_AGENT() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]
const dr = new ethers.Contract(deployed.contracts.DIDRegistry.address, drAbi, provider)
try {
  const depth = await dr.MAX_DELEGATION_DEPTH()
  const perAgent = await dr.MAX_DELEGATIONS_PER_AGENT()
  const dom = await dr.DOMAIN_SEPARATOR()
  if (depth > 0n && perAgent > 0n && dom !== "0x" + "00".repeat(32)) {
    ok("DIDRegistry", `maxDepth=${depth} maxPerAgent=${perAgent} DOMAIN_SEPARATOR=${dom.slice(0,18)}…`)
  } else bad("DIDRegistry", `unexpected: depth=${depth} perAgent=${perAgent} dom=${dom}`)
} catch (e) {
  bad("DIDRegistry", `view call threw: ${e.message?.slice(0,80)}`)
}

// ── 5. PoSeManagerV2 — constants + epoch config ────────────────────────────
console.log("\n[5] PoSeManagerV2 epoch + bond config")
const peAbi = [
  "function EPOCH_SECONDS() view returns (uint64)",
  "function MIN_BOND() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function DISPUTE_WINDOW_EPOCHS() view returns (uint64)",
]
const pe = new ethers.Contract(deployed.contracts.PoSeManagerV2.address, peAbi, provider)
try {
  const sec = await pe.EPOCH_SECONDS()
  const bond = await pe.MIN_BOND()
  const dom = await pe.DOMAIN_SEPARATOR()
  const dw = await pe.DISPUTE_WINDOW_EPOCHS()
  if (sec > 0n && dom !== "0x" + "00".repeat(32) && dw > 0n) {
    ok("PoSeManagerV2", `epoch=${sec}s minBond=${ethers.formatEther(bond)} ETH disputeWindow=${dw} epochs DOMAIN_SEPARATOR=${dom.slice(0,18)}…`)
  } else bad("PoSeManagerV2", `unexpected: sec=${sec} bond=${bond} dom=${dom}`)
} catch (e) {
  bad("PoSeManagerV2", `view call threw: ${e.message?.slice(0,80)}`)
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log()
const passes = results.filter(r => r.status === "PASS").length
const fails = results.filter(r => r.status === "FAIL").length
console.log(`# Result: ${passes}/${results.length} PASS, ${fails} FAIL`)
if (fails > 0) process.exit(1)
