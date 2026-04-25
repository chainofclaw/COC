/**
 * Unit tests for the cross-validator stateRoot audit.
 *
 * The probe / audit functions accept a pluggable RpcFn so we can test
 * without a real chain. Three scenarios exercised:
 *   1. Healthy: all validators agree → consistent=true
 *   2. Latest-divergent: one validator has different latest stateRoot
 *   3. Historical-divergent: latest matches but historical differs
 *      (the GH#3 / 2026-04-25 incident pattern)
 *   4. Unreachable peer: one peer errors, others agree → consistent
 *      among reachable; errors reported separately
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { audit, group, type CliArgs, type ValidatorView } from "./state-divergence-audit.ts"

function makeRpcFn(snapshot: Map<string, { latestBn: bigint; latestRoot: string; historicalRoot?: string; historicalBn?: bigint; error?: string }>): (url: string, method: string, params?: unknown[]) => Promise<unknown> {
  return async (url, method, params = []) => {
    const node = snapshot.get(url)
    if (!node) throw new Error(`unknown rpc: ${url}`)
    if (node.error) throw new Error(node.error)
    if (method === "eth_blockNumber") return "0x" + node.latestBn.toString(16)
    if (method === "eth_getBlockByNumber") {
      const tag = String(params[0] ?? "")
      const requested = BigInt(tag)
      if (requested === node.latestBn) {
        return { stateRoot: node.latestRoot }
      }
      if (node.historicalBn !== undefined && requested === node.historicalBn) {
        return { stateRoot: node.historicalRoot ?? node.latestRoot }
      }
      // Fallback: return latest
      return { stateRoot: node.latestRoot }
    }
    throw new Error(`unmocked method: ${method}`)
  }
}

const baseArgs = (rpcs: string[], historyDepth = 100): CliArgs => ({
  rpcs,
  watch: false,
  intervalSec: 30,
  quiet: false,
  historyDepth,
})

describe("state-divergence-audit", () => {
  it("returns consistent when all 3 validators agree on latest + historical", async () => {
    const snapshot = new Map([
      ["http://node-1", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
      ["http://node-2", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
      ["http://node-3", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
    ])
    const rpcFn = makeRpcFn(snapshot)
    const result = await audit(baseArgs([...snapshot.keys()]), rpcFn)
    assert.equal(result.consistent, true)
    assert.equal(result.latestGroups.size, 1)
    assert.equal(result.errors.length, 0)
  })

  it("flags divergence when latest stateRoot differs (1 of 3)", async () => {
    // node-2 forked at latest
    const snapshot = new Map([
      ["http://node-1", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
      ["http://node-2", { latestBn: 27600n, latestRoot: "0xbbbb", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
      ["http://node-3", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
    ])
    const rpcFn = makeRpcFn(snapshot)
    const result = await audit(baseArgs([...snapshot.keys()]), rpcFn)
    assert.equal(result.consistent, false)
    assert.equal(result.latestGroups.size, 2, "two distinct latest stateRoots")
    assert.deepEqual(
      [...result.latestGroups.values()].map((peers) => peers.length).sort(),
      [1, 2],
      "split is 1 vs 2 peers",
    )
  })

  it("flags divergence when historical stateRoot differs (the 2026-04-25 incident pattern)", async () => {
    // All agree at latest but node-2's historical state has been
    // diverged for a while — exactly what we found post-recovery.
    const snapshot = new Map([
      ["http://node-1", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0x0bd9" }],
      ["http://node-2", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0x8b20" }],
      ["http://node-3", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0x0bd9" }],
    ])
    const rpcFn = makeRpcFn(snapshot)
    const result = await audit(baseArgs([...snapshot.keys()]), rpcFn)
    assert.equal(result.consistent, false, "must flag historical divergence even when latest agrees")
    assert.equal(result.historicalGroups.size, 2)
    assert.equal(result.latestGroups.size, 1)
  })

  it("does not check historical when --history 0", async () => {
    const snapshot = new Map([
      ["http://node-1", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xdiff1" }],
      ["http://node-2", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xdiff2" }],
    ])
    const rpcFn = makeRpcFn(snapshot)
    // historyDepth=0 → only latest matters
    const result = await audit(baseArgs([...snapshot.keys()], 0), rpcFn)
    assert.equal(result.consistent, true, "historyDepth=0 ignores historical divergence")
  })

  it("records errored peers separately, can still verdict on remaining", async () => {
    const snapshot = new Map([
      ["http://node-1", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
      ["http://node-2", { latestBn: 0n, latestRoot: "", error: "ECONNREFUSED" }],
      ["http://node-3", { latestBn: 27600n, latestRoot: "0xaaaa", historicalBn: 27500n, historicalRoot: "0xaaaa" }],
    ])
    const rpcFn = makeRpcFn(snapshot)
    const result = await audit(baseArgs([...snapshot.keys()]), rpcFn)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].rpc, "http://node-2")
    assert.equal(result.consistent, true, "remaining 2 peers agree")
  })

  it("groups peers by their reported stateRoot", () => {
    const views: ValidatorView[] = [
      { rpc: "n1", height: 1n, latestStateRoot: "0xaaa", historicalHeight: 0n, historicalStateRoot: "" },
      { rpc: "n2", height: 1n, latestStateRoot: "0xbbb", historicalHeight: 0n, historicalStateRoot: "" },
      { rpc: "n3", height: 1n, latestStateRoot: "0xaaa", historicalHeight: 0n, historicalStateRoot: "" },
    ]
    const groups = group(views, "latest")
    assert.equal(groups.size, 2)
    assert.deepEqual(groups.get("0xaaa")?.sort(), ["n1", "n3"])
    assert.deepEqual(groups.get("0xbbb"), ["n2"])
  })

  it("skips errored peers in group buckets", () => {
    const views: ValidatorView[] = [
      { rpc: "n1", height: 1n, latestStateRoot: "0xaaa", historicalHeight: 0n, historicalStateRoot: "" },
      { rpc: "n2", height: 0n, latestStateRoot: "", historicalHeight: 0n, historicalStateRoot: "", errored: "down" },
      { rpc: "n3", height: 1n, latestStateRoot: "0xaaa", historicalHeight: 0n, historicalStateRoot: "" },
    ]
    const groups = group(views, "latest")
    assert.equal(groups.size, 1)
    assert.deepEqual(groups.get("0xaaa")?.sort(), ["n1", "n3"])
  })
})
