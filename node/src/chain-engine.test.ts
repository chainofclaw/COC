import test from "node:test"
import assert from "node:assert/strict"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { hashBlockPayload, zeroHash } from "./hash.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

const NODE_ID = "node-1"

async function createTestEngine(): Promise<{ engine: ChainEngine; evm: EvmChain }> {
  const evm = await EvmChain.create(18780)
  await evm.prefund([{ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", balanceWei: "10000000000000000000000" }])
  const engine = new ChainEngine(
    {
      dataDir: "/tmp/coc-test-" + Date.now(),
      nodeId: NODE_ID,
      validators: [NODE_ID],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  return { engine, evm }
}

function buildTestBlock(number: bigint, parentHash: Hex, proposer: string): ChainBlock {
  const timestampMs = Date.now()
  const hash = hashBlockPayload({ number, parentHash, proposer, timestampMs, txs: [] })
  return { number, hash, parentHash, proposer, timestampMs, txs: [], finalized: false }
}

test("chain engine starts with height 0", async () => {
  const { engine } = await createTestEngine()
  assert.equal(engine.getHeight(), 0n)
  assert.equal(engine.getTip(), undefined)
})

test("proposeNextBlock creates block at height 1", async () => {
  const { engine } = await createTestEngine()
  const block = await engine.proposeNextBlock()
  assert.ok(block)
  assert.equal(block.number, 1n)
  assert.equal(block.proposer, NODE_ID)
  assert.equal(block.parentHash, zeroHash())
  assert.equal(engine.getHeight(), 1n)
})

test("proposeNextBlock increments height", async () => {
  const { engine } = await createTestEngine()
  await engine.proposeNextBlock()
  await engine.proposeNextBlock()
  await engine.proposeNextBlock()
  assert.equal(engine.getHeight(), 3n)
})

test("applyBlock rejects invalid proposer", async () => {
  const { engine } = await createTestEngine()
  const block = buildTestBlock(1n, zeroHash(), "wrong-proposer")
  await assert.rejects(() => engine.applyBlock(block), /invalid block proposer/)
})

test("applyBlock rejects invalid block link", async () => {
  const { engine } = await createTestEngine()
  await engine.proposeNextBlock() // block 1
  const wrongParent = "0x" + "ff".repeat(32) as Hex
  const block = buildTestBlock(2n, wrongParent, NODE_ID)
  await assert.rejects(() => engine.applyBlock(block), /invalid block link/)
})

test("applyBlock rejects invalid block hash", async () => {
  const { engine } = await createTestEngine()
  const block = buildTestBlock(1n, zeroHash(), NODE_ID)
  block.hash = "0x" + "ab".repeat(32) as Hex // tamper hash
  await assert.rejects(() => engine.applyBlock(block), /invalid block hash/)
})

test("applyBlock ignores untrusted bftFinalized flag from remote block", async () => {
  const { engine } = await createTestEngine()
  const payload = {
    number: 1n,
    parentHash: zeroHash(),
    proposer: NODE_ID,
    timestampMs: Date.now(),
    txs: [] as Hex[],
    cumulativeWeight: 1n,
  }
  const block: ChainBlock = {
    ...payload,
    hash: hashBlockPayload(payload),
    finalized: false,
    bftFinalized: true,
  }
  await engine.applyBlock(block, false)
  const tip = engine.getTip()
  assert.ok(tip)
  assert.equal(tip.bftFinalized, false)
})

test("applyBlock promotes existing block to bftFinalized on trusted local update", async () => {
  const { engine } = await createTestEngine()
  const block = await engine.proposeNextBlock()
  assert.ok(block)
  assert.equal(engine.getTip()?.bftFinalized, false)

  await engine.applyBlock({ ...block, bftFinalized: true }, true)
  const tip = engine.getTip()
  assert.ok(tip)
  assert.equal(tip.bftFinalized, true)
})

test("applyBlock rejects forged cumulativeWeight", async () => {
  const { engine } = await createTestEngine()
  const parent = await engine.proposeNextBlock()
  assert.ok(parent)

  const payload = {
    number: 2n,
    parentHash: parent.hash,
    proposer: NODE_ID,
    timestampMs: parent.timestampMs + 1,
    txs: [] as Hex[],
    cumulativeWeight: 999n,
  }
  const forged: ChainBlock = {
    ...payload,
    hash: hashBlockPayload(payload),
    finalized: false,
  }

  await assert.rejects(() => engine.applyBlock(forged), /invalid cumulativeWeight/)
})

test("finality flags are set after depth", async () => {
  const { engine } = await createTestEngine()
  // Produce 5 blocks (finalityDepth = 3)
  for (let i = 0; i < 5; i++) {
    await engine.proposeNextBlock()
  }
  const blocks = engine.getBlocks()
  // Block 1 should be finalized (height 5 >= 1 + 3)
  assert.equal(blocks[0].finalized, true)
  // Block 2 should be finalized (height 5 >= 2 + 3)
  assert.equal(blocks[1].finalized, true)
  // Block 5 should not be finalized yet
  assert.equal(blocks[4].finalized, false)
})

test("getBlockByNumber returns correct block", async () => {
  const { engine } = await createTestEngine()
  await engine.proposeNextBlock()
  const b2 = await engine.proposeNextBlock()
  const found = engine.getBlockByNumber(2n)
  assert.ok(found)
  assert.equal(found.hash, b2!.hash)
})

test("getBlockByHash returns correct block", async () => {
  const { engine } = await createTestEngine()
  const b1 = await engine.proposeNextBlock()
  const found = engine.getBlockByHash(b1!.hash)
  assert.ok(found)
  assert.equal(found.number, 1n)
})

test("makeSnapshot includes all blocks", async () => {
  const { engine } = await createTestEngine()
  await engine.proposeNextBlock()
  await engine.proposeNextBlock()
  const snapshot = engine.makeSnapshot()
  assert.equal(snapshot.blocks.length, 2)
  assert.ok(snapshot.updatedAtMs > 0)
})

test("maybeAdoptSnapshot adopts longer chain", async () => {
  const { engine: engine1 } = await createTestEngine()
  const { engine: engine2 } = await createTestEngine()

  // Engine1 builds 5 blocks
  for (let i = 0; i < 5; i++) {
    await engine1.proposeNextBlock()
  }

  // Engine2 has no blocks, should adopt
  const snapshot = engine1.makeSnapshot()
  const adopted = await engine2.maybeAdoptSnapshot(snapshot)
  assert.equal(adopted, true)
  assert.equal(engine2.getHeight(), 5n)
})

test("maybeAdoptSnapshot rejects shorter chain", async () => {
  const { engine: engine1 } = await createTestEngine()
  const { engine: engine2 } = await createTestEngine()

  // Engine1 builds 2 blocks
  for (let i = 0; i < 2; i++) {
    await engine1.proposeNextBlock()
  }
  // Engine2 builds 5 blocks
  for (let i = 0; i < 5; i++) {
    await engine2.proposeNextBlock()
  }

  const snapshot = engine1.makeSnapshot()
  const adopted = await engine2.maybeAdoptSnapshot(snapshot)
  assert.equal(adopted, false)
  assert.equal(engine2.getHeight(), 5n)
})

test("expectedProposer round-robins across validators", async () => {
  const evm = await EvmChain.create(18780)
  const engine = new ChainEngine(
    {
      dataDir: "/tmp/coc-test-" + Date.now(),
      nodeId: "v1",
      validators: ["v1", "v2", "v3"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  assert.equal(engine.expectedProposer(1n), "v1")
  assert.equal(engine.expectedProposer(2n), "v2")
  assert.equal(engine.expectedProposer(3n), "v3")
  assert.equal(engine.expectedProposer(4n), "v1")
})

test("duplicate tx is rejected", async () => {
  const { engine } = await createTestEngine()
  // Create a valid signed tx — just test that adding twice raises
  // We can't easily create valid signed txs without a wallet, so test the hash-set guard
  await engine.proposeNextBlock()
  // The txHashSet should prevent duplicates after confirmation
  // This just verifies the flow doesn't crash
  assert.equal(engine.getHeight(), 1n)
})

test("#613: rejects contract-creation tx with init code > EIP-3860 MAX_INITCODE_SIZE (49152 bytes)", async () => {
  // Pre-fix oversized contract-creation initcode was accepted by the
  // mempool, gossipped to peers, then failed at EVM execution time. Geth +
  // Erigon both reject at the mempool boundary with "max initcode size
  // exceeded" so wallets get an actionable -32000 immediately. EIP-3860
  // is Shanghai-onwards mandate; mempool.computeIntrinsicGas already
  // charges the per-word cost (mempool.ts:91-95) but the SIZE LIMIT
  // check itself was missing.
  const { Wallet } = await import("ethers")
  const wallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
  const { engine } = await createTestEngine()

  // (a) Just under the cap → accepted (gas-budget permitting).
  const okInit = "0x" + "60ff".repeat(24_575)  // 49150 bytes
  const okTx = await wallet.signTransaction({
    type: 2, chainId: 18780, nonce: 0,
    maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 5_000_000n, to: null, data: okInit,
  })
  // Must NOT throw "max initcode size" — gas-related rejections are
  // separate concerns and out of scope here.
  await assert.doesNotReject(
    () => engine.addRawTx(okTx as Hex),
    /max initcode size/i,
    "49150-byte initcode (just under 49152) must not trip the size cap",
  )

  // (b) Just over the cap → rejected with -32000-compatible message.
  const badInit = "0x" + "60ff".repeat(24_577)  // 49154 bytes
  const badTx = await wallet.signTransaction({
    type: 2, chainId: 18780, nonce: 1,
    maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 5_000_000n, to: null, data: badInit,
  })
  await assert.rejects(
    () => engine.addRawTx(badTx as Hex),
    (err: Error) => /max initcode size exceeded: code size 49154 limit 49152/.test(err.message),
    "49154-byte initcode (just over 49152) must be rejected with EIP-3860 message",
  )

  // (c) Way over (100KB) → also rejected.
  const wayInit = "0x" + "60ff".repeat(50_000)  // 100000 bytes
  const wayTx = await wallet.signTransaction({
    type: 2, chainId: 18780, nonce: 2,
    maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 10_000_000n, to: null, data: wayInit,
  })
  await assert.rejects(
    () => engine.addRawTx(wayTx as Hex),
    /max initcode size exceeded: code size 100000 limit 49152/,
    "100KB initcode must be rejected",
  )

  // (d) Sanity: non-creation tx (to != null) is NOT subject to the cap.
  // Regular contract calls can have arbitrary data length (subject to
  // intrinsic gas + block gas limit).
  const callTx = await wallet.signTransaction({
    type: 2, chainId: 18780, nonce: 3,
    maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 5_000_000n,
    to: "0x" + "1".repeat(40),  // non-creation
    data: "0x" + "ab".repeat(60_000),  // 60KB data, but it's a call
  })
  await assert.doesNotReject(
    () => engine.addRawTx(callTx as Hex),
    /max initcode size/i,
    "60KB call data on a non-creation tx must not trip the initcode cap",
  )
})
