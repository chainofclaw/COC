/**
 * ValidatorRegistryReader — Sprint 4 of Phase F+G.
 *
 * Off-chain mirror of ValidatorRegistry (Sprint 3) used by node/src/index.ts
 * to drive `BftCoordinator.updateValidators` from the on-chain set.
 *
 * Why an off-chain mirror at all: BFT prepare/commit votes are stake-weighted
 * with a 2/3 quorum that is recomputed on every round. Reading the active
 * set + per-validator stake from contracts on every BFT message would gate
 * BFT throughput on RPC latency. Instead, we eagerly mirror the contract
 * state in memory and refresh on event ingestion + periodic polling.
 *
 * Lifecycle:
 *   1. `init()` — paged eth_getLogs from genesis (or last-scanned block) to
 *      tip, build the active set + per-validator stake by replaying
 *      ValidatorRegistered / ValidatorDeactivated / ValidatorSlashed in
 *      block order. Persists the last-scanned block to a JSON sidecar so
 *      restarts skip the historical scan.
 *   2. `getActiveSet()` — synchronous snapshot for the BFT coordinator.
 *   3. `on("validatorAdded" | "validatorRemoved", handler)` — handler
 *      receives nodeIds when membership changes between polls.
 *   4. `start()` — sets a poll timer (default 60s) that re-scans from the
 *      last-known block to tip, emits add/remove events for the diff,
 *      updates the persisted pointer.
 *   5. `stop()` — clears the poll timer (process exit).
 *
 * Event correctness:
 *   - ValidatorRegistered → adds to active set (contract activates immediately)
 *   - ValidatorDeactivated → removes from active set (covers both
 *     operator-initiated unstake and slash-driven deactivation, since the
 *     contract emits Deactivated in both paths)
 *   - ValidatorSlashed → updates `stake` in place; does NOT itself remove
 *     (the paired Deactivated already did that for active validators)
 *   - ValidatorWithdrew is informational; the node entry is already gone
 *     from active set by the time withdraw fires
 *
 * Backward compatibility: if the configured RPC endpoint is unreachable
 * or returns no logs, `init()` succeeds with an empty active set. The
 * caller (index.ts) falls back to its hardcoded `validators` config —
 * this matches the Sprint 4 plan's "if not configured, hardcode mode".
 */

import { Contract, JsonRpcProvider, type EventLog, type Log } from "ethers"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { createLogger } from "../../node/src/logger.ts"

type Hex = `0x${string}`

const log = createLogger("validator-registry-reader")

/** Minimal ABI fragments — only what the reader needs. */
const REGISTRY_ABI = [
  "event ValidatorRegistered(bytes32 indexed nodeId, address indexed operator, uint256 stake, bytes pubkeyNode)",
  "event ValidatorDeactivated(bytes32 indexed nodeId, uint64 unstakeRequestedAt)",
  "event ValidatorSlashed(bytes32 indexed nodeId, uint256 amount, bytes32 indexed reason)",
  "function getActiveValidators() view returns (bytes32[])",
  "function activeValidatorCount() view returns (uint256)",
  "function getValidator(bytes32 nodeId) view returns (tuple(bytes32 nodeId, address operator, uint256 stake, uint64 registeredAt, uint64 unstakeRequestedAt, bool active))",
] as const

export interface ValidatorEntry {
  nodeId: Hex
  operator: Hex
  pubkey: Hex          // 65 B uncompressed (0x04 || X || Y)
  stake: bigint        // current stake (post-slashes); tracked from events
  registeredAtBlock: bigint
}

export interface ValidatorRegistryReaderConfig {
  /** RPC URL pointing at any healthy node in the cluster. */
  rpcUrl: string
  /** ValidatorRegistry contract address. */
  address: Hex
  /** Where to persist the last-scanned-block pointer (JSON sidecar). */
  persistPath?: string
  /** Periodic re-scan interval (ms). Default 60000. */
  pollIntervalMs?: number
  /** eth_getLogs page size in blocks. Default 9000 (matches Sprint 4 plan). */
  chunkSize?: number
  /** Earliest block to scan from on first run (default 0). */
  fromBlock?: bigint
}

type ReaderEvent = "validatorAdded" | "validatorRemoved"

interface PersistState {
  lastScannedBlock: string // bigint serialized as decimal string for JSON
}

export class ValidatorRegistryReader {
  private readonly cfg: Required<ValidatorRegistryReaderConfig>
  private readonly provider: JsonRpcProvider
  private readonly contract: Contract
  /** nodeId → live entry (active validators only). */
  private activeSet = new Map<Hex, ValidatorEntry>()
  /** nodeId → entry seen at any point (for stake bookkeeping after Deactivated). */
  private allKnown = new Map<Hex, ValidatorEntry>()
  private lastScannedBlock: bigint = 0n
  private listeners: { added: Array<(id: Hex) => void>; removed: Array<(id: Hex) => void> } = {
    added: [],
    removed: [],
  }
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private initialized = false

  constructor(cfg: ValidatorRegistryReaderConfig) {
    this.cfg = {
      rpcUrl: cfg.rpcUrl,
      address: cfg.address,
      persistPath: cfg.persistPath ?? "",
      pollIntervalMs: cfg.pollIntervalMs ?? 60_000,
      chunkSize: cfg.chunkSize ?? 9_000,
      fromBlock: cfg.fromBlock ?? 0n,
    }
    this.provider = new JsonRpcProvider(this.cfg.rpcUrl)
    this.contract = new Contract(this.cfg.address, REGISTRY_ABI as unknown as string[], this.provider)
  }

  /**
   * Restore last-scanned block from sidecar (if any) and replay events from
   * there to the current tip. Idempotent: safe to call once at startup.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    if (this.cfg.persistPath && existsSync(this.cfg.persistPath)) {
      try {
        const raw = await readFile(this.cfg.persistPath, "utf-8")
        const state = JSON.parse(raw) as PersistState
        this.lastScannedBlock = BigInt(state.lastScannedBlock)
      } catch (err) {
        log.warn("failed to load persisted lastScannedBlock; starting from configured fromBlock", {
          path: this.cfg.persistPath,
          error: String(err),
        })
        this.lastScannedBlock = this.cfg.fromBlock
      }
    } else {
      this.lastScannedBlock = this.cfg.fromBlock
    }

    // Snap-synced nodes don't have block history before the snap point, so
    // ValidatorRegistered events from earlier blocks aren't queryable via
    // eth_getLogs. Seed activeSet from the contract's current state via
    // getActiveValidators() + getValidator() before falling back to
    // event-based diffing for incremental updates. Without this, snap-synced
    // cores miss every validator registered before the snap-sync point and
    // BFT runs with the wrong (empty or partial) active set.
    await this.seedFromContractState()
    await this.scanToTip()
    this.initialized = true
    log.info("reader initialized", {
      address: this.cfg.address,
      activeCount: this.activeSet.size,
      lastScannedBlock: this.lastScannedBlock.toString(),
    })
  }

  /** Snapshot of the active set, sorted by nodeId for deterministic order. */
  getActiveSet(): ValidatorEntry[] {
    const entries = [...this.activeSet.values()]
    entries.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    return entries.map((e) => ({ ...e })) // copy to prevent external mutation
  }

  on(event: ReaderEvent, handler: (nodeId: Hex) => void): void {
    if (event === "validatorAdded") this.listeners.added.push(handler)
    else this.listeners.removed.push(handler)
  }

  /** Begin periodic polling. Idempotent. */
  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      this.scanToTip().catch((err) => {
        log.warn("scan tick failed (non-fatal)", { error: String(err) })
      })
    }, this.cfg.pollIntervalMs)
    if (this.pollTimer && typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref()
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * Seed activeSet from the contract's CURRENT on-chain state. Run on init
   * before event-based scanning so snap-synced nodes (whose block history
   * may not include the early ValidatorRegistered events) still see the
   * full active set. Idempotent — safe to call multiple times.
   */
  private async seedFromContractState(): Promise<void> {
    let nodeIds: Hex[] = []
    try {
      nodeIds = (await this.contract.getActiveValidators()) as Hex[]
    } catch (err) {
      log.warn("seedFromContractState: getActiveValidators failed", { error: String(err) })
      return
    }
    for (const nodeId of nodeIds) {
      try {
        const v = await this.contract.getValidator(nodeId) as {
          nodeId: Hex
          operator: Hex
          stake: bigint
          registeredAt: bigint
          unstakeRequestedAt: bigint
          active: boolean
        }
        if (!v.active) continue
        // pubkey is only emitted by ValidatorRegistered events, not retrievable
        // from contract state. Seed with empty pubkey; subsequent event replay
        // populates the full pubkey if a re-Register occurs. BFT consumes
        // operator + stake, not pubkey, so this is safe for consensus use.
        const entry: ValidatorEntry = {
          nodeId,
          operator: v.operator,
          pubkey: "0x" as Hex,
          stake: BigInt(v.stake),
          registeredAtBlock: BigInt(v.registeredAt),
        }
        this.activeSet.set(nodeId, entry)
        this.allKnown.set(nodeId, entry)
      } catch (err) {
        log.warn("seedFromContractState: getValidator failed", { nodeId, error: String(err) })
      }
    }
    log.info("seedFromContractState complete", { seeded: this.activeSet.size })
  }

  /**
   * Internal: scan logs from `lastScannedBlock + 1` to current head in
   * chunks, replay events in order, emit diff to listeners, persist.
   *
   * Race-safe: each tick reads the current head once and scans up to that
   * height. New blocks beyond head are picked up on the next tick.
   */
  private async scanToTip(): Promise<void> {
    const head = BigInt(await this.provider.getBlockNumber())
    if (head <= this.lastScannedBlock) return

    const fromStart = this.lastScannedBlock === 0n
      ? this.cfg.fromBlock
      : this.lastScannedBlock + 1n
    let from = fromStart

    while (from <= head) {
      const to = from + BigInt(this.cfg.chunkSize) - 1n > head
        ? head
        : from + BigInt(this.cfg.chunkSize) - 1n
      await this.scanChunk(from, to)
      from = to + 1n
    }

    this.lastScannedBlock = head
    await this.persist()
  }

  private async scanChunk(fromBlock: bigint, toBlock: bigint): Promise<void> {
    // Query the three event types we care about.
    const eventNames = ["ValidatorRegistered", "ValidatorDeactivated", "ValidatorSlashed"] as const

    // Run all three queries in parallel — they're independent.
    const queries = await Promise.all(
      eventNames.map((name) =>
        this.contract.queryFilter(
          this.contract.filters[name](),
          Number(fromBlock),
          Number(toBlock),
        ).catch((err) => {
          log.warn("queryFilter failed for chunk", {
            event: name,
            fromBlock: fromBlock.toString(),
            toBlock: toBlock.toString(),
            error: String(err),
          })
          return [] as Log[]
        }),
      ),
    )

    // Merge + sort by (blockNumber, logIndex) for deterministic replay order.
    const allEvents = queries
      .flat()
      .filter((e): e is EventLog => "args" in e && Array.isArray((e as EventLog).args))
      .sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
        return a.index - b.index
      })

    for (const ev of allEvents) {
      this.handleEvent(ev)
    }
  }

  /**
   * Test-only entry into the event replay pipeline. Production code should
   * not call this. Lets unit tests feed synthesized event objects without
   * standing up a real EVM provider.
   */
  _replayEventForTest(eventName: "ValidatorRegistered" | "ValidatorDeactivated" | "ValidatorSlashed", args: unknown[], blockNumber: number, index = 0): void {
    this.handleEvent({ eventName, args, blockNumber, index } as unknown as EventLog)
  }

  private handleEvent(ev: EventLog): void {
    switch (ev.eventName) {
      case "ValidatorRegistered": {
        // args: [nodeId, operator, stake, pubkeyNode]
        const nodeId = ev.args[0] as Hex
        const operator = ev.args[1] as Hex
        const stake = BigInt(ev.args[2])
        const pubkey = ev.args[3] as Hex
        const entry: ValidatorEntry = {
          nodeId,
          operator,
          pubkey,
          stake,
          registeredAtBlock: BigInt(ev.blockNumber),
        }
        this.allKnown.set(nodeId, entry)
        const wasActive = this.activeSet.has(nodeId)
        this.activeSet.set(nodeId, entry)
        if (!wasActive) this.emitAdded(nodeId)
        break
      }
      case "ValidatorDeactivated": {
        const nodeId = ev.args[0] as Hex
        if (this.activeSet.has(nodeId)) {
          this.activeSet.delete(nodeId)
          this.emitRemoved(nodeId)
        }
        break
      }
      case "ValidatorSlashed": {
        // args: [nodeId, amount, reason]
        const nodeId = ev.args[0] as Hex
        const amount = BigInt(ev.args[1])
        // Update tracked stake. We don't emit add/remove here — the
        // contract emits a paired Deactivated event when an active
        // validator is slashed, which already fires the removal listener.
        //
        // `allKnown` and `activeSet` share the same Validator object
        // reference (see ValidatorRegistered handler), so subtracting via
        // `allKnown` is sufficient — the active-set entry sees the same
        // mutation. Subtracting via both maps would double-deduct (e.g.
        // 32 ETH - 3.2 ETH would land at 25.6 ETH instead of 28.8 ETH).
        const known = this.allKnown.get(nodeId)
        if (known) {
          known.stake = known.stake > amount ? known.stake - amount : 0n
        }
        break
      }
    }
  }

  private emitAdded(nodeId: Hex): void {
    for (const h of this.listeners.added) {
      try { h(nodeId) } catch (err) {
        log.warn("validatorAdded handler threw", { nodeId, error: String(err) })
      }
    }
  }

  private emitRemoved(nodeId: Hex): void {
    for (const h of this.listeners.removed) {
      try { h(nodeId) } catch (err) {
        log.warn("validatorRemoved handler threw", { nodeId, error: String(err) })
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.cfg.persistPath) return
    try {
      await mkdir(dirname(this.cfg.persistPath), { recursive: true })
      const state: PersistState = { lastScannedBlock: this.lastScannedBlock.toString() }
      await writeFile(this.cfg.persistPath, JSON.stringify(state) + "\n")
    } catch (err) {
      log.warn("failed to persist lastScannedBlock (non-fatal)", {
        path: this.cfg.persistPath,
        error: String(err),
      })
    }
  }
}
