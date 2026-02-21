import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { NodeManager } from "./node-manager.ts"
import type { NodeEntry } from "./node-manager.ts"

function createTestLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe("NodeManager", () => {
  let tempDir: string
  let manager: NodeManager

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coc-nm-test-"))
    manager = new NodeManager(tempDir, createTestLogger() as any)
    await manager.init()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("starts with empty node list", () => {
    assert.strictEqual(manager.listNodes().length, 0)
  })

  it("registers and retrieves a node", () => {
    const entry: NodeEntry = {
      name: "test-1",
      type: "dev",
      network: "local",
      dataDir: join(tempDir, "nodes", "test-1"),
      services: ["node"],
      createdAt: new Date().toISOString(),
    }
    manager.registerNode(entry)
    assert.strictEqual(manager.listNodes().length, 1)
    assert.strictEqual(manager.getNode("test-1")?.type, "dev")
  })

  it("updates existing node on re-register", () => {
    const entry: NodeEntry = {
      name: "test-1",
      type: "dev",
      network: "local",
      dataDir: join(tempDir, "nodes", "test-1"),
      services: ["node"],
      createdAt: new Date().toISOString(),
    }
    manager.registerNode(entry)
    manager.registerNode({ ...entry, type: "fullnode" })
    assert.strictEqual(manager.listNodes().length, 1)
    assert.strictEqual(manager.getNode("test-1")?.type, "fullnode")
  })

  it("removes a node", async () => {
    const entry: NodeEntry = {
      name: "test-1",
      type: "dev",
      network: "local",
      dataDir: join(tempDir, "nodes", "test-1"),
      services: ["node"],
      createdAt: new Date().toISOString(),
    }
    manager.registerNode(entry)
    const removed = await manager.removeNode("test-1", false)
    assert.strictEqual(removed, true)
    assert.strictEqual(manager.listNodes().length, 0)
  })

  it("removeNode returns false for non-existent node", async () => {
    const removed = await manager.removeNode("no-such-node", false)
    assert.strictEqual(removed, false)
  })

  it("nodeDir returns correct path", () => {
    const dir = manager.nodeDir("my-node")
    assert.ok(dir.endsWith("/nodes/my-node"))
  })

  it("persists registry across instances", async () => {
    const entry: NodeEntry = {
      name: "persist-test",
      type: "validator",
      network: "testnet",
      dataDir: join(tempDir, "nodes", "persist-test"),
      services: ["node", "agent"],
      createdAt: new Date().toISOString(),
    }
    manager.registerNode(entry)

    // Wait for async save
    await new Promise((r) => setTimeout(r, 100))

    // Create a new manager instance pointing at the same dir
    const manager2 = new NodeManager(tempDir, createTestLogger() as any)
    await manager2.init()
    assert.strictEqual(manager2.listNodes().length, 1)
    assert.strictEqual(manager2.getNode("persist-test")?.type, "validator")
  })

  it("getNodeStatus throws for non-existent node", async () => {
    await assert.rejects(
      () => manager.getNodeStatus("ghost"),
      /not found/i,
    )
  })

  it("getNodeConfig throws for non-existent node", async () => {
    await assert.rejects(
      () => manager.getNodeConfig("ghost"),
      /not found/i,
    )
  })

  it("multiple nodes coexist", () => {
    manager.registerNode({
      name: "node-a",
      type: "dev",
      network: "local",
      dataDir: join(tempDir, "nodes", "node-a"),
      services: ["node"],
      createdAt: new Date().toISOString(),
    })
    manager.registerNode({
      name: "node-b",
      type: "validator",
      network: "testnet",
      dataDir: join(tempDir, "nodes", "node-b"),
      services: ["node", "agent"],
      createdAt: new Date().toISOString(),
    })
    assert.strictEqual(manager.listNodes().length, 2)
    assert.strictEqual(manager.getNode("node-a")?.type, "dev")
    assert.strictEqual(manager.getNode("node-b")?.type, "validator")
  })
})
