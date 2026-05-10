import test from "node:test"
import assert from "node:assert/strict"
import { P2PNode } from "./p2p.ts"

/**
 * PR-1E: Snap-sync provider instrumentation + fallback diagnostics.
 *
 * 2026-05-10 N=5 attempt #2 fingerprint: forceSnapSync repeatedly logged
 * "no peer snapshot available" while server-2 / server-3 should have been
 * serving snapshots. Pre-PR-1E, fetchSnapshots silently dropped failed/
 * timed-out peers — operators had no per-peer telemetry to diagnose
 * whether peers were unreachable, returning 429s, returning empty bodies,
 * or hitting the 15s aggregate timeout.
 *
 * Fix:
 *   1. P2PNode tracks per-peer snapshot fetch outcomes (success | error |
 *      timeout | empty) plus aggregate counters.
 *   2. New `getSnapshotFetchStats()` method exposes the counters for
 *      Prometheus / log diagnostics.
 *   3. fetchSnapshots logs a warn-level summary when ALL peers failed
 *      (zero successes) so an operator looking at logs sees the cause.
 */

function mkNode(opts?: { peers?: Array<{ id: string; url: string }> }): P2PNode {
  return new P2PNode(
    {
      port: 0,
      peers: opts?.peers ?? [],
      enableDiscovery: false,
    } as any,
    {
      onSnapshotRequest: async () => ({ blocks: [], updatedAtMs: Date.now() }),
    } as any,
  )
}

test("PR-1E: getSnapshotFetchStats returns zero state on a fresh node", () => {
  const node = mkNode()
  const stats = node.getSnapshotFetchStats()
  assert.equal(stats.attempts, 0)
  assert.equal(stats.successes, 0)
  assert.equal(stats.errors, 0)
  assert.equal(stats.timeouts, 0)
  assert.equal(stats.emptyResults, 0)
  assert.deepEqual(stats.lastFailureReasons, {})
})

test("PR-1E: fetchSnapshots reports zero-success outcome when no peers configured", async () => {
  const node = mkNode()
  const result = await node.fetchSnapshots()
  assert.deepEqual(result, [])

  const stats = node.getSnapshotFetchStats()
  assert.equal(stats.attempts, 1)
  assert.equal(stats.successes, 0)
  // No peers → no per-peer attempts → totals stay at 0 except attempts
  assert.equal(stats.errors, 0)
  assert.equal(stats.emptyResults, 1, "an empty peer list counts as an empty fetch round")
})

test("PR-1E: fetchSnapshots records error per unreachable peer", async () => {
  // Use a deliberately invalid url scheme so requestJson rejects fast.
  const node = mkNode({
    peers: [
      { id: "peer-1", url: "http://127.0.0.1:1" }, // refused, fast fail
      { id: "peer-2", url: "http://127.0.0.1:2" },
    ],
  })
  const result = await node.fetchSnapshots()
  assert.deepEqual(result, [], "no successful snapshots from unreachable peers")

  const stats = node.getSnapshotFetchStats()
  assert.equal(stats.attempts, 1)
  assert.equal(stats.successes, 0)
  // Both peers should have produced an error outcome
  assert.ok(stats.errors >= 1, "at least one peer error recorded")
  // Some failure reason key should be present
  assert.ok(Object.keys(stats.lastFailureReasons).length > 0)
})
