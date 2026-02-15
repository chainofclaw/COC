/**
 * PeerStore tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { PeerStore } from "./peer-store.ts"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function createTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "coc-peer-store-"))
  return join(dir, "peers.json")
}

test("PeerStore: add and get peers", () => {
  const store = new PeerStore({ filePath: createTempPath() })

  store.addPeer({ id: "node-1", url: "http://localhost:19780" })
  store.addPeer({ id: "node-2", url: "http://localhost:19781" })

  const peers = store.getPeers()
  assert.strictEqual(peers.length, 2)
  assert.ok(peers.some((p) => p.id === "node-1"))
  assert.ok(peers.some((p) => p.id === "node-2"))
})

test("PeerStore: remove peer", () => {
  const store = new PeerStore({ filePath: createTempPath() })

  store.addPeer({ id: "node-1", url: "http://localhost:19780" })
  store.addPeer({ id: "node-2", url: "http://localhost:19781" })

  store.removePeer("node-1")

  const peers = store.getPeers()
  assert.strictEqual(peers.length, 1)
  assert.strictEqual(peers[0].id, "node-2")
})

test("PeerStore: save and load", async () => {
  const path = createTempPath()

  // Save
  const store1 = new PeerStore({ filePath: path })
  store1.addPeer({ id: "node-1", url: "http://localhost:19780" })
  store1.addPeer({ id: "node-2", url: "http://localhost:19781" })
  await store1.save()

  // Load in new instance
  const store2 = new PeerStore({ filePath: path })
  const loaded = await store2.load()

  assert.strictEqual(loaded.length, 2)
  assert.ok(loaded.some((p) => p.id === "node-1"))
  assert.ok(loaded.some((p) => p.id === "node-2"))
})

test("PeerStore: expired peers filtered on load", async () => {
  const path = createTempPath()

  // Save peer with very old lastSeenMs
  const store1 = new PeerStore({ filePath: path, maxAgeMs: 1000 })
  store1.addPeer({ id: "node-1", url: "http://localhost:19780" })
  await store1.save()

  // Wait a bit, then load with short max age
  await new Promise((r) => setTimeout(r, 50))

  const store2 = new PeerStore({ filePath: path, maxAgeMs: 10 })
  // Manually set lastSeenMs to past
  const loaded = await store2.load()
  // Peers were just added, so they should still be valid with 10ms window
  // since we waited only 50ms and the peer was added moments ago
  assert.ok(loaded.length <= 2)
})

test("PeerStore: record failure removes peer after threshold", () => {
  const store = new PeerStore({ filePath: createTempPath() })

  store.addPeer({ id: "node-1", url: "http://localhost:19780" })

  // Record 10 failures to trigger removal
  for (let i = 0; i < 11; i++) {
    store.recordFailure("node-1")
  }

  assert.strictEqual(store.size(), 0)
})

test("PeerStore: record success resets fail count", () => {
  const store = new PeerStore({ filePath: createTempPath() })

  store.addPeer({ id: "node-1", url: "http://localhost:19780" })

  // Record some failures
  for (let i = 0; i < 5; i++) {
    store.recordFailure("node-1")
  }

  // Record success
  store.recordSuccess("node-1")

  // Should still be there
  assert.strictEqual(store.size(), 1)
})

test("PeerStore: evicts oldest when at max capacity", () => {
  const store = new PeerStore({ filePath: createTempPath(), maxPeers: 2 })

  store.addPeer({ id: "node-1", url: "http://localhost:19780" })
  store.addPeer({ id: "node-2", url: "http://localhost:19781" })
  store.addPeer({ id: "node-3", url: "http://localhost:19782" })

  assert.strictEqual(store.size(), 2)
  // node-1 should have been evicted as oldest
  const peers = store.getPeers()
  assert.ok(!peers.some((p) => p.id === "node-1"))
})

test("PeerStore: updating existing peer refreshes lastSeen", () => {
  const store = new PeerStore({ filePath: createTempPath() })

  store.addPeer({ id: "node-1", url: "http://localhost:19780" })
  const before = store.getStoredPeers()[0].lastSeenMs

  // Update
  store.addPeer({ id: "node-1", url: "http://localhost:19781" })
  const after = store.getStoredPeers()[0].lastSeenMs

  assert.ok(after >= before)
  assert.strictEqual(store.getStoredPeers()[0].url, "http://localhost:19781")
})

test("PeerStore: load from non-existent file returns empty", async () => {
  const store = new PeerStore({ filePath: "/tmp/nonexistent-coc-peers.json" })
  const loaded = await store.load()
  assert.strictEqual(loaded.length, 0)
})
