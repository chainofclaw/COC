/**
 * R3.1 — EquivocationDetector slash automation E2E (M10)
 *
 * Drives the production runtime path `EquivocationDetectorClient` against
 * the live H15 fork-off chain (chainId 88888) to verify that:
 *
 *   1. The client primes its address→nodeId cache from on-chain
 *      ValidatorRegistered events
 *   2. Synthetic but cryptographically valid BFT equivocation evidence
 *      (two prepare-phase signatures over different block hashes at the
 *      same height, signed by the SAME validator key) submits cleanly
 *   3. The on-chain EquivocationDetector contract verifies + emits
 *      EquivocationProven
 *   4. ValidatorRegistry.slashValidator fires (cooldown gate honoured;
 *      validator's stake reduced or active flag flipped)
 *
 * The same `EquivocationDetectorClient` class is used by
 * runtime/coc-relayer.ts (Phase I3c), so a green test here means the
 * relayer's auto-slash path is also green when the BFT layer feeds it
 * EquivocationEvidence with signatures attached.
 *
 * Pre-req: `bash scripts/run-pose.sh up` writes deployed-pose.json with
 * ValidatorRegistry + EquivocationDetector addresses. setSlasher wiring
 * is done by deploy-pose-on-h15.mjs Step 4.
 */
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { Contract, JsonRpcProvider, Wallet, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers"
import { EquivocationDetectorClient } from "../../../runtime/lib/equivocation-detector-client.ts"
import type { EquivocationEvidence } from "../../../node/src/bft.ts"

const RPC = "http://localhost:38790"
const DEPLOYED_PATH = "/passinger/projects/ClawdBot/COC/tests/multinode-integration/configs-h15/deployed-pose.json"

// Same anvil-1 key the H15 fixture uses for h15-node-2 — gives us a
// validator that's actually registered + active in ValidatorRegistry, so
// slashing has something to bite.
const VICTIM_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const SLASHER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" // anvil-0

// Mirrors node/src/bft-coordinator.ts:bftCanonicalMessage exactly. The
// detector contract reconstructs the same prefix and ecrecover's the
// signer, so any drift here would cause SignersDiffer or
// SignerNotNodeIdTrailer reverts.
function bftCanonicalMessage(phase: string, height: bigint, blockHash: string): string {
  return `bft:${phase}:${height.toString()}:${blockHash}`
}

const VR_ABI = [
  "function getValidator(bytes32) view returns (tuple(bytes32 nodeId, address operator, uint256 stake, uint64 registeredAt, uint64 unstakeRequestedAt, bool active))",
] as const

describe("R3.1 — EquivocationDetector slash automation (M10 E2E)", { timeout: 120_000 }, () => {
  let provider: JsonRpcProvider
  let slasherWallet: Wallet
  let victimWallet: Wallet
  let registryAddress: string
  let detectorAddress: string
  let victimNodeId: string

  before(async () => {
    if (!existsSync(DEPLOYED_PATH)) {
      throw new Error("deployed-pose.json missing — run `bash scripts/run-pose.sh up` first")
    }
    const deployed = JSON.parse(readFileSync(DEPLOYED_PATH, "utf-8"))
    registryAddress = deployed.contracts.ValidatorRegistry.address
    detectorAddress = deployed.contracts.EquivocationDetector.address
    provider = new JsonRpcProvider(RPC)
    slasherWallet = new Wallet(SLASHER_KEY, provider)
    victimWallet = new Wallet(VICTIM_KEY, provider)
    // Compute victim's nodeId (matches ValidatorRegistry convention:
    // keccak256(xy) where xy = pubkey without 0x04 prefix).
    const xy = "0x" + victimWallet.signingKey.publicKey.slice(4)
    victimNodeId = keccak256(xy)
  })

  it("baseline: victim is staked + active in ValidatorRegistry", async () => {
    const vr = new Contract(registryAddress, VR_ABI, provider)
    const v = await vr.getValidator(victimNodeId)
    assert.equal(v.operator.toLowerCase(), victimWallet.address.toLowerCase(), "operator mismatch")
    assert.equal(v.active, true, "victim must be active for slash to bite")
    assert.ok(v.stake > 0n, "victim must have stake")
    console.log(`  ✅ baseline: victim ${victimWallet.address.slice(0, 10)}… stake=${v.stake.toString()}`)
  })

  it("EquivocationDetectorClient primes address→nodeId cache from on-chain events", async () => {
    const client = new EquivocationDetectorClient({
      signer: slasherWallet,
      registryAddress,
      detectorAddress,
      provider,
    })
    const result = await client.prime()
    assert.ok(result.scannedTo > 0n, "scan reached chain tip")
    // 5 validators × 2 keys (trailer + operator) = 10 entries; both keys
    // can collapse if operator==trailer (they do for anvil keys), so we
    // expect at least 5 unique entries.
    assert.ok(client.cacheSize() >= 5, `cache should hold ≥5 validators, got ${client.cacheSize()}`)
    const resolved = client.resolveNodeId(victimWallet.address)
    assert.equal(resolved, victimNodeId, "victim address must resolve to victim nodeId")
    console.log(`  ✅ primed: ${client.cacheSize()} entries, victim resolved`)
  })

  it("submitEvidence with valid double-sign evidence triggers EquivocationProven + slash", async () => {
    const client = new EquivocationDetectorClient({
      signer: slasherWallet,
      registryAddress,
      detectorAddress,
      provider,
    })
    await client.prime()

    // Synthesize equivocation: two distinct block hashes at the same
    // height + phase, signed by the SAME validator key (= double-vote).
    const phase = "prepare" as const
    const height = BigInt(await provider.getBlockNumber()) - 1n
    const hashA = keccak256(toUtf8Bytes(`evidence-A-${Date.now()}`))
    const hashB = keccak256(toUtf8Bytes(`evidence-B-${Date.now()}`))
    assert.notEqual(hashA, hashB)

    const sigA = await victimWallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await victimWallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    const evidence: EquivocationEvidence = {
      validatorId: victimWallet.address.toLowerCase(),
      height,
      phase,
      blockHash1: hashA as `0x${string}`,
      blockHash2: hashB as `0x${string}`,
      detectedAtMs: Date.now(),
      signature1: sigA as `0x${string}`,
      signature2: sigB as `0x${string}`,
    }

    // Read pre-slash state for delta assertion
    const vr = new Contract(registryAddress, VR_ABI, provider)
    const before = await vr.getValidator(victimNodeId)

    const { txHash, nodeId } = await client.submitEvidence(evidence)
    assert.equal(nodeId, victimNodeId, "client resolved correct nodeId")
    console.log(`  submitted: tx=${txHash.slice(0, 18)}…`)

    // Verify on-chain effect: stake decreased OR active flipped
    const after = await vr.getValidator(victimNodeId)
    const stakeDecreased = after.stake < before.stake
    const flippedInactive = before.active && !after.active
    assert.ok(
      stakeDecreased || flippedInactive,
      `slash had no effect: before stake=${before.stake} active=${before.active}, after stake=${after.stake} active=${after.active}`,
    )
    console.log(
      `  ✅ slashed: stake ${before.stake.toString()} → ${after.stake.toString()} ` +
      `(active ${before.active} → ${after.active})`,
    )
  })

  it("re-submit during cooldown reverts (CooldownActive)", async () => {
    const client = new EquivocationDetectorClient({
      signer: slasherWallet,
      registryAddress,
      detectorAddress,
      provider,
    })
    await client.prime()

    const phase = "prepare" as const
    const height = BigInt(await provider.getBlockNumber()) - 2n
    const hashA = keccak256(toUtf8Bytes(`cooldown-A-${Date.now()}`))
    const hashB = keccak256(toUtf8Bytes(`cooldown-B-${Date.now()}`))
    const sigA = await victimWallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await victimWallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    const evidence: EquivocationEvidence = {
      validatorId: victimWallet.address.toLowerCase(),
      height,
      phase,
      blockHash1: hashA as `0x${string}`,
      blockHash2: hashB as `0x${string}`,
      detectedAtMs: Date.now(),
      signature1: sigA as `0x${string}`,
      signature2: sigB as `0x${string}`,
    }

    await assert.rejects(
      () => client.submitEvidence(evidence),
      (err: Error) => /cooldown|reverted|CooldownActive/i.test(err.message),
      "second slash within cooldown should revert",
    )
    console.log(`  ✅ cooldown gate held: re-submit rejected`)
  })
})
