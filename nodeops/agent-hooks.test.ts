import test from "node:test"
import assert from "node:assert/strict"
import { NodeOpsHooks } from "./agent-hooks.ts"
import { DEFAULT_NODEOPS_POLICY } from "./policy-types.ts"

test("hooks executes adapter actions", async () => {
  const calls: string[] = []
  const hooks = new NodeOpsHooks(DEFAULT_NODEOPS_POLICY, {
    async restartProcess() {
      calls.push("restart")
    },
    async reconnectPeers(targetPeerCount: number) {
      calls.push(`reconnect:${targetPeerCount}`)
    },
    async switchTransport(prefer: "quic" | "tcp") {
      calls.push(`transport:${prefer}`)
    },
    async setRpcRateLimit(rps: number) {
      calls.push(`rate:${rps}`)
    },
    async alert(message: string) {
      calls.push(`alert:${message}`)
    },
    async scheduleKeyRotation() {
      calls.push("rotate")
    },
  })

  await hooks.tick({
    nowMs: 5_000_000n,
    processUp: false,
    cpuPct: 92,
    memPct: 91,
    diskPct: 95,
    p95LatencyMs: 3900,
    peerCount: 3,
  })

  assert.equal(calls.includes("restart"), true)
  assert.equal(calls.some((c) => c.startsWith("reconnect:")), true)
  assert.equal(calls.includes("transport:quic"), true)
  assert.equal(calls.some((c) => c.startsWith("rate:")), true)
  assert.equal(calls.includes("rotate"), true)
  assert.equal(calls.some((c) => c.startsWith("alert:")), true)
})
