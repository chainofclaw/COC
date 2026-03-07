import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeNodeOpsController } from "./nodeops-runtime.ts"

test("RuntimeNodeOpsController executes policy actions and writes action files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nodeops-runtime-"))
  const policyPath = join(dir, "policy.yaml")
  writeFileSync(policyPath, `
profile: runtime
monitoring:
  poll_interval_ms: 1000
  thresholds:
    cpu_pct: 80
    mem_pct: 80
    disk_pct: 90
    p95_latency_ms: 100
    min_peer_count: 4
self_heal:
  restart_on_process_down: true
  restart_cooldown_ms: 5000
  reconnect_on_peer_drop: true
  peer_reconnect_target: 8
  switch_transport_on_high_latency: true
  latency_switch_threshold_ms: 150
security:
  rpc_rate_limit_rps: 10
key_management:
  rotate_every_days: 1
`)

  const controller = new RuntimeNodeOpsController({
    dataDir: dir,
    nodeUrl: "http://127.0.0.1:18780",
    policyPath,
    probeNode: async () => ({ processUp: false, peerCount: 1, latencyMs: 250 }),
    usageProvider: async () => ({ cpuPct: 95, memPct: 91, diskPct: 95 }),
    exitProcess: () => {},
  })
  await controller.init()
  const actions = await controller.tick(5_000_000)

  assert.equal(controller.enabled, true)
  assert.ok(actions.some((action) => action.type === "RESTART_PROCESS"))
  assert.ok(actions.some((action) => action.type === "RECONNECT_PEERS"))
  assert.ok(actions.some((action) => action.type === "SWITCH_TRANSPORT"))
  assert.ok(actions.some((action) => action.type === "TIGHTEN_RATE_LIMIT"))
  assert.ok(actions.some((action) => action.type === "SCHEDULE_KEY_ROTATION"))
  assert.ok(actions.some((action) => action.type === "RAISE_ALERT"))

  const restart = JSON.parse(readFileSync(join(dir, "nodeops-actions", "restart.json"), "utf8"))
  assert.equal(restart.action, "restart")
  controller.close()
})
