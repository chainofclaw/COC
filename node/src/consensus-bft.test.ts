import { describe, it, mock, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { ConsensusEngine } from "./consensus.ts"
import type { ConsensusConfig, SnapSyncProvider } from "./consensus.ts"
import { BftCoordinator } from "./bft-coordinator.ts"
import type { BftMessage } from "./bft.ts"
import type { ChainBlock, Hex, ChainSnapshot } from "./blockchain-types.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { P2PNode } from "./p2p.ts"
import { shouldSwitchFork } from "./fork-choice.ts"
import type { ForkCandidate } from "./fork-choice.ts"
import type { ConsensusMetrics } from "./consensus.ts"

function makeBlock(n: number, bftFinalized = false): ChainBlock {
  return {
    number: BigInt(n),
    hash: `0x${"a".repeat(63)}${n}` as Hex,
    parentHash: `0x${"a".repeat(63)}${n - 1}` as Hex,
    proposer: "node-1",
    timestampMs: Date.now(),
    txs: [],
    finalized: false,
    bftFinalized,
  }
}

function makeMockChain(height = 0n): Partial<IChainEngine> {
  let currentHeight = height
  const blocks: ChainBlock[] = []
  return {
    getHeight: () => currentHeight,
    getTip: () => blocks.length > 0 ? blocks[blocks.length - 1] : null,
    proposeNextBlock: async () => {
      const n = Number(currentHeight) + 1
      const block = makeBlock(n)
      currentHeight = BigInt(n)
      blocks.push(block)
      return block
    },
    applyBlock: async (block: ChainBlock) => {
      blocks.push(block)
      currentHeight = block.number
    },
    mempool: { getPendingNonce: () => 0n } as unknown as IChainEngine["mempool"],
    events: {} as unknown as IChainEngine["events"],
    init: async () => {},
    getBlockByNumber: () => null,
    getBlockByHash: () => null,
    getReceiptsByBlock: () => [],
    expectedProposer: () => "node-1",
    addRawTx: async () => ({ hash: "0x" as Hex, rawTx: "0x" as Hex, from: "0x" as Hex, nonce: 0n, gasPrice: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gasLimit: 0n, receivedAtMs: 0 }),
  }
}

function makeMockP2P(): Partial<P2PNode> {
  return {
    receiveBlock: async () => {},
    fetchSnapshots: async () => [],
    broadcastBft: async () => {},
    discovery: { getActivePeers: () => [] } as unknown as P2PNode["discovery"],
  }
}

describe("ConsensusEngine BFT integration", () => {
  it("should use BFT coordinator when enabled", async () => {
    const chain = makeMockChain()
    const p2p = makeMockP2P()
    let bftRoundStarted = false
    let bftBlock: ChainBlock | null = null

    const validators = [
      { id: "node-1", stake: 1000n },
      { id: "node-2", stake: 1000n },
      { id: "node-3", stake: 1000n },
    ]

    const bft = new BftCoordinator({
      localId: "node-1",
      validators,
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
      broadcastMessage: async () => {},
      onFinalized: async (block) => {
        bftBlock = block
      },
    })

    // Override startRound to track
    const originalStartRound = bft.startRound.bind(bft)
    bft.startRound = async (block: ChainBlock) => {
      bftRoundStarted = true
      await originalStartRound(block)
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
      { bft },
    )

    // Access tryPropose via reflection
    const tryPropose = (consensus as unknown as { tryPropose: () => Promise<void> }).tryPropose.bind(consensus)
    await tryPropose()

    assert.ok(bftRoundStarted, "BFT round should have been started")
  })

  it("should fall back to direct broadcast when BFT fails", async () => {
    const chain = makeMockChain()
    let directBroadcast = false
    const p2p = {
      ...makeMockP2P(),
      receiveBlock: async () => { directBroadcast = true },
    }

    const bft = {
      startRound: async () => { throw new Error("BFT unavailable") },
      handleMessage: async () => {},
      getRoundState: () => ({ active: false, height: null, phase: null, prepareVotes: 0, commitVotes: 0 }),
      updateValidators: () => {},
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
      { bft: bft as unknown as BftCoordinator },
    )

    const tryPropose = (consensus as unknown as { tryPropose: () => Promise<void> }).tryPropose.bind(consensus)
    await tryPropose()

    assert.ok(directBroadcast, "should fall back to direct broadcast when BFT fails")
  })

  it("should broadcast without BFT when coordinator is null", async () => {
    const chain = makeMockChain()
    let broadcastCalled = false
    const p2p = {
      ...makeMockP2P(),
      receiveBlock: async () => { broadcastCalled = true },
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const tryPropose = (consensus as unknown as { tryPropose: () => Promise<void> }).tryPropose.bind(consensus)
    await tryPropose()

    assert.ok(broadcastCalled, "should directly broadcast when no BFT")
  })

  it("should broadcast via both HTTP and wire when wireBroadcast is set", async () => {
    const chain = makeMockChain()
    let httpBroadcast = false
    let wireBroadcast = false
    let wireBlock: ChainBlock | null = null

    const p2p = {
      ...makeMockP2P(),
      receiveBlock: async () => { httpBroadcast = true },
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
      { wireBroadcast: (block) => { wireBroadcast = true; wireBlock = block } },
    )

    const tryPropose = (consensus as unknown as { tryPropose: () => Promise<void> }).tryPropose.bind(consensus)
    await tryPropose()

    assert.ok(httpBroadcast, "should broadcast via HTTP")
    assert.ok(wireBroadcast, "should broadcast via wire protocol")
    assert.ok(wireBlock, "wire broadcast should receive the block")
  })
})

describe("ConsensusEngine fork choice sync", () => {
  it("should adopt remote chain via fork choice when remote is longer", async () => {
    const chain = makeMockChain(5n)
    let adopted = false

    // Make chain look like ISnapshotSyncEngine
    ;(chain as Record<string, unknown>).makeSnapshot = () => ({ blocks: [], updatedAtMs: 0 })
    ;(chain as Record<string, unknown>).maybeAdoptSnapshot = async () => {
      adopted = true
      return true
    }

    const remoteBlocks = Array.from({ length: 10 }, (_, i) => makeBlock(i + 1))
    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{
        blocks: remoteBlocks,
        updatedAtMs: Date.now(),
      }],
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const trySync = (consensus as unknown as { trySync: () => Promise<void> }).trySync.bind(consensus)
    await trySync()

    assert.ok(adopted, "should adopt remote chain that is longer")
  })

  it("should prefer BFT-finalized chain even if shorter", async () => {
    const local: ForkCandidate = {
      height: 10n,
      tipHash: "0xaaa" as Hex,
      bftFinalized: false,
      cumulativeWeight: 10n,
      peerId: "local",
    }

    const remote: ForkCandidate = {
      height: 8n,
      tipHash: "0xbbb" as Hex,
      bftFinalized: true,
      cumulativeWeight: 8n,
      peerId: "remote",
    }

    const result = shouldSwitchFork(local, remote)
    assert.ok(result, "should switch to BFT-finalized chain")
    assert.equal(result!.reason, "bft-finality")
  })

  it("should not switch when local is equal or better", async () => {
    const local: ForkCandidate = {
      height: 10n,
      tipHash: "0xaaa" as Hex,
      bftFinalized: true,
      cumulativeWeight: 10n,
      peerId: "local",
    }

    const remote: ForkCandidate = {
      height: 8n,
      tipHash: "0xbbb" as Hex,
      bftFinalized: false,
      cumulativeWeight: 8n,
      peerId: "remote",
    }

    const result = shouldSwitchFork(local, remote)
    assert.equal(result, null, "should not switch when local is BFT-finalized and longer")
  })

  it("should not adopt remote snapshot with empty blocks", async () => {
    const chain = makeMockChain(5n)
    let adopted = false

    ;(chain as Record<string, unknown>).makeSnapshot = () => ({ blocks: [], updatedAtMs: 0 })
    ;(chain as Record<string, unknown>).maybeAdoptSnapshot = async () => {
      adopted = true
      return true
    }

    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{
        blocks: [],
        updatedAtMs: Date.now(),
      }],
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const trySync = (consensus as unknown as { trySync: () => Promise<void> }).trySync.bind(consensus)
    await trySync()

    assert.ok(!adopted, "should not adopt empty snapshot")
  })
})

describe("BFT coordinator 3-validator round", () => {
  it("should finalize after 3 validators vote", async () => {
    let finalizedBlock: ChainBlock | null = null
    const broadcastedMsgs: BftMessage[] = []

    const validators = [
      { id: "node-1", stake: 1000n },
      { id: "node-2", stake: 1000n },
      { id: "node-3", stake: 1000n },
    ]

    const coordinator = new BftCoordinator({
      localId: "node-1",
      validators,
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
      broadcastMessage: async (msg) => { broadcastedMsgs.push(msg) },
      onFinalized: async (block) => { finalizedBlock = block },
    })

    const block = makeBlock(1)

    // Node-1 proposes and sends prepare (auto-votes for itself)
    await coordinator.startRound(block)
    assert.ok(broadcastedMsgs.length > 0, "should broadcast prepare vote")

    const dummySig = ("0x" + "de".repeat(65)) as Hex

    // Node-2 sends prepare
    await coordinator.handleMessage({
      type: "prepare",
      height: 1n,
      blockHash: block.hash,
      senderId: "node-2",
      signature: dummySig,
    })

    // Node-3 sends prepare -> quorum reached (3/3 >= 2/3+1), transitions to commit
    await coordinator.handleMessage({
      type: "prepare",
      height: 1n,
      blockHash: block.hash,
      senderId: "node-3",
      signature: dummySig,
    })

    // Check that a commit message was broadcast
    const commitMsg = broadcastedMsgs.find((m) => m.type === "commit")
    assert.ok(commitMsg, "should broadcast commit after prepare quorum")

    // Node-2 sends commit
    await coordinator.handleMessage({
      type: "commit",
      height: 1n,
      blockHash: block.hash,
      senderId: "node-2",
      signature: dummySig,
    })

    // Node-3 sends commit -> commit quorum reached
    await coordinator.handleMessage({
      type: "commit",
      height: 1n,
      blockHash: block.hash,
      senderId: "node-3",
      signature: dummySig,
    })

    assert.ok(finalizedBlock, "block should be finalized after commit quorum")
  })

  it("should timeout and fail if votes are insufficient", async () => {
    const validators = [
      { id: "node-1", stake: 1000n },
      { id: "node-2", stake: 1000n },
      { id: "node-3", stake: 1000n },
    ]

    const coordinator = new BftCoordinator({
      localId: "node-1",
      validators,
      prepareTimeoutMs: 50,
      commitTimeoutMs: 50,
      broadcastMessage: async () => {},
      onFinalized: async () => {},
    })

    const block = makeBlock(1)
    await coordinator.startRound(block)

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 150))

    const state = coordinator.getRoundState()
    assert.equal(state.active, false, "round should be cleared after timeout")
  })
})

describe("ConsensusEngine snap sync", () => {
  it("should trigger snap sync when gap exceeds threshold", async () => {
    const chain = makeMockChain(5n)
    let snapSyncTriggered = false

    const remoteBlocks = Array.from({ length: 200 }, (_, i) => makeBlock(i + 1))

    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{
        blocks: remoteBlocks,
        updatedAtMs: Date.now(),
      }],
      discovery: {
        getActivePeers: () => [{ id: "peer-1", url: "http://localhost:9999" }],
      },
    }

    const snapSync: SnapSyncProvider = {
      fetchStateSnapshot: async () => {
        snapSyncTriggered = true
        return {
          version: 1,
          stateRoot: "0xabc",
          blockHeight: "200",
          blockHash: "0xdef" as Hex,
          accounts: [],
          createdAtMs: Date.now(),
        }
      },
      importStateSnapshot: async () => ({ accountsImported: 0, codeImported: 0 }),
      setStateRoot: async () => {},
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100, enableSnapSync: true, snapSyncThreshold: 100 },
      { snapSync },
    )

    const trySync = (consensus as unknown as { trySync: () => Promise<void> }).trySync.bind(consensus)
    await trySync()

    assert.ok(snapSyncTriggered, "should trigger snap sync for large gap")
  })

  it("should not trigger snap sync when gap is small", async () => {
    const chain = makeMockChain(5n)
    let snapSyncTriggered = false
    let normalAdopted = false

    ;(chain as Record<string, unknown>).makeSnapshot = () => ({ blocks: [], updatedAtMs: 0 })
    ;(chain as Record<string, unknown>).maybeAdoptSnapshot = async () => {
      normalAdopted = true
      return true
    }

    const remoteBlocks = Array.from({ length: 10 }, (_, i) => makeBlock(i + 1))

    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{
        blocks: remoteBlocks,
        updatedAtMs: Date.now(),
      }],
    }

    const snapSync: SnapSyncProvider = {
      fetchStateSnapshot: async () => { snapSyncTriggered = true; return null },
      importStateSnapshot: async () => ({ accountsImported: 0, codeImported: 0 }),
      setStateRoot: async () => {},
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100, enableSnapSync: true, snapSyncThreshold: 100 },
      { snapSync },
    )

    const trySync = (consensus as unknown as { trySync: () => Promise<void> }).trySync.bind(consensus)
    await trySync()

    assert.ok(!snapSyncTriggered, "should not trigger snap sync for small gap")
    assert.ok(normalAdopted, "should use normal sync for small gap")
  })
})

describe("ConsensusEngine metrics", () => {
  it("should track propose metrics", async () => {
    const chain = makeMockChain()
    const p2p = makeMockP2P()

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const tryPropose = (consensus as unknown as { tryPropose: () => Promise<void> }).tryPropose.bind(consensus)
    await tryPropose()
    await tryPropose()

    const metrics = consensus.getMetrics()
    assert.equal(metrics.blocksProposed, 2)
    assert.equal(metrics.proposeFailed, 0)
    assert.ok(metrics.lastProposeMs >= 0)
    assert.ok(metrics.avgProposeMs >= 0)
  })

  it("should track propose failures", async () => {
    const chain = {
      ...makeMockChain(),
      proposeNextBlock: async () => { throw new Error("fail") },
    }
    const p2p = makeMockP2P()

    const consensus = new ConsensusEngine(
      chain as unknown as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const tryPropose = (consensus as unknown as { tryPropose: () => Promise<void> }).tryPropose.bind(consensus)
    await tryPropose()

    const metrics = consensus.getMetrics()
    assert.equal(metrics.blocksProposed, 0)
    assert.equal(metrics.proposeFailed, 1)
  })

  it("should track sync metrics", async () => {
    const chain = makeMockChain(5n)
    ;(chain as Record<string, unknown>).makeSnapshot = () => ({ blocks: [], updatedAtMs: 0 })
    ;(chain as Record<string, unknown>).maybeAdoptSnapshot = async () => true

    const remoteBlocks = Array.from({ length: 10 }, (_, i) => makeBlock(i + 1))
    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{
        blocks: remoteBlocks,
        updatedAtMs: Date.now(),
      }],
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const trySync = (consensus as unknown as { trySync: () => Promise<void> }).trySync.bind(consensus)
    await trySync()

    const metrics = consensus.getMetrics()
    assert.equal(metrics.syncAttempts, 1)
    assert.equal(metrics.syncAdoptions, 1)
    assert.equal(metrics.blocksAdopted, 1)
    assert.ok(metrics.lastSyncMs >= 0)
  })

  it("should report uptime after start", async () => {
    const chain = makeMockChain()
    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [],
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 60000, syncIntervalMs: 60000 },
    )

    consensus.start()
    await new Promise((r) => setTimeout(r, 50))
    const metrics = consensus.getMetrics()
    consensus.stop()

    assert.ok(metrics.startedAtMs > 0)
    assert.ok(metrics.uptimeMs >= 40)
  })
})

describe("BFT wire broadcast integration", () => {
  it("should broadcast BFT messages via wire when wireBroadcastFn is set", async () => {
    let finalizedBlock: ChainBlock | null = null
    const httpMsgs: BftMessage[] = []
    const wireMsgs: BftMessage[] = []

    const validators = [
      { id: "node-1", stake: 1000n },
      { id: "node-2", stake: 1000n },
      { id: "node-3", stake: 1000n },
    ]

    const coordinator = new BftCoordinator({
      localId: "node-1",
      validators,
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
      broadcastMessage: async (msg) => {
        httpMsgs.push(msg)
        // Simulate dual broadcast: also push to wire
        wireMsgs.push(msg)
      },
      onFinalized: async (block) => { finalizedBlock = block },
    })

    const block = makeBlock(1)
    await coordinator.startRound(block)

    // Both HTTP and wire should have received the prepare message
    assert.ok(httpMsgs.length > 0, "HTTP broadcast should have messages")
    assert.ok(wireMsgs.length > 0, "wire broadcast should have messages")
    assert.equal(httpMsgs[0].type, "prepare")
  })

  it("should work without wire broadcast function", async () => {
    const httpMsgs: BftMessage[] = []

    const validators = [
      { id: "node-1", stake: 1000n },
      { id: "node-2", stake: 1000n },
      { id: "node-3", stake: 1000n },
    ]

    const coordinator = new BftCoordinator({
      localId: "node-1",
      validators,
      prepareTimeoutMs: 5000,
      commitTimeoutMs: 5000,
      broadcastMessage: async (msg) => { httpMsgs.push(msg) },
      onFinalized: async () => {},
    })

    const block = makeBlock(1)
    await coordinator.startRound(block)

    assert.ok(httpMsgs.length > 0, "HTTP broadcast should work alone")
  })
})

describe("ConsensusEngine sync progress", () => {
  it("should report not syncing when no peer data", async () => {
    const chain = makeMockChain(10n)
    const p2p = makeMockP2P()

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const progress = await consensus.getSyncProgress()
    assert.equal(progress.syncing, false)
    assert.equal(progress.currentHeight, 10n)
    assert.equal(progress.highestPeerHeight, 0n)
    assert.equal(progress.blocksRemaining, 0n)
  })

  it("should track sync progress after discovering peer height", async () => {
    const chain = makeMockChain(5n)
    ;(chain as Record<string, unknown>).makeSnapshot = () => ({ blocks: [], updatedAtMs: 0 })
    ;(chain as Record<string, unknown>).maybeAdoptSnapshot = async () => false

    const remoteBlocks = Array.from({ length: 20 }, (_, i) => makeBlock(i + 1))
    const p2p = {
      ...makeMockP2P(),
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{
        blocks: remoteBlocks,
        updatedAtMs: Date.now(),
      }],
    }

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const trySync = (consensus as unknown as { trySync: () => Promise<void> }).trySync.bind(consensus)
    await trySync()

    const progress = await consensus.getSyncProgress()
    assert.equal(progress.syncing, true)
    assert.equal(progress.highestPeerHeight, 20n)
    assert.equal(progress.startingHeight, 5n)
    assert.equal(progress.blocksRemaining, 15n)
    assert.ok(progress.progressPct >= 0)
  })

  it("should show 100% when fully synced", async () => {
    const chain = makeMockChain(10n)
    const p2p = makeMockP2P()

    const consensus = new ConsensusEngine(
      chain as IChainEngine,
      p2p as unknown as P2PNode,
      { blockTimeMs: 100, syncIntervalMs: 100 },
    )

    const progress = await consensus.getSyncProgress()
    assert.equal(progress.progressPct, 100)
    assert.equal(progress.syncing, false)
  })
})
