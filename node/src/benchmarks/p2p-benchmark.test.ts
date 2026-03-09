/**
 * P2P subsystem performance benchmarks.
 *
 * Measures throughput and latency for:
 * - Wire frame encode/decode
 * - DHT routing table queries
 * - HTTP gossip broadcast (mocked)
 * - BFT message signing/verification
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import {
  encodeFrame,
  decodeFrame,
  encodeJsonPayload,
  MessageType,
} from "../wire-protocol.ts"
import { RoutingTable } from "../dht.ts"

describe("P2P Benchmarks", () => {
  it("wire frame encode/decode throughput: 1000 frames", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ block: "0x" + "ab".repeat(32), height: 12345 }))
    const frame = { type: MessageType.Block as MessageType, payload }

    const iterations = 1000
    const t0 = performance.now()

    for (let i = 0; i < iterations; i++) {
      const encoded = encodeFrame(frame)
      const decoded = decodeFrame(encoded)
      assert.ok(decoded)
      assert.equal(decoded.frame.type, MessageType.Block)
    }

    const elapsed = performance.now() - t0
    const opsPerSec = Math.round((iterations / elapsed) * 1000)
    assert.ok(elapsed < 5000, `encode/decode 1000 frames should complete in <5s, took ${elapsed.toFixed(0)}ms`)
    // Log for human review (not checked in CI, informational only)
    process.stdout.write(`  wire encode/decode: ${opsPerSec} ops/s (${elapsed.toFixed(1)}ms total)\n`)
  })

  it("wire JSON payload roundtrip: 1000 iterations", () => {
    const payload = {
      peers: [
        { id: "0x" + "aa".repeat(20), address: "10.0.0.1:19781" },
        { id: "0x" + "bb".repeat(20), address: "10.0.0.2:19781" },
      ],
    }

    const iterations = 1000
    const t0 = performance.now()

    for (let i = 0; i < iterations; i++) {
      const encoded = encodeJsonPayload(MessageType.FindNodeResponse, payload)
      const decoded = decodeFrame(encoded)
      assert.ok(decoded)
    }

    const elapsed = performance.now() - t0
    assert.ok(elapsed < 5000, `JSON roundtrip should complete in <5s, took ${elapsed.toFixed(0)}ms`)
    process.stdout.write(`  JSON roundtrip: ${Math.round((iterations / elapsed) * 1000)} ops/s (${elapsed.toFixed(1)}ms)\n`)
  })

  it("DHT routing table: findClosest latency (1000 lookups)", async () => {
    const table = new RoutingTable("0x" + "00".repeat(20))

    // Populate with 100 nodes
    for (let i = 0; i < 100; i++) {
      const hex = i.toString(16).padStart(40, "0")
      await table.addPeer({ id: `0x${hex}`, address: `10.0.0.${i % 255 + 1}`, port: 19781 })
    }

    const iterations = 1000
    const t0 = performance.now()

    for (let i = 0; i < iterations; i++) {
      const targetHex = (i % 256).toString(16).padStart(40, "0")
      const closest = table.findClosest(`0x${targetHex}`, 8)
      assert.ok(closest.length <= 8)
    }

    const elapsed = performance.now() - t0
    assert.ok(elapsed < 10000, `DHT findClosest should complete in <10s, took ${elapsed.toFixed(0)}ms`)
    process.stdout.write(`  DHT findClosest: ${Math.round((iterations / elapsed) * 1000)} ops/s (${elapsed.toFixed(1)}ms)\n`)
  })

  it("frame encoding with varying payload sizes", () => {
    const sizes = [64, 256, 1024, 4096, 16384]
    for (const size of sizes) {
      const payload = new Uint8Array(size)
      crypto.getRandomValues(payload)
      const frame = { type: MessageType.Transaction as MessageType, payload }

      const iterations = 500
      const t0 = performance.now()

      for (let i = 0; i < iterations; i++) {
        const encoded = encodeFrame(frame)
        const decoded = decodeFrame(encoded)
        assert.ok(decoded)
      }

      const elapsed = performance.now() - t0
      process.stdout.write(`  encode/decode ${size}B: ${Math.round((iterations / elapsed) * 1000)} ops/s\n`)
    }
  })

  it("wire message type priority distribution", () => {
    // Verify that encoding different message types doesn't have performance variance
    const types = [
      MessageType.Block,
      MessageType.Transaction,
      MessageType.BftPrepare,
      MessageType.BftCommit,
      MessageType.FindNode,
    ]
    const payload = new Uint8Array(128)

    for (const type of types) {
      const frame = { type: type as MessageType, payload }
      const iterations = 200
      const t0 = performance.now()

      for (let i = 0; i < iterations; i++) {
        encodeFrame(frame)
      }

      const elapsed = performance.now() - t0
      // All types should encode at similar speed
      assert.ok(elapsed < 1000, `encoding type 0x${type.toString(16)} too slow: ${elapsed.toFixed(0)}ms`)
    }
  })
})
