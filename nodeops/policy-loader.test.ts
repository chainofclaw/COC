import test from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parsePolicyYaml, loadPolicyFromFile, loadAllPolicies } from "./policy-loader.ts"
import { DEFAULT_NODEOPS_POLICY } from "./policy-types.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

test("parsePolicyYaml maps default-policy.yaml to NodeOpsPolicy", () => {
  const yaml = `
version: 1
profile: default

monitoring:
  poll_interval_ms: 15000
  thresholds:
    cpu_pct: 85
    mem_pct: 85
    disk_pct: 90
    p95_latency_ms: 2500
    min_peer_count: 8

self_heal:
  restart_on_process_down: true
  restart_cooldown_ms: 120000
  reconnect_on_peer_drop: true
  peer_reconnect_target: 12
  switch_transport_on_high_latency: true
  latency_switch_threshold_ms: 3500

security:
  rpc_rate_limit_rps: 20

key_management:
  rotate_every_days: 30
`
  const policy = parsePolicyYaml(yaml)
  assert.equal(policy.profile, "default")
  assert.equal(policy.monitoringPollMs, 15000)
  assert.equal(policy.thresholds.cpuPct, 85)
  assert.equal(policy.thresholds.memPct, 85)
  assert.equal(policy.thresholds.diskPct, 90)
  assert.equal(policy.thresholds.p95LatencyMs, 2500)
  assert.equal(policy.thresholds.minPeerCount, 8)
  assert.equal(policy.restartOnProcessDown, true)
  assert.equal(policy.restartCooldownMs, 120000)
  assert.equal(policy.reconnectOnPeerDrop, true)
  assert.equal(policy.peerReconnectTarget, 12)
  assert.equal(policy.switchTransportOnHighLatency, true)
  assert.equal(policy.latencySwitchThresholdMs, 3500)
  assert.equal(policy.rpcRateLimitRps, 20)
  assert.equal(policy.keyRotateDays, 30)
})

test("parsePolicyYaml uses defaults for missing fields", () => {
  const yaml = `
profile: minimal
monitoring:
  poll_interval_ms: 5000
`
  const policy = parsePolicyYaml(yaml)
  assert.equal(policy.profile, "minimal")
  assert.equal(policy.monitoringPollMs, 5000)
  // All other fields should use defaults
  assert.equal(policy.thresholds.cpuPct, DEFAULT_NODEOPS_POLICY.thresholds.cpuPct)
  assert.equal(policy.restartOnProcessDown, DEFAULT_NODEOPS_POLICY.restartOnProcessDown)
  assert.equal(policy.rpcRateLimitRps, DEFAULT_NODEOPS_POLICY.rpcRateLimitRps)
  assert.equal(policy.keyRotateDays, DEFAULT_NODEOPS_POLICY.keyRotateDays)
})

test("parsePolicyYaml handles custom thresholds", () => {
  const yaml = `
profile: high-perf
monitoring:
  poll_interval_ms: 5000
  thresholds:
    cpu_pct: 70
    mem_pct: 75
    disk_pct: 80
    p95_latency_ms: 1000
    min_peer_count: 16
self_heal:
  restart_on_process_down: false
  restart_cooldown_ms: 60000
security:
  rpc_rate_limit_rps: 50
key_management:
  rotate_every_days: 7
`
  const policy = parsePolicyYaml(yaml)
  assert.equal(policy.profile, "high-perf")
  assert.equal(policy.thresholds.cpuPct, 70)
  assert.equal(policy.thresholds.memPct, 75)
  assert.equal(policy.thresholds.diskPct, 80)
  assert.equal(policy.thresholds.p95LatencyMs, 1000)
  assert.equal(policy.thresholds.minPeerCount, 16)
  assert.equal(policy.restartOnProcessDown, false)
  assert.equal(policy.restartCooldownMs, 60000)
  assert.equal(policy.rpcRateLimitRps, 50)
  assert.equal(policy.keyRotateDays, 7)
})

test("parsePolicyYaml is semantically equal to DEFAULT_NODEOPS_POLICY for default yaml", () => {
  const policy = parsePolicyYaml(`
version: 1
profile: default
monitoring:
  poll_interval_ms: 15000
  thresholds:
    cpu_pct: 85
    mem_pct: 85
    disk_pct: 90
    p95_latency_ms: 2500
    min_peer_count: 8
self_heal:
  restart_on_process_down: true
  restart_cooldown_ms: 120000
  reconnect_on_peer_drop: true
  peer_reconnect_target: 12
  switch_transport_on_high_latency: true
  latency_switch_threshold_ms: 3500
security:
  rpc_rate_limit_rps: 20
key_management:
  rotate_every_days: 30
`)
  assert.deepEqual(policy, DEFAULT_NODEOPS_POLICY)
})

test("loadPolicyFromFile reads real YAML file", () => {
  const filePath = join(__dirname, "policies", "default-policy.yaml")
  const policy = loadPolicyFromFile(filePath)
  assert.equal(policy.profile, "default")
  assert.equal(policy.monitoringPollMs, 15000)
  assert.equal(policy.thresholds.cpuPct, 85)
})

test("loadAllPolicies loads all yaml files from directory", () => {
  const dir = join(__dirname, "policies")
  const policies = loadAllPolicies(dir)
  assert.ok(policies.has("default-policy"))
  const defaultPolicy = policies.get("default-policy")!
  assert.equal(defaultPolicy.profile, "default")
})

test("parsePolicyYaml handles comments and empty lines", () => {
  const yaml = `
# Top level comment
profile: test # inline comment

monitoring:
  # Monitoring thresholds
  poll_interval_ms: 10000

  thresholds:
    cpu_pct: 90

# End of file
`
  const policy = parsePolicyYaml(yaml)
  assert.equal(policy.profile, "test")
  assert.equal(policy.monitoringPollMs, 10000)
  assert.equal(policy.thresholds.cpuPct, 90)
})

test("parsePolicyYaml handles empty input", () => {
  const policy = parsePolicyYaml("")
  assert.deepEqual(policy, DEFAULT_NODEOPS_POLICY)
})
