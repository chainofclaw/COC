import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { MetricsCollector } from "./metrics.ts"

describe("MetricsCollector", () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = new MetricsCollector()
  })

  it("should serialize empty metrics", () => {
    const output = collector.serialize()
    assert.equal(output, "\n")
  })

  it("should set and serialize gauge", () => {
    collector.setGauge("test_gauge", "A test gauge", 42)
    const output = collector.serialize()
    assert.ok(output.includes("# HELP test_gauge A test gauge"))
    assert.ok(output.includes("# TYPE test_gauge gauge"))
    assert.ok(output.includes("test_gauge 42"))
  })

  it("should increment counter", () => {
    collector.incCounter("test_counter", "A test counter", 1)
    collector.incCounter("test_counter", "A test counter", 2)
    const output = collector.serialize()
    assert.ok(output.includes("# TYPE test_counter counter"))
    assert.ok(output.includes("test_counter 3"))
  })

  it("should observe histogram", () => {
    const buckets = [1, 5, 10]
    collector.observeHistogram("test_hist", "A test histogram", 3, buckets)
    collector.observeHistogram("test_hist", "A test histogram", 7, buckets)
    const output = collector.serialize()
    assert.ok(output.includes("# TYPE test_hist histogram"))
    assert.ok(output.includes('test_hist_bucket{le="1"} 0'))
    assert.ok(output.includes('test_hist_bucket{le="5"} 1'))
    assert.ok(output.includes('test_hist_bucket{le="10"} 2'))
    assert.ok(output.includes("test_hist_sum 10"))
    assert.ok(output.includes("test_hist_count 2"))
  })

  it("should collect from source", async () => {
    collector.setSource({
      getBlockHeight: () => 100n,
      getTxPoolPending: () => 5,
      getTxPoolQueued: () => 2,
      getPeersConnected: () => 3,
      getConsensusState: () => "healthy",
    })

    await collector.collect()
    const output = collector.serialize()
    assert.ok(output.includes("coc_block_height 100"))
    assert.ok(output.includes("coc_tx_pool_pending 5"))
    assert.ok(output.includes("coc_peers_connected 3"))
    assert.ok(output.includes("coc_consensus_state 0"))
    assert.ok(output.includes("coc_uptime_seconds"))
    assert.ok(output.includes("coc_process_memory_bytes"))
  })

  it("should handle optional sources", async () => {
    collector.setSource({
      getBlockHeight: () => 50,
      getTxPoolPending: () => 0,
      getTxPoolQueued: () => 0,
      getPeersConnected: () => 0,
      getWireConnections: () => 4,
      getBftRoundHeight: () => 48,
      getDhtPeers: () => 12,
      getP2PAuthRejected: () => 3,
    })

    await collector.collect()
    const output = collector.serialize()
    assert.ok(output.includes("coc_wire_connections 4"))
    assert.ok(output.includes("coc_bft_round_height 48"))
    assert.ok(output.includes("coc_dht_peers_total 12"))
    assert.ok(output.includes("coc_p2p_auth_rejected_total 3"))
  })

  it("should compute block time histogram", async () => {
    const now = Date.now()
    collector.setSource({
      getBlockHeight: () => 10,
      getTxPoolPending: () => 0,
      getTxPoolQueued: () => 0,
      getPeersConnected: () => 0,
      getLastBlockTimestamp: () => now,
      getPreviousBlockTimestamp: () => now - 3000,
    })

    await collector.collect()
    const output = collector.serialize()
    assert.ok(output.includes("coc_block_time_seconds"))
  })
})
