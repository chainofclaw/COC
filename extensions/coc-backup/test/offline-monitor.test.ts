import { describe, it, expect } from "vitest"
import { OfflineMonitor } from "../src/carrier/offline-monitor.ts"

function createFakeSoul(offlineAgents: Set<string>) {
  return {
    isOffline: async (agentId: string) => offlineAgents.has(agentId),
    getResurrectionConfig: async (_agentId: string) => ({ configured: true }),
  } as any
}

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe("OfflineMonitor", () => {
  it("detects offline transition and emits event", async () => {
    const offlineAgents = new Set<string>()
    const soul = createFakeSoul(offlineAgents)
    const agentId = "0x" + "a".repeat(64)

    const monitor = new OfflineMonitor(soul, {
      pollIntervalMs: 50,
      watchedAgents: [agentId],
    }, fakeLogger)

    const offlineEvents: string[] = []
    monitor.onOffline((id) => offlineEvents.push(id))
    monitor.start()

    await new Promise((r) => setTimeout(r, 100))
    expect(offlineEvents.length).toBe(0)

    offlineAgents.add(agentId)
    await new Promise((r) => setTimeout(r, 100))
    expect(offlineEvents.length).toBe(1)
    expect(offlineEvents[0]).toBe(agentId)

    // Should not re-emit
    await new Promise((r) => setTimeout(r, 100))
    expect(offlineEvents.length).toBe(1)

    monitor.stop()
  })

  it("detects online recovery", async () => {
    const offlineAgents = new Set<string>()
    const agentId = "0x" + "b".repeat(64)
    offlineAgents.add(agentId)

    const soul = createFakeSoul(offlineAgents)
    const monitor = new OfflineMonitor(soul, {
      pollIntervalMs: 50,
      watchedAgents: [agentId],
    }, fakeLogger)

    const offlineEvents: string[] = []
    monitor.onOffline((id) => offlineEvents.push(id))
    monitor.start()

    await new Promise((r) => setTimeout(r, 100))
    expect(offlineEvents.length).toBe(1)
    expect(monitor.getOfflineAgents()).toEqual([agentId])

    offlineAgents.delete(agentId)
    await new Promise((r) => setTimeout(r, 100))
    expect(monitor.getOfflineAgents()).toEqual([])

    monitor.stop()
  })

  it("addWatch and removeWatch work correctly", () => {
    const soul = createFakeSoul(new Set())
    const monitor = new OfflineMonitor(soul, {
      pollIntervalMs: 1000,
      watchedAgents: [],
    }, fakeLogger)

    const agentId = "0x" + "c".repeat(64)
    expect(monitor.getWatchedAgents()).toEqual([])

    monitor.addWatch(agentId)
    expect(monitor.getWatchedAgents()).toEqual([agentId])

    monitor.removeWatch(agentId)
    expect(monitor.getWatchedAgents()).toEqual([])
  })

  it("handles soul client errors gracefully", async () => {
    const soul = {
      isOffline: async () => { throw new Error("RPC error") },
      getResurrectionConfig: async () => ({ configured: true }),
    } as any

    const monitor = new OfflineMonitor(soul, {
      pollIntervalMs: 50,
      watchedAgents: ["0x" + "d".repeat(64)],
    }, fakeLogger)

    const offlineEvents: string[] = []
    monitor.onOffline((id) => offlineEvents.push(id))
    monitor.start()

    await new Promise((r) => setTimeout(r, 150))
    expect(offlineEvents.length).toBe(0)

    monitor.stop()
  })
})
