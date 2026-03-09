import test from "node:test"
import assert from "node:assert/strict"
import { listActiveNodeIds, listActiveNodeIdsPaginated, type PaginatedNodeRegistryLike } from "./active-node-resolver.ts"

test("listActiveNodeIds returns active registered nodes in deterministic order", async () => {
  const active = new Set([
    `0x${"11".repeat(32)}`,
    `0x${"33".repeat(32)}`,
  ])
  const contract = {
    filters: {
      NodeRegistered() {
        return "NodeRegistered"
      },
    },
    async queryFilter() {
      return [
        { args: { nodeId: `0x${"33".repeat(32)}` } },
        { args: { nodeId: `0x${"22".repeat(32)}` } },
        { args: { nodeId: `0x${"11".repeat(32)}` } },
        { args: { nodeId: `0x${"11".repeat(32)}` } },
      ]
    },
    async getNode(nodeId: string) {
      return { active: active.has(nodeId) }
    },
  }

  const nodeIds = await listActiveNodeIds(contract)
  assert.deepEqual(nodeIds, [
    `0x${"11".repeat(32)}`,
    `0x${"33".repeat(32)}`,
  ])
})

test("listActiveNodeIdsPaginated fetches via getActiveNodeIds", async () => {
  const allNodes = [
    `0x${"aa".repeat(32)}`,
    `0x${"bb".repeat(32)}`,
    `0x${"cc".repeat(32)}`,
  ]
  const contract: PaginatedNodeRegistryLike = {
    filters: { NodeRegistered() { return "NodeRegistered" } },
    async queryFilter() { return [] },
    async getNode() { return { active: true } },
    async getActiveNodeCount() { return BigInt(allNodes.length) },
    async getActiveNodeIds(offset: bigint, limit: bigint) {
      const start = Number(offset)
      const end = Math.min(start + Number(limit), allNodes.length)
      return allNodes.slice(start, end)
    },
  }

  const nodeIds = await listActiveNodeIdsPaginated(contract)
  assert.equal(nodeIds.length, 3)
  // Should be sorted
  const sorted = [...nodeIds].sort()
  assert.deepEqual(nodeIds, sorted)
})

test("listActiveNodeIds prefers paginated over event replay", async () => {
  let paginatedCalled = false
  let eventsCalled = false
  const contract: PaginatedNodeRegistryLike = {
    filters: { NodeRegistered() { return "NodeRegistered" } },
    async queryFilter() {
      eventsCalled = true
      return []
    },
    async getNode() { return { active: true } },
    async getActiveNodeCount() {
      paginatedCalled = true
      return 1n
    },
    async getActiveNodeIds() {
      return [`0x${"dd".repeat(32)}`]
    },
  }

  const result = await listActiveNodeIds(contract)
  assert.equal(paginatedCalled, true)
  assert.equal(eventsCalled, false)
  assert.equal(result.length, 1)
})

test("listActiveNodeIds falls back to events when pagination fails", async () => {
  const contract: PaginatedNodeRegistryLike = {
    filters: { NodeRegistered() { return "NodeRegistered" } },
    async queryFilter() {
      return [{ args: { nodeId: `0x${"ee".repeat(32)}` } }]
    },
    async getNode() { return { active: true } },
    async getActiveNodeCount() { throw new Error("not supported") },
    async getActiveNodeIds() { throw new Error("not supported") },
  }

  const result = await listActiveNodeIds(contract)
  assert.equal(result.length, 1)
  assert.equal(result[0], `0x${"ee".repeat(32)}`)
})

test("listActiveNodeIdsPaginated handles multiple pages", async () => {
  const allNodes = Array.from({ length: 5 }, (_, i) =>
    `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`,
  )
  const contract: PaginatedNodeRegistryLike = {
    filters: { NodeRegistered() { return "NodeRegistered" } },
    async queryFilter() { return [] },
    async getNode() { return { active: true } },
    async getActiveNodeCount() { return BigInt(allNodes.length) },
    async getActiveNodeIds(offset: bigint, limit: bigint) {
      const start = Number(offset)
      const pageSize = Math.min(Number(limit), 2) // simulate small page
      const end = Math.min(start + pageSize, allNodes.length)
      return allNodes.slice(start, end)
    },
  }

  const result = await listActiveNodeIdsPaginated(contract)
  assert.equal(result.length, 5)
})

test("listActiveNodeIdsPaginated returns empty for zero nodes", async () => {
  const contract: PaginatedNodeRegistryLike = {
    filters: { NodeRegistered() { return "NodeRegistered" } },
    async queryFilter() { return [] },
    async getNode() { return null },
    async getActiveNodeCount() { return 0n },
    async getActiveNodeIds() { return [] },
  }

  const result = await listActiveNodeIdsPaginated(contract)
  assert.deepEqual(result, [])
})
