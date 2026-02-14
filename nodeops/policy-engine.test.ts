import test from "node:test"
import assert from "node:assert/strict"
import { NodeOpsPolicyEngine, NodeOpsActionType } from "./policy-engine.ts"
import { DEFAULT_NODEOPS_POLICY } from "./policy-types.ts"

test("engine emits restart and alert actions on failures", () => {
  const engine = new NodeOpsPolicyEngine(DEFAULT_NODEOPS_POLICY)
  const actions = engine.evaluate(
    {
      nowMs: 1_000_000n,
      processUp: false,
      cpuPct: 90,
      memPct: 70,
      diskPct: 92,
      p95LatencyMs: 4000,
      peerCount: 2,
    },
    {},
  )

  const types = new Set(actions.map((a) => a.type))
  assert.equal(types.has(NodeOpsActionType.RestartProcess), true)
  assert.equal(types.has(NodeOpsActionType.ReconnectPeers), true)
  assert.equal(types.has(NodeOpsActionType.SwitchTransport), true)
  assert.equal(types.has(NodeOpsActionType.RaiseAlert), true)
  assert.equal(types.has(NodeOpsActionType.TightenRateLimit), true)
  assert.equal(types.has(NodeOpsActionType.ScheduleKeyRotation), true)
})

test("engine honors restart cooldown", () => {
  const engine = new NodeOpsPolicyEngine(DEFAULT_NODEOPS_POLICY)
  const actions = engine.evaluate(
    {
      nowMs: 1_050_000n,
      processUp: false,
      cpuPct: 20,
      memPct: 20,
      diskPct: 20,
      p95LatencyMs: 100,
      peerCount: 20,
    },
    { lastRestartAtMs: 1_000_000n },
  )

  const types = actions.map((a) => a.type)
  assert.equal(types.includes(NodeOpsActionType.RestartProcess), false)
  assert.equal(types.includes(NodeOpsActionType.RaiseAlert), true)
})
