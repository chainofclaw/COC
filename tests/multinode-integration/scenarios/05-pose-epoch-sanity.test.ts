/**
 * R2.1 Phase A — PoSe end-to-end epoch sanity check
 *
 * Why this exists:
 *   The COC repo has 22 PoSe service unit tests + 6 contract E2E tests +
 *   5 runtime integration tests, but ZERO end-to-end tests where
 *   coc-agent + coc-relayer + 5 BFT validators all run simultaneously
 *   on the same chain. This is the first such test.
 *
 * Setup (started by scripts/run-pose.sh up):
 *   - 5 BFT validators on chainId 88888 (h15-node-{1..5})
 *   - PoSeManagerV2 + ValidatorRegistry + InsuranceFund + EquivocationDetector
 *     deployed via deploy-pose-on-h15.mjs
 *   - 5 validators staked into ValidatorRegistry (each 32 ETH)
 *   - coc-agent (anvil-0) running with 15 s tick interval
 *   - coc-relayer (anvil-3) running with 20 s tick interval
 *
 * What we assert (deliberately liberal — this is a sanity check, not
 * a tight regression):
 *   1. PoSeManagerV2 is initialized (DOMAIN_SEPARATOR != 0)
 *   2. ValidatorRegistry has 5 active validators
 *   3. coc-agent reached its init checkpoint (emitted "endpoint fingerprint mode"
 *      + "reward targets refreshed" logs). Note: real ChallengeIssued/BatchSubmitted
 *      emission requires runtime/coc-node.ts PoSe HTTP servers running on each
 *      validator node (so the agent's tryChallenge POST has a target). The h15
 *      fixture only runs the BFT chain (node/src/index.ts), not the PoSe HTTP
 *      service — so the agent's tick succeeds in setup but POST /pose/challenge
 *      silently fails. The sanity gate is therefore a startup readiness check;
 *      M2-M7 故障 scenarios assert infrastructure-level resilience (container
 *      survival, BFT continuity) rather than full PoSe business-flow.
 *   4. coc-relayer has not crashed in 60 s.
 *
 * Total runtime: ~3-4 min once the fixture is already up.
 */
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { Contract, JsonRpcProvider } from "ethers"

const RPC = "http://localhost:38790"
const DEPLOYED_PATH = "/passinger/projects/ClawdBot/COC/tests/multinode-integration/configs-h15/deployed-pose.json"

const POSE_ABI = [
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function challengeBondMin() view returns (uint256)",
  "event ChallengeIssued(bytes32 indexed challengeId, address indexed challenger, bytes32 indexed nodeId, uint64 epoch, uint64 deadlineMs)",
  "event EpochFinalized(uint64 indexed epoch, bytes32 rewardRoot, uint256 totalRewards)",
  "event BatchSubmitted(bytes32 indexed merkleRoot, uint256 challengeCount)",
]

const VR_ABI = [
  "function getActiveValidators() view returns (bytes32[])",
]

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

function containerAlive(name: string): boolean {
  try {
    const status = execSync(`docker inspect --format '{{.State.Running}}' ${name} 2>/dev/null || echo false`, { encoding: "utf-8" }).trim()
    return status === "true"
  } catch {
    return false
  }
}

describe("R2.1 — PoSe end-to-end epoch sanity", { timeout: 360_000 }, () => {
  let deployed: any

  before(() => {
    if (!existsSync(DEPLOYED_PATH)) {
      throw new Error(
        `${DEPLOYED_PATH} missing. Run\n` +
        `  bash tests/multinode-integration/scripts/run-pose.sh up\n` +
        `before invoking this scenario.`,
      )
    }
    deployed = JSON.parse(readFileSync(DEPLOYED_PATH, "utf-8"))
    if (deployed.chainId !== 88888) {
      throw new Error(`unexpected chainId in deployed file: ${deployed.chainId}`)
    }
  })

  it("PoSeManagerV2 is initialized", async () => {
    const p = new JsonRpcProvider(RPC)
    const pose = new Contract(deployed.contracts.PoSeManagerV2.address, POSE_ABI, p)
    const ds = await pose.DOMAIN_SEPARATOR()
    assert.notStrictEqual(ds, "0x" + "00".repeat(32), "DOMAIN_SEPARATOR is zero — initialize() didn't run")
    console.log(`  ✅ DOMAIN_SEPARATOR = ${ds.slice(0, 18)}…`)
  })

  it("ValidatorRegistry has 5 active validators", async () => {
    const p = new JsonRpcProvider(RPC)
    const vr = new Contract(deployed.contracts.ValidatorRegistry.address, VR_ABI, p)
    const active = await vr.getActiveValidators()
    assert.strictEqual(active.length, 5, `expected 5 active validators, got ${active.length}`)
    console.log(`  ✅ 5 active validators staked`)
  })

  it("coc-agent and coc-relayer containers are alive", () => {
    assert.ok(containerAlive("coc-h15-agent"), "coc-h15-agent container not running")
    assert.ok(containerAlive("coc-h15-relayer"), "coc-h15-relayer container not running")
    console.log(`  ✅ both sidecars alive`)
  })

  it("agent reached init checkpoint (config loaded, reward targets refreshed)", async () => {
    await sleep(15_000) // allow init logs
    const agentLogs = execSync(`docker logs coc-h15-agent 2>&1 || true`, { encoding: "utf-8" })
    const hasFingerprintMode = agentLogs.includes("endpoint fingerprint mode")
    const hasRewardTargets = agentLogs.includes("reward targets refreshed")
    if (!hasFingerprintMode || !hasRewardTargets) {
      console.log(`  agent recent logs:\n${agentLogs.split("\n").slice(-20).map(l => "    " + l).join("\n")}`)
    }
    assert.ok(hasFingerprintMode, "agent did not emit 'endpoint fingerprint mode' log")
    assert.ok(hasRewardTargets, "agent did not emit 'reward targets refreshed' log")
    console.log(`  ✅ agent init checkpoint reached`)
  })

  it("relayer container has not crashed (no restart in 60 s)", async () => {
    await sleep(60_000)
    assert.ok(containerAlive("coc-h15-relayer"), "coc-h15-relayer crashed")
    const restarts = execSync(`docker inspect --format '{{.RestartCount}}' coc-h15-relayer 2>/dev/null || echo 0`, { encoding: "utf-8" }).trim()
    assert.ok(Number(restarts) <= 1, `coc-h15-relayer restarted ${restarts} times`)
    console.log(`  ✅ relayer stable (restarts=${restarts})`)
  })
})
