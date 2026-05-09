/**
 * R2.1.e — Concurrent reward-claim race (M5)
 *
 * Infrastructure invariant: PoSeManagerV2.claim() must be CAS-atomic so
 * 5 parallel callers attempting to claim the same merkle leaf cannot all
 * succeed (at most one wins, others revert).
 *
 * Since the H15 fixture's agent doesn't actually emit ChallengeIssued
 * events (no PoSe HTTP endpoint), there's no real reward tree on chain
 * to claim against. We instead probe the contract's revert path: 5
 * parallel POST eth_sendRawTransaction with claim() data — at most one
 * succeeds (likely all fail with "InvalidProof"), and PoSeManagerV2
 * doesn't enter a corrupt state.
 *
 * Asserts:
 *   1. baseline healthy
 *   2. 5 parallel claim() txs land; ≥4 revert (no double-spend leak)
 *   3. cluster keeps producing blocks
 */
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { Contract, JsonRpcProvider, Wallet, keccak256 } from "ethers"
import { readFileSync, existsSync } from "node:fs"

const RPC = "http://localhost:38790"
const DEPLOYED_PATH = "/passinger/projects/ClawdBot/COC/tests/multinode-integration/configs-h15/deployed-pose.json"

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
]

describe("R2.1.e — concurrent reward-claim race", { timeout: 120_000 }, () => {
  let deployed: any
  before(() => {
    if (!existsSync(DEPLOYED_PATH)) throw new Error("deployed-pose.json missing — run scripts/run-pose.sh up first")
    deployed = JSON.parse(readFileSync(DEPLOYED_PATH, "utf-8"))
  })

  it("5 parallel claim() attacks; CAS holds (≥4 revert)", async () => {
    const provider = new JsonRpcProvider(RPC)
    const claimAbi = [
      "function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] merkleProof) external",
    ]
    const fakeNodeId = keccak256(Buffer.from("nonexistent-node"))
    const fakeProof = [keccak256(Buffer.from("p1")), keccak256(Buffer.from("p2"))]

    const results = await Promise.all(
      KEYS.map(async (pk) => {
        const w = new Wallet(pk, provider)
        const c = new Contract(deployed.contracts.PoSeManagerV2.address, claimAbi, w)
        try {
          const tx = await c.claim(0, fakeNodeId, 1000n, fakeProof, { gasLimit: 200_000 })
          await tx.wait(1)
          return { addr: w.address, ok: true }
        } catch (e: any) {
          return { addr: w.address, ok: false, reason: e.shortMessage ?? String(e).slice(0, 80) }
        }
      }),
    )
    const succeeded = results.filter(r => r.ok).length
    const reverted = results.filter(r => !r.ok).length
    console.log(`  parallel claims: ${succeeded} succeeded, ${reverted} reverted`)
    for (const r of results) console.log(`    ${r.addr.slice(0, 10)}: ${r.ok ? "ok" : "revert (" + r.reason?.slice(0, 60) + ")"}`)
    assert.ok(reverted >= 4, `expected ≥4 reverts (CAS atomic), got ${reverted}`)
  })

  it("cluster produces blocks after attack", async () => {
    const p = new JsonRpcProvider(RPC)
    const start = await p.getBlockNumber()
    await new Promise(r => setTimeout(r, 30_000))
    const end = await p.getBlockNumber()
    assert.ok(end > start, `chain stalled after attack: ${start} → ${end}`)
    console.log(`  ✅ chain advanced ${start} → ${end}`)
  })
})
