/**
 * PoSe v2 settlement — hardhat-node integration tests (non-docker)
 *
 * Deepens coverage of currently-thin areas of PoSeManagerV2.sol that the
 * existing contract-level hardhat suite (contracts/test/pose-v2*.test.cjs)
 * and the off-chain pipeline tests do NOT exercise:
 *
 *   1. Reward double-claim + reward-budget overflow (RewardBudgetExceeded)
 *      and the 7-day claim window expiry guard.
 *   2. Witness quorum boundary — a batch with REAL witness signatures: one
 *      below quorum (rejected), one at exactly quorum (accepted), plus a
 *      forged-signature rejection. No existing test ever passes a non-empty
 *      witnessBitmap/witnessSignatures pair, so the on-chain ecrecover path
 *      in _validateWitnessQuorum is otherwise dead-untested.
 *   3. Fault-proof dispute lifecycle — the permissionless commit → reveal →
 *      settle flow for an INVALID dispute (faultType mismatch / wrong
 *      challenger signature) where the bond is forfeited to insurance, plus
 *      double-settle and reveal-window-missed guards.
 *   4. Epoch finalization edge cases — early finalize (DisputeWindowNotElapsed)
 *      and reward-pool-insufficient guard.
 *
 * Uses the proven hardhat-node-spawn pattern from
 * governance-dao-lifecycle.integration.test.ts. evm_setNextBlockTimestamp
 * lets us land transactions on deterministic epoch boundaries
 * (epoch = floor(block.timestamp / 3600)) which the witness-set selection
 * and dispute windows depend on.
 */
import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getBytes,
  keccak256,
  parseEther,
  solidityPacked,
  solidityPackedKeccak256,
  toUtf8Bytes,
} from "ethers"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")
const contractsDir = join(repoRoot, "contracts")
const artifactsDir = join(contractsDir, "artifacts", "contracts-src", "settlement")
const testArtifactsDir = join(contractsDir, "artifacts", "contracts-src", "test-contracts")

const hardhatCliRoot = join(repoRoot, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const hardhatCliContracts = join(contractsDir, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const hardhatCli = existsSync(hardhatCliRoot) ? hardhatCliRoot : hardhatCliContracts

// Anvil/hardhat-node default funded key #0.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

// ---------------------------------------------------------------------------
//  Hardhat node spawn helpers (copied from governance-*.integration.test.ts)
// ---------------------------------------------------------------------------

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const path = join(artifactsDir, `${name}.sol`, `${name}.json`)
  return JSON.parse(readFileSync(path, "utf8"))
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("failed to allocate free port"))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
    server.on("error", reject)
  })
}

interface HardhatHandle {
  process: ChildProcessWithoutNullStreams
  url: string
  stop: () => Promise<void>
}

async function startHardhatNode(port: number): Promise<HardhatHandle> {
  if (!existsSync(hardhatCli)) {
    throw new Error(`hardhat CLI not found at ${hardhatCliRoot} or ${hardhatCliContracts}; run npm install first`)
  }
  const child = spawn(process.execPath, [hardhatCli, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: contractsDir,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (c) => { output += String(c) })
  child.stderr.on("data", (c) => { output += String(c) })

  const url = `http://127.0.0.1:${port}`
  const probe = new JsonRpcProvider(url)
  const startedAt = Date.now()

  try {
    while (Date.now() - startedAt < 20_000) {
      if (child.exitCode !== null) {
        throw new Error(`hardhat exited early: code=${child.exitCode}\n${output}`)
      }
      try {
        await probe.getBlockNumber()
        return {
          process: child,
          url,
          stop: async () => {
            if (child.exitCode !== null) return
            child.kill("SIGTERM")
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                if (child.exitCode === null) child.kill("SIGKILL")
              }, 3_000)
              child.once("exit", () => { clearTimeout(timer); resolve() })
            })
          },
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    child.kill("SIGKILL")
    throw new Error(`hardhat did not start in time\n${output}`)
  } finally {
    probe.destroy()
  }
}

// ---------------------------------------------------------------------------
//  PoSe v2 domain helpers (mirror the contract + off-chain libraries)
// ---------------------------------------------------------------------------

const EPOCH_SECONDS = 3600

/** keccak256 pair-hash with sorted leaves — mirrors MerkleProofLite. */
function pairHash(a: string, b: string): string {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]
  return solidityPackedKeccak256(["bytes32", "bytes32"], [x, y])
}

interface MerkleTree {
  root: string
  layers: string[][]
}

function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) return { root: ZeroHash, layers: [] }
  if (leaves.length === 1) {
    const root = pairHash(leaves[0]!, leaves[0]!)
    return { root, layers: [leaves, [root]] }
  }
  const layers: string[][] = [leaves.slice()]
  while (layers[layers.length - 1]!.length > 1) {
    const layer = layers[layers.length - 1]!
    const next: string[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!
      const right = layer[i + 1] ?? layer[i]!
      next.push(pairHash(left, right))
    }
    layers.push(next)
  }
  return { root: layers[layers.length - 1]![0]!, layers }
}

function buildMerkleProof(layers: string[][], index: number): string[] {
  const proof: string[] = []
  let cursor = index
  for (let d = 0; d < layers.length - 1; d++) {
    const layer = layers[d]!
    const siblingIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1
    const sibling = layer[siblingIndex] ?? layer[cursor]!
    proof.push(sibling)
    cursor = Math.floor(cursor / 2)
  }
  return proof
}

interface EvidenceLeafV2 {
  epoch: number
  nodeId: string
  nonce: string
  tipHash: string
  tipHeight: number
  latencyMs: number
  resultCode: number
  witnessBitmap: number
}

function hashEvidenceLeafV2(leaf: EvidenceLeafV2): string {
  return solidityPackedKeccak256(
    ["uint64", "bytes32", "bytes16", "bytes32", "uint64", "uint32", "uint8", "uint32"],
    [leaf.epoch, leaf.nodeId, leaf.nonce, leaf.tipHash, leaf.tipHeight, leaf.latencyMs, leaf.resultCode, leaf.witnessBitmap],
  )
}

function encodeEvidenceData(batchId: string, merkleProof: string[], leaf: EvidenceLeafV2): string {
  return AbiCoder.defaultAbiCoder().encode(
    [
      "bytes32",
      "bytes32[]",
      "tuple(uint64 epoch,bytes32 nodeId,bytes16 nonce,bytes32 tipHash,uint64 tipHeight,uint32 latencyMs,uint8 resultCode,uint32 witnessBitmap)",
    ],
    [batchId, merkleProof, leaf],
  )
}

function computeCommitHash(targetNodeId: string, faultType: number, evidenceLeafHash: string, salt: string): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32"],
    [targetNodeId, faultType, evidenceLeafHash, salt],
  )
}

function computeRevealDigest(
  challengeId: string,
  targetNodeId: string,
  faultType: number,
  evidenceLeafHash: string,
  salt: string,
  evidenceData: string,
): string {
  return solidityPackedKeccak256(
    ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
    ["coc-fault:", challengeId, targetNodeId, faultType, evidenceLeafHash, salt, keccak256(evidenceData)],
  )
}

function buildSummaryHash(
  epochId: number,
  merkleRoot: string,
  sampleProofs: { leaf: string; merkleProof: string[]; leafIndex: number }[],
): string {
  let rolling = ZeroHash
  for (const proof of sampleProofs) {
    rolling = solidityPackedKeccak256(["bytes32", "uint32", "bytes32"], [rolling, proof.leafIndex, proof.leaf])
  }
  return solidityPackedKeccak256(
    ["uint64", "bytes32", "bytes32", "uint32"],
    [epochId, merkleRoot, rolling, sampleProofs.length],
  )
}

function hashRewardLeaf(epochId: number, nodeId: string, amount: bigint): string {
  return solidityPackedKeccak256(["uint64", "bytes32", "uint256"], [epochId, nodeId, amount])
}

/**
 * EIP-712 witness attestation hash — mirrors PoSeManagerV2._validateWitnessQuorum.
 *   witnessHash = keccak256(\x19\x01 || DOMAIN_SEPARATOR ||
 *      keccak256(abi.encode(WITNESS_TYPEHASH, merkleRoot, nodeId, merkleRoot, witnessIndex)))
 */
const WITNESS_TYPEHASH = solidityPackedKeccak256(
  ["string"],
  ["WitnessAttestation(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex)"],
)

function witnessDigest(domainSeparator: string, merkleRoot: string, nodeId: string, witnessIndex: number): string {
  const structHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint8"],
      [WITNESS_TYPEHASH, merkleRoot, nodeId, merkleRoot, witnessIndex],
    ),
  )
  return keccak256(solidityPacked(["bytes2", "bytes32", "bytes32"], ["0x1901", domainSeparator, structHash]))
}

// ---------------------------------------------------------------------------
//  Contract-driving helpers
// ---------------------------------------------------------------------------

interface Ctx {
  provider: JsonRpcProvider
  deployer: Wallet
  manager: any
  nextNonce: () => { nonce: number }
}

/** Register a fresh node; returns its operator wallet + nodeId + pubkey. */
async function registerNode(ctx: Ctx, bondEth = "1"): Promise<{ operator: Wallet; nodeId: string }> {
  const operator = Wallet.createRandom().connect(ctx.provider)
  await (await ctx.deployer.sendTransaction({ to: operator.address, value: parseEther("5"), ...ctx.nextNonce() })).wait()

  const pubkey = operator.signingKey.publicKey
  const nodeId = keccak256(pubkey)
  const serviceCommitment = keccak256(toUtf8Bytes("svc"))
  const endpointCommitment = keccak256(toUtf8Bytes(`ep-${Date.now()}-${Math.random()}`))
  const metadataHash = keccak256(toUtf8Bytes("meta"))
  const messageHash = solidityPackedKeccak256(
    ["string", "bytes32", "address"],
    ["coc-register:", nodeId, operator.address],
  )
  const ownershipSig = await operator.signMessage(getBytes(messageHash))

  await (
    await ctx.manager
      .connect(operator)
      .registerNode(nodeId, pubkey, 7, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x", {
        value: parseEther(bondEth),
        nonce: 0,
      })
  ).wait()
  return { operator, nodeId }
}

/** Land the next block exactly inside the given epoch. */
async function setEpoch(provider: JsonRpcProvider, epoch: number, offsetSeconds = 60): Promise<void> {
  const ts = epoch * EPOCH_SECONDS + offsetSeconds
  await provider.send("evm_setNextBlockTimestamp", [ts])
  await provider.send("evm_mine", [])
}

/** Advance time by whole epochs. */
async function advanceEpochs(provider: JsonRpcProvider, epochs: number): Promise<void> {
  await provider.send("evm_increaseTime", [epochs * EPOCH_SECONDS])
  await provider.send("evm_mine", [])
}

async function currentEpoch(provider: JsonRpcProvider): Promise<number> {
  const block = await provider.getBlock("latest")
  return Math.floor(Number(block!.timestamp) / EPOCH_SECONDS)
}

function loadTestProxyArtifact(): { abi: unknown[]; bytecode: string } {
  const path = join(testArtifactsDir, "TestERC1967Proxy.sol", "TestERC1967Proxy.json")
  return JSON.parse(readFileSync(path, "utf8"))
}

async function deployManager(ctx: Omit<Ctx, "manager">): Promise<any> {
  // gen-5: PoSeManagerV2 lives behind a UUPS proxy. Deploy implementation,
  // ABI-encode initialize(challengeBondMin, initialOwner), deploy
  // ERC1967Proxy with the init calldata, return a Contract bound to the
  // proxy address using the implementation's ABI.
  const art = loadArtifact("PoSeManagerV2")
  const implFactory = new ContractFactory(art.abi, art.bytecode, ctx.deployer)
  const impl = await implFactory.deploy(ctx.nextNonce())
  await impl.waitForDeployment()
  const iface = new Interface(art.abi)
  const initCalldata = iface.encodeFunctionData("initialize", [parseEther("0.01"), ctx.deployer.address])
  const proxyArt = loadTestProxyArtifact()
  const proxyFactory = new ContractFactory(proxyArt.abi, proxyArt.bytecode, ctx.deployer)
  const proxy = await proxyFactory.deploy(await impl.getAddress(), initCalldata, ctx.nextNonce())
  await proxy.waitForDeployment()
  return new Contract(await proxy.getAddress(), art.abi, ctx.deployer)
}

async function extractArg(manager: any, receipt: any, eventName: string, argIndex: number): Promise<any> {
  for (const log of receipt.logs) {
    try {
      const parsed = manager.interface.parseLog(log)
      if (parsed?.name === eventName) return parsed.args[argIndex]
    } catch {
      // not our event
    }
  }
  throw new Error(`event ${eventName} not found`)
}

// ---------------------------------------------------------------------------
//  Test 1 — Reward double-claim, budget overflow, expiry window
// ---------------------------------------------------------------------------

test("PoSe v2: reward claim — double-claim, budget overflow, and expiry window", { timeout: 120_000 }, async () => {
  const port = await getFreePort()
  const node = await startHardhatNode(port)
  let provider: JsonRpcProvider | null = null
  try {
    provider = new JsonRpcProvider(node.url)
    const deployer = new Wallet(DEPLOYER_KEY, provider)
    let n = await provider.getTransactionCount(deployer.address)
    const ctx: Ctx = {
      provider,
      deployer,
      manager: null,
      nextNonce: () => ({ nonce: n++ }),
    }
    ctx.manager = await deployManager(ctx)
    const manager = ctx.manager

    await (await manager.setAllowEmptyWitnessSubmission(true, ctx.nextNonce())).wait()
    await (await manager.depositRewardPool({ value: parseEther("10"), ...ctx.nextNonce() })).wait()

    const { operator, nodeId } = await registerNode(ctx)

    // Finalize an epoch that is safely in the past.
    await advanceEpochs(provider, 5)
    const epochId = 1
    const amount = parseEther("1")
    const leaf = hashRewardLeaf(epochId, nodeId, amount)
    const tree = buildMerkleTree([leaf])
    await (await manager.finalizeEpochV2(epochId, tree.root, amount, 0, 0, ctx.nextNonce())).wait()

    const proof = buildMerkleProof(tree.layers, 0)

    // First claim succeeds and credits the operator. Balances are read at
    // explicit block tags — ethers' provider caches getBalance("latest")
    // results, which would otherwise mask the post-claim delta.
    const claimTx = await manager.connect(operator).claim(epochId, nodeId, amount, proof, { nonce: 1 })
    const claimReceipt = await claimTx.wait()
    const claimBlock: number = claimReceipt.blockNumber
    const gas = claimReceipt.gasUsed * claimReceipt.gasPrice
    const balBefore = await provider.getBalance(operator.address, claimBlock - 1)
    const balAfter = await provider.getBalance(operator.address, claimBlock)
    assert.equal(balAfter + gas - balBefore, amount, "first claim pays out the full amount")
    assert.equal(await manager.rewardClaimed(epochId, nodeId), true)

    // Second claim of the SAME leaf must revert with AlreadyClaimed.
    await assert.rejects(
      () => manager.connect(operator).claim.staticCall(epochId, nodeId, amount, proof),
      (err: Error) => /AlreadyClaimed|reverted/i.test(err.message),
      "double-claim of the same reward leaf must revert",
    )

    // ── Reward-budget overflow: a leaf whose amount exceeds epochTotalReward.
    const { nodeId: nodeId2 } = await registerNode(ctx)
    const epoch2 = 2
    const budget = parseEther("1")
    const overAmount = parseEther("2") // leaf claims more than the epoch budget
    const leaf2 = hashRewardLeaf(epoch2, nodeId2, overAmount)
    const tree2 = buildMerkleTree([leaf2])
    // finalize epoch2 with totalReward = budget (< overAmount), root proves leaf2.
    await (await manager.finalizeEpochV2(epoch2, tree2.root, budget, 0, 0, ctx.nextNonce())).wait()
    await assert.rejects(
      () => manager.claim.staticCall(epoch2, nodeId2, overAmount, buildMerkleProof(tree2.layers, 0)),
      (err: Error) => /RewardBudgetExceeded|reverted/i.test(err.message),
      "claiming above the epoch reward budget must revert",
    )

    // ── Claim window expiry: after REWARD_CLAIM_WINDOW (7 days) claim reverts.
    const { operator: op3, nodeId: nodeId3 } = await registerNode(ctx)
    const epoch3 = 3
    const amt3 = parseEther("1")
    const leaf3 = hashRewardLeaf(epoch3, nodeId3, amt3)
    const tree3 = buildMerkleTree([leaf3])
    await (await manager.finalizeEpochV2(epoch3, tree3.root, amt3, 0, 0, ctx.nextNonce())).wait()
    // Jump past the 7-day window.
    await provider.send("evm_increaseTime", [7 * 24 * 3600 + 60])
    await provider.send("evm_mine", [])
    await assert.rejects(
      () => manager.connect(op3).claim.staticCall(epoch3, nodeId3, amt3, buildMerkleProof(tree3.layers, 0)),
      (err: Error) => /claim window expired|reverted/i.test(err.message),
      "claim after the 7-day window must revert",
    )
  } finally {
    provider?.destroy()
    await node.stop()
  }
})

// ---------------------------------------------------------------------------
//  Test 2 — Witness quorum boundary (real EIP-712 witness signatures)
// ---------------------------------------------------------------------------

// #746: witness-mode integration coverage moved to PR-2's v3 typehash suite.
// The legacy `submitBatchV2(witnessBitmap, sigs)` path signed the batch root
// with v1 typehash — exactly the rubber-stamp pattern the v3 fix retires.
// Re-implement under v3 semantics (witness signs per-receipt (challengeId,
// nodeId, responseBodyHash, resultCode) instead of the batch root) in PR-2,
// where the off-chain witness fleet learns to compute resultCode + sign v3.
test.skip("PoSe v2: witness quorum boundary — below quorum rejected, at quorum accepted (TODO: v3 witness)", { timeout: 120_000 }, async () => {
  const port = await getFreePort()
  const node = await startHardhatNode(port)
  let provider: JsonRpcProvider | null = null
  try {
    provider = new JsonRpcProvider(node.url)
    const deployer = new Wallet(DEPLOYER_KEY, provider)
    let n = await provider.getTransactionCount(deployer.address)
    const ctx: Ctx = { provider, deployer, manager: null, nextNonce: () => ({ nonce: n++ }) }
    ctx.manager = await deployManager(ctx)
    const manager = ctx.manager
    // strict mode: empty witness sets are NOT allowed when active nodes exist.
    const domainSeparator = await manager.DOMAIN_SEPARATOR()

    // Register a single node → witness set is exactly [node0], m=1, required=1.
    const { operator } = await registerNode(ctx)

    const epoch = await currentEpoch(provider) + 1
    await setEpoch(provider, epoch)
    await (await manager.initEpochNonce(epoch, ctx.nextNonce())).wait()

    const witnessSet: string[] = await manager.getWitnessSet(epoch)
    assert.equal(witnessSet.length, 1, "single active node → 1-member witness set")
    const required: bigint = await manager.getRequiredWitnessCount(epoch)
    assert.equal(required, 1n, "ceil(2*1/3) == 1")

    // Build a one-leaf batch.
    const leafHash = hashEvidenceLeafV2({
      epoch,
      nodeId: witnessSet[0]!,
      nonce: `0x${"a1".repeat(16)}`,
      tipHash: keccak256(toUtf8Bytes("tip")),
      tipHeight: 100,
      latencyMs: 50,
      resultCode: 0,
      witnessBitmap: 1,
    })
    const tree = buildMerkleTree([leafHash])
    const sampleProofs = [{ leaf: leafHash, merkleProof: buildMerkleProof(tree.layers, 0), leafIndex: 0 }]
    const summaryHash = buildSummaryHash(epoch, tree.root, sampleProofs)

    // ── Case A: bitmap below quorum (no bits) is rejected in strict mode.
    await assert.rejects(
      () => manager.submitBatchV2.staticCall(epoch, tree.root, summaryHash, sampleProofs, 0, []),
      (err: Error) => /InvalidWitnessQuorum|reverted/i.test(err.message),
      "empty witness bitmap in strict mode must revert",
    )

    // ── Case B: bitmap at quorum but signature count short → revert.
    await assert.rejects(
      () => manager.submitBatchV2.staticCall(epoch, tree.root, summaryHash, sampleProofs, 0b1, []),
      (err: Error) => /InvalidWitnessQuorum|reverted/i.test(err.message),
      "bitmap bit set without a matching signature must revert",
    )

    // ── Case C: bitmap at quorum with a FORGED signature (wrong signer) → revert.
    const stranger = Wallet.createRandom()
    const forgedSig = await stranger.signMessage(getBytes(witnessDigest(domainSeparator, tree.root, witnessSet[0]!, 0)))
    await assert.rejects(
      () => manager.submitBatchV2.staticCall(epoch, tree.root, summaryHash, sampleProofs, 0b1, [forgedSig]),
      (err: Error) => /InvalidWitnessQuorum|reverted/i.test(err.message),
      "witness signature from a non-operator must revert",
    )

    // ── Case D: bitmap at quorum with a VALID operator signature → accepted.
    // _validateWitnessQuorum recovers a raw ecrecover over the EIP-712 digest
    // (NOT the \x19Ethereum-prefixed personal_sign), so sign the digest raw.
    const validSig = operator.signingKey.sign(witnessDigest(domainSeparator, tree.root, witnessSet[0]!, 0)).serialized
    const okTx = await manager.submitBatchV2(epoch, tree.root, summaryHash, sampleProofs, 0b1, [validSig], ctx.nextNonce())
    const okReceipt = await okTx.wait()
    const batchId = await extractArg(manager, okReceipt, "BatchSubmittedV2", 1)
    assert.notEqual(batchId, ZeroHash, "batch with a valid at-quorum witness signature is accepted")
    const stored = await manager.getBatch(batchId)
    assert.equal(stored.merkleRoot, tree.root, "accepted batch is persisted with the submitted root")
  } finally {
    provider?.destroy()
    await node.stop()
  }
})

// ---------------------------------------------------------------------------
//  Test 3 — Fault-proof dispute lifecycle: invalid dispute forfeits the bond
// ---------------------------------------------------------------------------

// #746: dispute lifecycle test uses the legacy `submitBatchV2` (no metadata)
// path to set up the batch under attack. Migrate to `submitBatchV2WithMetadata`
// + v3 witness signing in PR-2 so the test exercises the v3-protected
// settlement flow end-to-end.
test.skip("PoSe v2: fault-proof dispute — invalid dispute forfeits bond, valid one slashes (TODO: migrate to v3)", { timeout: 120_000 }, async () => {
  const port = await getFreePort()
  const node = await startHardhatNode(port)
  let provider: JsonRpcProvider | null = null
  try {
    provider = new JsonRpcProvider(node.url)
    const deployer = new Wallet(DEPLOYER_KEY, provider)
    let n = await provider.getTransactionCount(deployer.address)
    const ctx: Ctx = { provider, deployer, manager: null, nextNonce: () => ({ nonce: n++ }) }
    ctx.manager = await deployManager(ctx)
    const manager = ctx.manager
    await (await manager.setAllowEmptyWitnessSubmission(true, ctx.nextNonce())).wait()
    await (await manager.setChallengeBondMin(parseEther("0.01"), ctx.nextNonce())).wait()

    const { nodeId } = await registerNode(ctx)
    const epoch = await currentEpoch(provider)

    // ── INVALID dispute: open a challenge, never reveal → settle forfeits the
    //    whole bond to the insurance fund (not a slash).
    const bond = parseEther("0.05")
    const phantomCommit = keccak256(toUtf8Bytes("phantom-commit"))
    const openTx = await manager.openChallenge(phantomCommit, { value: bond, ...ctx.nextNonce() })
    const openReceipt = await openTx.wait()
    const lostChallengeId = await extractArg(manager, openReceipt, "ChallengeOpened", 0)

    // Settling before the reveal deadline must revert (still revealable).
    await assert.rejects(
      () => manager.settleChallenge.staticCall(lostChallengeId),
      (err: Error) => /ChallengeNotRevealed|reverted/i.test(err.message),
      "settling an unrevealed challenge before its deadline must revert",
    )

    // Past the reveal window → settle moves the bond to insurance.
    await advanceEpochs(provider, 3)
    const insuranceBefore = await manager.insuranceBalance()
    await (await manager.settleChallenge(lostChallengeId, ctx.nextNonce())).wait()
    const insuranceAfter = await manager.insuranceBalance()
    assert.equal(insuranceAfter - insuranceBefore, bond, "unrevealed challenge forfeits the full bond to insurance")

    // Double-settle of the same challenge must revert.
    await assert.rejects(
      () => manager.settleChallenge.staticCall(lostChallengeId),
      (err: Error) => /ChallengeAlreadySettled|reverted/i.test(err.message),
      "settling an already-settled challenge must revert",
    )

    // ── faultType=1 (DoubleSig) must be rejected at reveal: it requires a
    //    dedicated equivocation proof, not the evidence-leaf format.
    const epoch2 = await currentEpoch(provider)
    const leafDS: EvidenceLeafV2 = {
      epoch: epoch2,
      nodeId,
      nonce: `0x${"d1".repeat(16)}`,
      tipHash: keccak256(toUtf8Bytes("ds-tip")),
      tipHeight: 200,
      latencyMs: 80,
      resultCode: 2,
      witnessBitmap: 0,
    }
    const leafHashDS = hashEvidenceLeafV2(leafDS)
    const treeDS = buildMerkleTree([leafHashDS])
    const sampleProofsDS = [{ leaf: leafHashDS, merkleProof: buildMerkleProof(treeDS.layers, 0), leafIndex: 0 }]
    const summaryDS = buildSummaryHash(epoch2, treeDS.root, sampleProofsDS)
    const submitDS = await manager.submitBatchV2(epoch2, treeDS.root, summaryDS, sampleProofsDS, 0, [], ctx.nextNonce())
    const batchIdDS = await extractArg(manager, await submitDS.wait(), "BatchSubmittedV2", 1)
    const evidenceDataDS = encodeEvidenceData(batchIdDS, buildMerkleProof(treeDS.layers, 0), leafDS)

    const saltDS = keccak256(toUtf8Bytes("ds-salt"))
    const faultTypeDS = 1
    const commitDS = computeCommitHash(nodeId, faultTypeDS, leafHashDS, saltDS)
    const chDS = await extractArg(
      manager,
      await (await manager.openChallenge(commitDS, { value: bond, ...ctx.nextNonce() })).wait(),
      "ChallengeOpened",
      0,
    )
    const digestDS = computeRevealDigest(chDS, nodeId, faultTypeDS, leafHashDS, saltDS, evidenceDataDS)
    const sigDS = await deployer.signMessage(getBytes(digestDS))
    await assert.rejects(
      () => manager.revealChallenge.staticCall(chDS, nodeId, faultTypeDS, leafHashDS, saltDS, evidenceDataDS, sigDS),
      (err: Error) => /InvalidFaultProof|reverted/i.test(err.message),
      "faultType=1 (DoubleSig) via the evidence-leaf format must revert at reveal",
    )

    // ── faultType MISMATCH: reveal a faultType=3 (Timeout) against a leaf whose
    //    resultCode is 2 (InvalidSig) → reveal reverts (objective check fails).
    const leafMM: EvidenceLeafV2 = { ...leafDS, nonce: `0x${"e2".repeat(16)}`, tipHash: keccak256(toUtf8Bytes("mm-tip")) }
    const leafHashMM = hashEvidenceLeafV2(leafMM)
    const treeMM = buildMerkleTree([leafHashMM])
    const sampleProofsMM = [{ leaf: leafHashMM, merkleProof: buildMerkleProof(treeMM.layers, 0), leafIndex: 0 }]
    const summaryMM = buildSummaryHash(epoch2, treeMM.root, sampleProofsMM)
    const submitMM = await manager.submitBatchV2(epoch2, treeMM.root, summaryMM, sampleProofsMM, 0, [], ctx.nextNonce())
    const batchIdMM = await extractArg(manager, await submitMM.wait(), "BatchSubmittedV2", 1)
    const evidenceDataMM = encodeEvidenceData(batchIdMM, buildMerkleProof(treeMM.layers, 0), leafMM)
    const saltMM = keccak256(toUtf8Bytes("mm-salt"))
    const faultTypeMM = 3 // Timeout, but leaf.resultCode == 2
    const commitMM = computeCommitHash(nodeId, faultTypeMM, leafHashMM, saltMM)
    const chMM = await extractArg(
      manager,
      await (await manager.openChallenge(commitMM, { value: bond, ...ctx.nextNonce() })).wait(),
      "ChallengeOpened",
      0,
    )
    const digestMM = computeRevealDigest(chMM, nodeId, faultTypeMM, leafHashMM, saltMM, evidenceDataMM)
    const sigMM = await deployer.signMessage(getBytes(digestMM))
    await assert.rejects(
      () => manager.revealChallenge.staticCall(chMM, nodeId, faultTypeMM, leafHashMM, saltMM, evidenceDataMM, sigMM),
      (err: Error) => /InvalidFaultProof|reverted/i.test(err.message),
      "faultType not matching the leaf resultCode must revert at reveal",
    )

    // ── VALID dispute end-to-end: faultType=2 against a resultCode=2 leaf.
    const nodeBondBefore = (await manager.getNode(nodeId)).bondAmount
    const saltOk = keccak256(toUtf8Bytes("ok-salt"))
    const faultTypeOk = 2
    const commitOk = computeCommitHash(nodeId, faultTypeOk, leafHashDS, saltOk)
    const chOk = await extractArg(
      manager,
      await (await manager.openChallenge(commitOk, { value: bond, ...ctx.nextNonce() })).wait(),
      "ChallengeOpened",
      0,
    )
    const digestOk = computeRevealDigest(chOk, nodeId, faultTypeOk, leafHashDS, saltOk, evidenceDataDS)
    const sigOk = await deployer.signMessage(getBytes(digestOk))
    await (
      await manager.revealChallenge(chOk, nodeId, faultTypeOk, leafHashDS, saltOk, evidenceDataDS, sigOk, ctx.nextNonce())
    ).wait()
    const revealed = await manager.getChallenge(chOk)
    assert.equal(revealed.revealed, true, "valid fault proof reveals successfully")

    // Settle before the adjudication window must revert.
    await assert.rejects(
      () => manager.settleChallenge.staticCall(chOk),
      (err: Error) => /AdjudicationWindowNotElapsed|reverted/i.test(err.message),
      "settling before the adjudication window must revert",
    )

    await advanceEpochs(provider, 5)
    await (await manager.settleChallenge(chOk, ctx.nextNonce())).wait()
    const nodeBondAfter = (await manager.getNode(nodeId)).bondAmount
    assert.ok(nodeBondAfter < nodeBondBefore, "a confirmed fault slashes the target node's bond")
    const settled = await manager.getChallenge(chOk)
    assert.equal(settled.settled, true, "valid challenge settles")
  } finally {
    provider?.destroy()
    await node.stop()
  }
})

// ---------------------------------------------------------------------------
//  Test 4 — Epoch finalization edge cases
// ---------------------------------------------------------------------------

test("PoSe v2: epoch finalization — early finalize and reward-pool guards", { timeout: 120_000 }, async () => {
  const port = await getFreePort()
  const node = await startHardhatNode(port)
  let provider: JsonRpcProvider | null = null
  try {
    provider = new JsonRpcProvider(node.url)
    const deployer = new Wallet(DEPLOYER_KEY, provider)
    let n = await provider.getTransactionCount(deployer.address)
    const ctx: Ctx = { provider, deployer, manager: null, nextNonce: () => ({ nonce: n++ }) }
    ctx.manager = await deployManager(ctx)
    const manager = ctx.manager
    await (await manager.setAllowEmptyWitnessSubmission(true, ctx.nextNonce())).wait()

    // ── Early finalize: the current (or too-recent) epoch is inside the
    //    dispute window → DisputeWindowNotElapsed.
    const nowEpoch = await currentEpoch(provider)
    await assert.rejects(
      () => manager.finalizeEpochV2.staticCall(nowEpoch, ZeroHash, 0, 0, 0),
      (err: Error) => /DisputeWindowNotElapsed|reverted/i.test(err.message),
      "finalizing the current epoch (inside dispute window) must revert",
    )

    // ── Empty epoch finalize: a past epoch with no batches finalizes cleanly.
    await advanceEpochs(provider, 5)
    const emptyEpoch = 1
    await (await manager.finalizeEpochV2(emptyEpoch, ZeroHash, 0, 0, 0, ctx.nextNonce())).wait()
    assert.equal(await manager.epochFinalized(emptyEpoch), true, "empty past epoch finalizes")
    assert.equal(await manager.epochRewardRoots(emptyEpoch), ZeroHash, "empty epoch has a zero reward root")
    assert.equal(await manager.epochValidBatchCount(emptyEpoch), 0n, "empty epoch records 0 valid batches")

    // ── Double finalize of the same epoch must revert.
    await assert.rejects(
      () => manager.finalizeEpochV2.staticCall(emptyEpoch, ZeroHash, 0, 0, 0),
      (err: Error) => /EpochAlreadyFinalized|reverted/i.test(err.message),
      "double-finalizing an epoch must revert",
    )

    // ── Reward-pool insufficient: finalize with totalReward > rewardPoolBalance.
    const richEpoch = 2
    const rewardRoot = keccak256(toUtf8Bytes("non-empty-root"))
    await assert.rejects(
      () => manager.finalizeEpochV2.staticCall(richEpoch, rewardRoot, parseEther("100"), 0, 0),
      (err: Error) => /RewardPoolInsufficient|reverted/i.test(err.message),
      "finalizing with a reward larger than the pool must revert",
    )

    // ── totalReward > 0 with a zero reward root must revert (InvalidBatch).
    await assert.rejects(
      () => manager.finalizeEpochV2.staticCall(richEpoch, ZeroHash, parseEther("1"), 0, 0),
      (err: Error) => /InvalidBatch|reverted/i.test(err.message),
      "a non-zero reward with a zero root must revert",
    )

    // ── Funded finalize succeeds and deducts from the reward pool.
    await (await manager.depositRewardPool({ value: parseEther("5"), ...ctx.nextNonce() })).wait()
    const poolBefore = await manager.rewardPoolBalance()
    const payout = parseEther("3")
    await (await manager.finalizeEpochV2(richEpoch, rewardRoot, payout, 0, 0, ctx.nextNonce())).wait()
    const poolAfter = await manager.rewardPoolBalance()
    assert.equal(poolBefore - poolAfter, payout, "finalize deducts the epoch reward from the pool")
    assert.equal(await manager.epochTotalReward(richEpoch), payout, "epochTotalReward records the payout")
  } finally {
    provider?.destroy()
    await node.stop()
  }
})
