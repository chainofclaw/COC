import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ChainEngine } from "./chain-engine.ts"
import { ConsensusEngine } from "./consensus.ts"
import type { SnapSyncProvider } from "./consensus.ts"
import { EvmChain } from "./evm.ts"
import { hashBlockPayload, zeroHash } from "./hash.ts"
import type { ChainBlock, ChainSnapshot, Hex } from "./blockchain-types.ts"

const NODE_ID = "node-1"

async function createTestEngine(): Promise<{ engine: ChainEngine; evm: EvmChain }> {
  const evm = await EvmChain.create(18780)
  await evm.prefund([{ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", balanceWei: "10000000000000000000000" }])
  const engine = new ChainEngine(
    { dataDir: "/tmp/coc-consensus-test-" + Date.now(), nodeId: NODE_ID, validators: [NODE_ID], finalityDepth: 3, maxTxPerBlock: 50, minGasPriceWei: 1n },
    evm,
  )
  return { engine, evm }
}

test("snapshot with forged block hash is rejected", async () => {
  const { engine: engine1 } = await createTestEngine()
  const { engine: engine2 } = await createTestEngine()

  // Build valid chain
  for (let i = 0; i < 3; i++) {
    await engine1.proposeNextBlock()
  }

  const snapshot = engine1.makeSnapshot()
  // Forge a block hash
  snapshot.blocks[1].hash = "0x" + "ff".repeat(32) as Hex

  const adopted = await engine2.maybeAdoptSnapshot(snapshot)
  assert.equal(adopted, false)
  assert.equal(engine2.getHeight(), 0n)
})

test("snapshot with broken parent chain is rejected", async () => {
  const { engine: engine1 } = await createTestEngine()
  const { engine: engine2 } = await createTestEngine()

  for (let i = 0; i < 3; i++) {
    await engine1.proposeNextBlock()
  }

  const snapshot = engine1.makeSnapshot()
  // Break parent hash link
  snapshot.blocks[2].parentHash = "0x" + "aa".repeat(32) as Hex

  const adopted = await engine2.maybeAdoptSnapshot(snapshot)
  assert.equal(adopted, false)
})

test("snapshot with wrong block number sequence is rejected", async () => {
  const { engine: engine1 } = await createTestEngine()
  const { engine: engine2 } = await createTestEngine()

  for (let i = 0; i < 3; i++) {
    await engine1.proposeNextBlock()
  }

  const snapshot = engine1.makeSnapshot()
  // Skip a block number
  snapshot.blocks[1] = { ...snapshot.blocks[1], number: 5n }

  const adopted = await engine2.maybeAdoptSnapshot(snapshot)
  assert.equal(adopted, false)
})

test("valid snapshot is accepted", async () => {
  const { engine: engine1 } = await createTestEngine()
  const { engine: engine2 } = await createTestEngine()

  for (let i = 0; i < 5; i++) {
    await engine1.proposeNextBlock()
  }

  const snapshot = engine1.makeSnapshot()
  const adopted = await engine2.maybeAdoptSnapshot(snapshot)
  assert.equal(adopted, true)
  assert.equal(engine2.getHeight(), 5n)
})

test("empty snapshot is rejected", async () => {
  const { engine } = await createTestEngine()
  const emptySnapshot: ChainSnapshot = { blocks: [], updatedAtMs: Date.now() }
  const adopted = await engine.maybeAdoptSnapshot(emptySnapshot)
  assert.equal(adopted, false)
})

describe("snap sync validation", () => {
  it("rejects state snapshot with mismatched blockHeight", async () => {
    const { engine } = await createTestEngine()

    // Build a mock P2P and snapSync provider
    const mockP2p = {
      fetchSnapshots: async () => [],
      receiveBlock: async () => {},
      discovery: { getActivePeers: () => [{ url: "http://peer1:18780" }] },
      broadcastBft: async () => {},
    }

    let fetchCalled = false
    let importCalled = false
    const mockSnapSync: SnapSyncProvider = {
      fetchStateSnapshot: async () => {
        fetchCalled = true
        return {
          stateRoot: "0x" + "ab".repeat(32),
          blockHeight: "999", // Mismatched height
          blockHash: "0x" + "cd".repeat(32),
          accounts: [],
          version: 1,
          createdAtMs: Date.now(),
        }
      },
      importStateSnapshot: async () => {
        importCalled = true
        return { accountsImported: 0, codeImported: 0 }
      },
      setStateRoot: async () => {},
    }

    const consensus = new ConsensusEngine(
      engine as any,
      mockP2p as any,
      { blockTimeMs: 1000, syncIntervalMs: 1000, enableSnapSync: true, snapSyncThreshold: 1 },
      { snapSync: mockSnapSync },
    )

    // Directly test trySnapSync via the internal method path
    // Create a snapshot with a tip block that doesn't match
    const tipBlock = {
      number: 100n,
      hash: ("0x" + "ee".repeat(32)) as Hex,
      parentHash: ("0x" + "00".repeat(32)) as Hex,
      proposer: "node1",
      timestampMs: Date.now(),
      txs: [],
      finalized: false,
    }

    // Access private method for testing
    const result = await (consensus as any).trySnapSync({ blocks: [tipBlock] })
    assert.equal(fetchCalled, true)
    assert.equal(importCalled, false, "should not import when blockHeight mismatches")
    assert.equal(result, false)
  })
})

test("blocks include baseFee computed from parent", async () => {
  const { engine } = await createTestEngine()

  const b1 = await engine.proposeNextBlock()
  assert.ok(b1)
  assert.ok(b1.baseFee !== undefined, "block should have baseFee")
  assert.ok(b1.baseFee > 0n, "baseFee should be positive")

  const b2 = await engine.proposeNextBlock()
  assert.ok(b2)
  assert.ok(b2.baseFee !== undefined, "second block should have baseFee")
  // With no gas used, baseFee should decrease (or stay at floor)
  assert.ok(b2.baseFee <= b1.baseFee, "baseFee should not increase with zero gas")
})

test("enforce mode rejects block without signature", async () => {
  const evm = await EvmChain.create(18780)
  const engine = new ChainEngine(
    {
      dataDir: "/tmp/coc-sig-test-" + Date.now(),
      nodeId: NODE_ID,
      validators: [NODE_ID],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      signatureEnforcement: "enforce",
    },
    evm,
  )

  // Create a signer for the verifier
  const { createNodeSigner } = await import("./crypto/signer.ts")
  const signer = createNodeSigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
  engine.setNodeSigner(signer, signer)

  // Propose a block (locally proposed — bypasses sig check)
  const block = await engine.proposeNextBlock()
  assert.ok(block)

  // Build an unsigned block for remote apply
  const { hashBlockPayload } = await import("./hash.ts")
  const unsignedBlock = {
    number: 2n,
    parentHash: block.hash,
    proposer: NODE_ID,
    timestampMs: Date.now(),
    txs: [] as string[],
    finalized: false,
  }
  const hash = hashBlockPayload(unsignedBlock)

  await assert.rejects(
    () => engine.applyBlock({ ...unsignedBlock, hash } as any, false),
    /block missing proposer signature/,
  )
})

test("proposer produces blocks in round-robin", async () => {
  const evm1 = await EvmChain.create(18780)
  const engine1 = new ChainEngine(
    { dataDir: "/tmp/coc-consensus-rr-" + Date.now(), nodeId: "v1", validators: ["v1", "v2"], finalityDepth: 3, maxTxPerBlock: 50, minGasPriceWei: 1n },
    evm1,
  )

  // v1 should propose block 1
  const b1 = await engine1.proposeNextBlock()
  assert.ok(b1)
  assert.equal(b1.proposer, "v1")

  // v1 should NOT propose block 2 (it's v2's turn)
  const b2 = await engine1.proposeNextBlock()
  assert.equal(b2, null)
})
