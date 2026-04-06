import { describe, it, expect } from "vitest"
import { CarrierDaemon, CarrierDaemonConfigSchema } from "../src/carrier/carrier-daemon.ts"

const AGENT_ID = "0x" + "aa".repeat(32)

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function createFakeSoul() {
  return {
    isOffline: async () => false,
    getResurrectionConfig: async () => ({ configured: true }),
  } as any
}

function createFakeIpfs() {
  return {
    ping: async () => true,
    mfsMkdir: async () => {},
    mfsRead: async () => { throw new Error("not found") },
    mfsWrite: async () => {},
    mfsRm: async () => {},
  } as any
}

function createFakeCidResolver() {
  return {
    resolve: async () => null,
    register: async () => {},
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return CarrierDaemonConfigSchema.parse({
    carrierId: "0x" + "bb".repeat(32),
    agentEntryScript: "./index.ts",
    privateKeyOrPassword: "testkey",
    ...overrides,
  })
}

describe("CarrierDaemon", () => {
  it("validates config schema with defaults", () => {
    const parsed = makeConfig()
    expect(parsed.carrierId).toBe("0x" + "bb".repeat(32))
    expect(parsed.pollIntervalMs).toBe(60_000)
    expect(parsed.maxConcurrentResurrections).toBe(1)
    expect(parsed.watchedAgents).toEqual([])
    expect(parsed.pendingRequestIds).toEqual([])
    expect(parsed.readinessTimeoutMs).toBe(86_400_000)
  })

  it("starts and stops without error", async () => {
    const daemon = new CarrierDaemon(
      makeConfig({ watchedAgents: [AGENT_ID], pollIntervalMs: 10_000 }),
      createFakeSoul(),
      createFakeIpfs(),
      createFakeCidResolver(),
      fakeLogger,
    )

    daemon.start()
    const status = daemon.getStatus()
    expect(status.running).toBe(true)
    expect(status.watchedAgents).toEqual([AGENT_ID])
    expect(status.activeResurrections).toEqual([])

    await daemon.stop()
    expect(daemon.getStatus().running).toBe(false)
  })

  it("addRequest returns acceptance status", async () => {
    const daemon = new CarrierDaemon(
      makeConfig(),
      createFakeSoul(),
      createFakeIpfs(),
      createFakeCidResolver(),
      fakeLogger,
    )

    // Not running → rejected
    const beforeStart = daemon.addRequest("0xreq", AGENT_ID)
    expect(beforeStart.accepted).toBe(false)
    if (!beforeStart.accepted) {
      expect(beforeStart.reason).toBe("not_running")
    }

    daemon.start()

    // Concurrency=1, but no active tasks yet → accepted
    // (This will fail internally since the mock soul doesn't support getResurrectionRequest,
    //  but addRequest itself should return accepted before the async work begins)
    const accepted = daemon.addRequest("0x" + "dd".repeat(32), AGENT_ID)
    expect(accepted.accepted).toBe(true)

    // Same request again → already_processing
    const duplicate = daemon.addRequest("0x" + "dd".repeat(32), AGENT_ID)
    expect(duplicate.accepted).toBe(false)
    if (!duplicate.accepted) {
      expect(duplicate.reason).toBe("already_processing")
    }

    await daemon.stop()
  })

  it("respects concurrency limit", async () => {
    const daemon = new CarrierDaemon(
      makeConfig({ maxConcurrentResurrections: 0 }),
      createFakeSoul(),
      createFakeIpfs(),
      createFakeCidResolver(),
      fakeLogger,
    )

    daemon.start()
    const result = daemon.addRequest("0x" + "ee".repeat(32), AGENT_ID)
    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reason).toBe("concurrency_limit")
    }
    await daemon.stop()
  })

  it("does not start duplicate monitoring", async () => {
    const daemon = new CarrierDaemon(
      makeConfig(),
      createFakeSoul(),
      createFakeIpfs(),
      createFakeCidResolver(),
      fakeLogger,
    )

    daemon.start()
    daemon.start() // no-op
    expect(daemon.getStatus().running).toBe(true)
    await daemon.stop()
  })

  it("stop() aborts active resurrection and drains", async () => {
    // Create a soul mock where getResurrectionRequest triggers a long wait,
    // allowing us to call stop() while the flow is active
    let abortSeen = false
    const soul = {
      ...createFakeSoul(),
      getResurrectionRequest: async () => ({
        requestId: "0x" + "dd".repeat(32),
        agentId: AGENT_ID,
        carrierId: "0x" + "bb".repeat(32),
        initiator: "0x" + "11".repeat(20),
        initiatedAt: 1000,
        approvalCount: 0,
        guardianSnapshot: 3,
        executed: false,
        carrierConfirmed: false,
        trigger: "guardian-vote",
      }),
      confirmCarrier: async () => "0xtx",
      getResurrectionReadiness: async () => {
        // This will be called repeatedly during waitForReadiness
        // Check if abort has been signaled
        await new Promise((r) => setTimeout(r, 50))
        return {
          exists: true,
          trigger: "guardian-vote",
          approvalCount: 0,
          approvalThreshold: 2,
          carrierConfirmed: true,
          offlineNow: true,
          readyAt: 0,
          canComplete: false, // never ready — forces polling until abort
        }
      },
      isOffline: async () => true,
    } as any

    const daemon = new CarrierDaemon(
      makeConfig({ maxConcurrentResurrections: 1, pollIntervalMs: 100_000 }),
      soul,
      createFakeIpfs(),
      createFakeCidResolver(),
      fakeLogger,
    )

    daemon.start()

    // Submit a request that will block in waitForReadiness
    const result = daemon.addRequest("0x" + "dd".repeat(32), AGENT_ID)
    expect(result.accepted).toBe(true)
    expect(daemon.getStatus().activeResurrections.length).toBe(1)

    // Give the flow time to enter waitForReadiness
    await new Promise((r) => setTimeout(r, 100))

    // Now stop — should abort the active flow and drain
    await daemon.stop()

    // After stop, the resurrection should have completed (with failure)
    expect(daemon.getStatus().running).toBe(false)
    expect(daemon.getStatus().activeResurrections.length).toBe(0)
    // History should show the failed (aborted) attempt
    const history = daemon.getStatus().history
    expect(history.length).toBe(1)
    expect(history[0].state).toBe("failed")
    expect(history[0].error).toContain("shutting down")
  })

  it("addWatch adds agents to monitor", async () => {
    const daemon = new CarrierDaemon(
      makeConfig(),
      createFakeSoul(),
      createFakeIpfs(),
      createFakeCidResolver(),
      fakeLogger,
    )

    const newAgent = "0x" + "cc".repeat(32)
    daemon.addWatch(newAgent)
    expect(daemon.getStatus().watchedAgents).toContain(newAgent)
  })
})
