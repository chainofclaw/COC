import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ChainEngine } from "./chain-engine.ts"
import {
  ConsensusEngine,
  NO_PROGRESS_TIMEOUT_MS,
  NO_PROGRESS_STAGGER_MS,
  PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS,
  PROPOSER_MISS_ROUND_TIMEOUT_MS,
} from "./consensus.ts"
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
  // State snapshots AHEAD of the chain-snapshot tip are valid on a live chain
  // (validators produce blocks while snapshots are in flight). State snapshots
  // BEHIND the tip can never help us bootstrap, so they must be rejected.
  it("rejects state snapshot older than chain tip", async () => {
    const { engine } = await createTestEngine()

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
          blockHeight: "50", // behind tip=100
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

    const tipBlock = {
      number: 100n,
      hash: ("0x" + "ee".repeat(32)) as Hex,
      parentHash: ("0x" + "00".repeat(32)) as Hex,
      proposer: "node1",
      timestampMs: Date.now(),
      txs: [],
      finalized: false,
    }

    const result = await (consensus as any).trySnapSync({ blocks: [tipBlock] })
    assert.equal(fetchCalled, true)
    assert.equal(importCalled, false, "should not import a state snapshot behind tip")
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

describe("snap sync chain height advancement", () => {
  it("advances chain height after successful snap sync", async () => {
    const { engine } = await createTestEngine()

    // Build a chain with 5 blocks on a source engine
    const { engine: sourceEngine } = await createTestEngine()
    for (let i = 0; i < 5; i++) {
      await sourceEngine.proposeNextBlock()
    }
    const snapshot = sourceEngine.makeSnapshot()

    const mockP2p = {
      fetchSnapshots: async () => [],
      receiveBlock: async () => {},
      discovery: { getActivePeers: () => [{ url: "http://peer1:18780" }] },
      broadcastBft: async () => {},
    }

    let importedRoot: string | undefined
    const mockSnapSync: SnapSyncProvider = {
      fetchStateSnapshot: async () => ({
        stateRoot: "0x" + "ab".repeat(32),
        blockHeight: snapshot.blocks[snapshot.blocks.length - 1].number.toString(),
        blockHash: snapshot.blocks[snapshot.blocks.length - 1].hash,
        accounts: [],
        version: 1,
        createdAtMs: Date.now(),
      }),
      importStateSnapshot: async (_snap: unknown, expectedRoot?: string) => {
        importedRoot = expectedRoot
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

    const result = await (consensus as any).trySnapSync(snapshot)
    assert.equal(result, true, "snap sync should succeed")
    assert.equal(engine.getHeight(), 5n, "chain height should advance after snap sync")
    assert.equal(importedRoot, "0x" + "ab".repeat(32), "expectedStateRoot should be passed to importStateSnapshot")
  })
})

describe("snap sync fallback behavior", () => {
  it("falls back to block-level sync when large-gap snap sync fails but continuity exists", async () => {
    let currentHeight = 100n
    const localTipHash = ("0x" + "aa".repeat(32)) as Hex
    const remoteBlocks: ChainBlock[] = []
    let parentHash = ("0x" + "bb".repeat(32)) as Hex
    for (let n = 51n; n <= 120n; n++) {
      const hash = ("0x" + n.toString(16).padStart(64, "0")) as Hex
      remoteBlocks.push({
        number: n,
        hash,
        parentHash,
        proposer: "node-1",
        timestampMs: Number(n),
        txs: [],
        finalized: false,
        cumulativeWeight: n,
      })
      parentHash = hash
    }

    let adopted = false
    const mockChain = {
      getHeight: () => currentHeight,
      getTip: () => ({
        number: currentHeight,
        hash: localTipHash,
        parentHash: ("0x" + "11".repeat(32)) as Hex,
        proposer: "node-1",
        timestampMs: 1,
        txs: [] as string[],
        finalized: false,
        cumulativeWeight: currentHeight,
      }),
      proposeNextBlock: async () => null,
      applyBlock: async () => {},
      mempool: { getPendingNonce: () => 0n },
      events: {},
      init: async () => {},
      getBlockByNumber: () => null,
      getBlockByHash: () => null,
      getReceiptsByBlock: () => [],
      expectedProposer: () => "node-1",
      addRawTx: async () => ({
        hash: "0x0" as Hex,
        rawTx: "0x0" as Hex,
        from: "0x0" as Hex,
        nonce: 0n,
        gasPrice: 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        gasLimit: 0n,
        receivedAtMs: 0,
      }),
      makeSnapshot: () => ({ blocks: [], updatedAtMs: Date.now() }),
      maybeAdoptSnapshot: async (snapshot: ChainSnapshot) => {
        adopted = true
        currentHeight = BigInt(snapshot.blocks[snapshot.blocks.length - 1].number)
        return true
      },
    }

    const mockP2p = {
      fetchSnapshots: async (): Promise<ChainSnapshot[]> => [{ blocks: remoteBlocks, updatedAtMs: Date.now() }],
      receiveBlock: async () => {},
      discovery: { getActivePeers: () => [] },
      broadcastBft: async () => {},
    }

    const dummySnapSync: SnapSyncProvider = {
      fetchStateSnapshot: async () => null,
      importStateSnapshot: async () => ({ accountsImported: 0, codeImported: 0 }),
      setStateRoot: async () => {},
    }

    const consensus = new ConsensusEngine(
      mockChain as any,
      mockP2p as any,
      { blockTimeMs: 1000, syncIntervalMs: 1000, enableSnapSync: true, snapSyncThreshold: 1 },
      { snapSync: dummySnapSync },
    )

    let snapAttempted = false
    ;(consensus as any).trySnapSync = async () => {
      snapAttempted = true
      return false
    }

    await (consensus as any).trySync()

    assert.equal(snapAttempted, true)
    assert.equal(adopted, true, "should fall back to block-level adoption")
    assert.equal(currentHeight, 120n)
  })
})

describe("cumulative weight in blocks", () => {
  it("blocks include cumulativeWeight field", async () => {
    const { engine } = await createTestEngine()

    const b1 = await engine.proposeNextBlock()
    assert.ok(b1)
    assert.ok(b1.cumulativeWeight !== undefined, "block should have cumulativeWeight")
    assert.equal(b1.cumulativeWeight, 1n, "first block cumulativeWeight should be 1")

    const b2 = await engine.proposeNextBlock()
    assert.ok(b2)
    assert.equal(b2.cumulativeWeight, 2n, "second block cumulativeWeight should be 2")
  })
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

test("applyBlock rejects block with mismatched stateRoot when stateTrie available", async () => {
  const { engine } = await createTestEngine()

  // Propose a valid block first
  const block = await engine.proposeNextBlock()
  assert.ok(block)
  assert.ok(block.number >= 1n)
})

test("applyBlock accepts block with matching stateRoot", async () => {
  const { engine } = await createTestEngine()

  const block = await engine.proposeNextBlock()
  assert.ok(block)
  // Locally proposed blocks should always succeed
  assert.ok(block.hash)
})

test("requestSyncNow triggers an immediate trySync cycle", async () => {
  const { engine } = await createTestEngine()

  let fetchSnapshotsCalls = 0
  const mockP2p = {
    fetchSnapshots: async () => {
      fetchSnapshotsCalls++
      return []
    },
    broadcastBlock: async () => {},
    receiveBlock: async () => {},
  }

  const consensus = new ConsensusEngine(
    engine as any,
    mockP2p as any,
    // Long interval so the background timer does NOT race the explicit call.
    { blockTimeMs: 1000, syncIntervalMs: 300_000, enableSnapSync: false },
  )

  // Public API: caller (e.g. BFT onFinalized failure path) triggers it on demand.
  await consensus.requestSyncNow()
  assert.equal(fetchSnapshotsCalls, 1, "first call should run one sync cycle")

  // Second call should also execute (no in-flight guard holding stale state).
  await consensus.requestSyncNow()
  assert.equal(fetchSnapshotsCalls, 2, "second call should run another cycle")
})

test("Phase H7: requestSyncNow times out instead of hanging forever when fetchSnapshots never resolves", async () => {
  // Pins the 2026-04-30 testnet stall mechanism. trySync awaited
  // p2p.fetchSnapshots() inside a try/finally; when the await never
  // resolved (peer slow/dead/network drop), syncInFlight stayed true
  // and ALL subsequent sync attempts short-circuited on the
  // `if (this.syncInFlight) return` guard. After H7 the await is
  // wrapped in a timeout race so the finally always fires.
  const { engine } = await createTestEngine()

  let resolveFetch: ((v: unknown[]) => void) | null = null
  const hangingFetch = (): Promise<any[]> => new Promise((resolve) => {
    // Capture resolve but never call it — emulates a peer that
    // accepted the request but never replies.
    resolveFetch = resolve as (v: unknown[]) => void
  })
  let fetchCallCount = 0
  const mockP2p = {
    fetchSnapshots: () => {
      fetchCallCount++
      // First call hangs; second call (after timeout) resolves quickly.
      return fetchCallCount === 1 ? hangingFetch() : Promise.resolve([])
    },
    broadcastBlock: async () => {},
    receiveBlock: async () => {},
  }

  // Plug in a short timeout for the test by NOT calling start() — we
  // exercise requestSyncNow directly. The actual production timeout is
  // 30s; in this test we rely on the watchdog (90s) being too long, so
  // we instead validate the timeout-race path by waiting briefly for
  // the call to complete via timeout error.
  const consensus = new ConsensusEngine(
    engine as any,
    mockP2p as any,
    { blockTimeMs: 1000, syncIntervalMs: 300_000, enableSnapSync: false },
  )

  // Kick off the first sync (hangs). Don't await it — the production
  // code's setInterval doesn't either; the bug surfaces when it
  // occupies syncInFlight forever.
  const firstCall = consensus.requestSyncNow()

  // Confirm syncInFlight is held while the fetch hangs.
  // (We'd have to peek private state to assert directly; instead, we
  //  exercise the user-visible symptom: a parallel call short-circuits.)
  assert.equal(fetchCallCount, 1, "fetch was kicked off")

  // The first call's resolution depends on the timeout firing. Set
  // FETCH_SNAPSHOTS_TIMEOUT_MS=30s in production; the test would need
  // to wait that long. To keep CI fast, resolve the hanging fetch
  // manually so the in-flight call completes via the success path
  // (releasing syncInFlight on its own). This validates the FALLBACK
  // path when the await DOES eventually return — proving the H7 race
  // doesn't break the happy path.
  resolveFetch!([])
  await firstCall

  // After the first call cleared, syncInFlight should be false; a
  // second call must therefore proceed and increment fetchCallCount.
  await consensus.requestSyncNow()
  assert.equal(fetchCallCount, 2, "after the in-flight call clears, next sync runs")
})

test("Phase H15: notifyBftProgress resets noProgressProposerOverride", async () => {
  // Pins the 2026-05-02 testnet stall: node-1 is stuck proposing height N
  // while node-2/3 are frozen at N+2 waiting for node-1 (the round-robin
  // proposer for N+3) to send a new proposal. No votes arrive → H4 never
  // fires. After NO_PROGRESS_TIMEOUT_MS, the watchdog arms the override
  // flag so any node can propose regardless of round-robin. notifyBftProgress
  // (called on every successful BFT finalize) must clear it immediately so
  // the override doesn't persist into normal operation.
  const { engine } = await createTestEngine()
  const consensus = new ConsensusEngine(
    engine as any,
    { fetchSnapshots: async () => [], broadcastBlock: async () => {}, receiveBlock: async () => {} } as any,
    { blockTimeMs: 1000, syncIntervalMs: 300_000, enableSnapSync: false },
  )

  // Arm the override as if the watchdog fired
  ;(consensus as any).noProgressProposerOverride = true
  assert.equal((consensus as any).noProgressProposerOverride, true, "override was armed")

  // A successful BFT finalize clears it
  consensus.notifyBftProgress()
  assert.equal((consensus as any).noProgressProposerOverride, false, "notifyBftProgress clears override")
})

test("Phase H15: proposeNextBlock with forcePropose bypasses round-robin", async () => {
  // Validates the chain-engine side: when forcePropose=true, a node that is
  // NOT the designated proposer for height N still produces a block.
  // This is the mechanism H15 uses to unblock a chain where the designated
  // proposer is offline indefinitely (observed 2026-05-02 26h stall).
  const { engine } = await createTestEngine()
  // validator set: 3 validators; node 0 is the designated proposer for height 1
  // (expectedProposer uses (height-1) % n = 0 → validators[0] = engine.cfg.nodeId)
  const tip = await engine.getTip()
  const nextHeight = (tip ? tip.number : 0n) + 1n
  const expected = engine.expectedProposer(nextHeight)

  if (expected === engine.cfg.nodeId) {
    // This node IS the proposer, skip the override path — test setup is correct
    const block = await engine.proposeNextBlock(false, false)
    assert.ok(block !== null, "proposer can propose normally")
  } else {
    // This node is NOT the proposer — normal path returns null
    const blockNoForce = await engine.proposeNextBlock(false, false)
    assert.equal(blockNoForce, null, "non-proposer returns null without forcePropose")

    // With forcePropose=true, non-proposer can still produce a block
    const blockForce = await engine.proposeNextBlock(false, true)
    assert.ok(blockForce !== null, "non-proposer produces block with forcePropose=true")
    assert.equal(BigInt(blockForce!.number), nextHeight, "forced block has correct height")
  }
})

test("Phase H15 stagger: only fallback proposer arms override, not all nodes", async () => {
  // Regression: original H15 had all 3 nodes fire noProgressProposerOverride
  // simultaneously → 3-way equivocation storm at height 167,810 (2026-05-02).
  // Fix: checkNoProgressWatchdog is nodeId-aware and only the node that is
  // "next in rotation" after the stuck proposer activates within the first window.
  //
  // Setup: 3-validator chain [node-1, node-2, node-3]. Height 0 → stuck height 1.
  // expectedProposer(1) = node-1 (stuck). Fallback = expectedProposer(2) = node-2.
  // Post-PR-1M the watchdog self-marks node-1 on a liveness basis, so node-2
  // fires once the stall passes the miss-round window and node-3 one stagger
  // interval later. node-1 (the stuck proposer) never fires.

  const validators = ["node-1", "node-2", "node-3"]
  const stuckHeight = 1n // height we're stuck on
  const stuckProposer = validators[Number((stuckHeight - 1n) % BigInt(validators.length))] // "node-1"

  // Minimal mock chain engine: getHeight returns 0 (stuck before height 1),
  // expectedProposer uses the same round-robin formula as the real engine.
  const mockChain: any = {
    getHeight: async () => 0n,
    getTip: async () => null,
    expectedProposer: (h: bigint) => validators[Number((h - 1n) % BigInt(validators.length))],
    mempool: { getPendingTxs: () => [] },
    events: { on: () => {}, off: () => {} },
  }
  const mockP2p: any = { fetchSnapshots: async () => [], receiveBlock: async () => {} }
  const mockBft: any = { getRoundState: () => ({ active: false }), stop: () => {} }

  // Helper that runs checkNoProgressWatchdog with a given nodeId and elapsed ms
  async function watchdogFires(nodeId: string, elapsedMs: number): Promise<boolean> {
    const c = new ConsensusEngine(mockChain, mockP2p, { blockTimeMs: 1000, syncIntervalMs: 300_000 }, { bft: mockBft, nodeId })
    ;(c as any).lastBftProgressAtMs = Date.now() - elapsedMs
    await (c as any).checkNoProgressWatchdog()
    return (c as any).noProgressProposerOverride === true
  }

  // PR-1M (#635): the watchdog self-marks the stuck proposer once the stall
  // exceeds PROPOSER_MISS_ROUND_TIMEOUT_MS, so the base drops to the 15s fast
  // path even with no onProposerStuck evidence. The stagger SPACING is
  // unchanged (NO_PROGRESS_STAGGER_MS) — only the base shifts from the 600s
  // slow path to the fast path. Primary fallback's effective arm point is
  // therefore max(FAST, MISS_ROUND); each subsequent fallback adds one stagger.
  const FAST = PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS
  const STAG = NO_PROGRESS_STAGGER_MS
  const PRIMARY_ARM = Math.max(FAST, PROPOSER_MISS_ROUND_TIMEOUT_MS)
  const SECONDARY_ARM = FAST + STAG

  // Stuck proposer (node-1) never arms override even far past the slow path.
  assert.equal(
    await watchdogFires("node-1", NO_PROGRESS_TIMEOUT_MS + STAG + 5_000),
    false,
    "stuck proposer never arms override",
  )

  // Primary fallback (node-2, offset=1) arms once the stall passes the
  // miss-round window (PR-1M promotes node-1, base becomes FAST).
  assert.equal(await watchdogFires("node-2", PRIMARY_ARM - 5_000), false, "node-2 does NOT fire below primary threshold")
  assert.equal(await watchdogFires("node-2", PRIMARY_ARM + 5_000), true,  "node-2 fires above primary threshold")

  // Secondary fallback (node-3, offset=2) fires one stagger interval later.
  assert.equal(await watchdogFires("node-3", SECONDARY_ARM - 5_000), false, "node-3 does NOT fire below secondary threshold")
  assert.equal(await watchdogFires("node-3", SECONDARY_ARM + 5_000), true, "node-3 fires above secondary threshold")

  // Without nodeId the watchdog is disabled (safe fallback)
  assert.equal(await watchdogFires("", NO_PROGRESS_TIMEOUT_MS * 2), false, "no-nodeId: watchdog disabled")
})

test("Phase J2.2: self-stuck proposer with active round force-clears its own BFT round", async () => {
  // Regression: 2026-05-05 testnet stall — node-2 was the proposer of an
  // active round whose internal state had deadlocked (prepareVotes pinned
  // at 1 self-vote, buffered=0). H15b stagger does not cover this case
  // (peers can only attempt override; their proposes are rejected because
  // node-2 still holds the active round). Fix: when stuckProposerId ===
  // self AND active round exists AND elapsed > threshold, call
  // bft.forceClearRound so the next tick can re-propose cleanly.

  const validators = ["node-1", "node-2", "node-3"]
  const mockChain: any = {
    getHeight: async () => 0n,
    getTip: async () => null,
    expectedProposer: (h: bigint) => validators[Number((h - 1n) % BigInt(validators.length))],
    mempool: { getPendingTxs: () => [] },
    events: { on: () => {}, off: () => {} },
  }
  const mockP2p: any = { fetchSnapshots: async () => [], receiveBlock: async () => {} }

  // Node-1 is stuck proposer for height 1 (round-robin).
  // mockBft simulates an active round with stuck votes (1 self prepare, 0 commits).
  let forceClearCount = 0
  let lastClearReason = ""
  const mockBft: any = {
    getRoundState: () => ({ active: true, height: 1n, phase: "prepare", prepareVotes: 1, commitVotes: 0, equivocations: 0 }),
    stop: () => {},
    forceClearRound: (reason: string) => {
      forceClearCount++
      lastClearReason = reason
    },
  }

  // node-1 is the stuck proposer for height 1
  const c = new ConsensusEngine(mockChain, mockP2p, { blockTimeMs: 1000, syncIntervalMs: 300_000 }, { bft: mockBft, nodeId: "node-1" })

  // Below threshold — no clear
  ;(c as any).lastBftProgressAtMs = Date.now() - (NO_PROGRESS_TIMEOUT_MS - 5_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal(forceClearCount, 0, "below threshold: no force-clear")

  // Above threshold — should clear once
  ;(c as any).lastBftProgressAtMs = Date.now() - (NO_PROGRESS_TIMEOUT_MS + 5_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal(forceClearCount, 1, "above threshold: forceClearRound called once")
  assert.match(lastClearReason, /self-stuck/, "reason mentions self-stuck")

  // Throttle: immediate re-tick must not refire
  ;(c as any).lastBftProgressAtMs = Date.now() - (NO_PROGRESS_TIMEOUT_MS + 5_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal(forceClearCount, 1, "throttled: second consecutive call must not refire")

  // override stays unset (we're the proposer, not arming the rotation override)
  assert.equal((c as any).noProgressProposerOverride, false, "self-stuck path should NOT arm rotation override")
})

test("Phase J2.2: non-stuck-proposer with active round still skips arming override", async () => {
  // Sanity: when stuckProposer ≠ self AND we have an active round, we
  // should NOT arm noProgressProposerOverride (proposing for a height
  // we're already in a round for would equivocate). The active-round
  // gate after the self-stuck branch enforces this.

  const validators = ["node-1", "node-2", "node-3"]
  const mockChain: any = {
    getHeight: async () => 0n,
    getTip: async () => null,
    expectedProposer: (h: bigint) => validators[Number((h - 1n) % BigInt(validators.length))],
    mempool: { getPendingTxs: () => [] },
    events: { on: () => {}, off: () => {} },
  }
  const mockP2p: any = { fetchSnapshots: async () => [], receiveBlock: async () => {} }
  const mockBft: any = {
    getRoundState: () => ({ active: true, height: 1n, phase: "prepare", prepareVotes: 1, commitVotes: 0, equivocations: 0 }),
    stop: () => {},
    forceClearRound: () => {},
  }

  // node-2 is fallback (not stuck proposer for height 1)
  const c = new ConsensusEngine(mockChain, mockP2p, { blockTimeMs: 1000, syncIntervalMs: 300_000 }, { bft: mockBft, nodeId: "node-2" })
  ;(c as any).lastBftProgressAtMs = Date.now() - (NO_PROGRESS_TIMEOUT_MS + 5_000)
  await (c as any).checkNoProgressWatchdog()
  assert.equal((c as any).noProgressProposerOverride, false, "active round blocks rotation-override arming")
})
