/**
 * Main-thread side of the runTx worker isolation.
 *
 * Ships a single-tx execution request to a worker thread, waits with a
 * wall-clock deadline, and `terminate()`s the worker if it hangs past
 * the deadline. Unlike Promise.race(setTimeout(...)), Worker.terminate
 * stops the worker regardless of its microtask state, which is the
 * failure mode observed on testnet (§4.3 of the stability retrospective).
 *
 * Worker pool caps at 1 worker for now (single sequential tx per worker,
 * one worker shared across blocks). This is sufficient for testnet load
 * (≤5 txs per block) and keeps the hang blast radius minimal — only one
 * worker needs to be killed on hang.
 */
import { Worker } from "node:worker_threads"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createLogger } from "./logger.ts"

const log = createLogger("runtx-worker-pool")

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_ENTRY = join(__dirname, "runtx-worker-entry.ts")

export interface PreloadedAccount {
  address: string
  nonce: string
  balance: string
  codeHash?: string
  code?: string
}

export interface WorkerRunTxRequest {
  rawTx: string
  preload: PreloadedAccount[]
  blockContext: {
    blockNumber: string
    baseFeePerGas: string
    timestampSec: string
    gasLimit: string
    coinbase?: string
  }
  chainId: number
  hardfork: string
}

export interface WorkerRunTxResponse {
  ok: boolean
  gasUsed?: string
  exceptionError?: string
  createdAddress?: string
  logs?: Array<{ address: string; topics: string[]; data: string }>
  accountsAfter?: PreloadedAccount[]
  error?: string
}

export class RunTxWorkerPool {
  private worker: Worker | null = null
  private workerBusy = false
  private pendingId = 0
  private pending: Map<number, {
    resolve: (r: WorkerRunTxResponse) => void
    reject: (e: Error) => void
  }> = new Map()
  // Count of consecutive kills — used to trip a circuit breaker
  private consecutiveKills = 0
  private readonly timeoutMs: number
  private readonly maxConsecutiveKills: number

  constructor(timeoutMs: number = 10_000, maxConsecutiveKills: number = 3) {
    this.timeoutMs = timeoutMs
    this.maxConsecutiveKills = maxConsecutiveKills
  }

  /**
   * Run a tx in the worker with a hard deadline. If the deadline fires,
   * the worker is terminated and the returned promise rejects. A fresh
   * worker is spawned on the next call.
   */
  async runTx(req: WorkerRunTxRequest): Promise<WorkerRunTxResponse> {
    // Circuit breaker: too many consecutive kills => stop using worker path.
    if (this.consecutiveKills >= this.maxConsecutiveKills) {
      throw new Error(
        `runtx-worker-pool: circuit open (${this.consecutiveKills} consecutive kills); falling back`,
      )
    }

    if (this.workerBusy) {
      // Simple queue: wait for the one worker to finish.
      while (this.workerBusy) await new Promise((r) => setTimeout(r, 5))
    }

    await this.ensureWorker()
    this.workerBusy = true
    const id = ++this.pendingId

    const deadlinePromise = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`runtx-worker-pool: deadline ${this.timeoutMs}ms`)), this.timeoutMs)
      ;(t as any).unref?.()
    })

    const responsePromise = new Promise<WorkerRunTxResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    this.worker!.postMessage({ id, req })

    try {
      const res = await Promise.race([responsePromise, deadlinePromise])
      this.consecutiveKills = 0
      return res
    } catch (err) {
      // Deadline → kill + dispose worker
      log.warn("runtx-worker-pool: deadline, terminating worker", { error: String(err) })
      this.consecutiveKills++
      await this.destroyWorker()
      throw err
    } finally {
      this.pending.delete(id)
      this.workerBusy = false
    }
  }

  /** Clean shutdown on chain engine close. */
  async close(): Promise<void> {
    await this.destroyWorker()
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker) return
    this.worker = new Worker(WORKER_ENTRY, {
      execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    })
    // Don't keep the main event loop alive just because a worker is sitting
    // idle waiting for the next tx. Without this, tests (and shutdown paths)
    // would hang on process exit; runtime correctness is unaffected because
    // any in-flight runTx keeps the parent awaiting its resolve().
    this.worker.unref()
    this.worker.on("message", (msg) => {
      if (typeof msg?.id === "number" && msg.res) {
        const p = this.pending.get(msg.id)
        if (p) p.resolve(msg.res as WorkerRunTxResponse)
      }
    })
    this.worker.on("error", (err) => {
      log.warn("runtx-worker-pool: worker error", { error: String(err) })
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.worker = null
    })
    this.worker.on("exit", (code) => {
      if (code !== 0) {
        log.warn("runtx-worker-pool: worker exited unexpectedly", { code })
      }
      for (const p of this.pending.values()) p.reject(new Error(`worker exited code=${code}`))
      this.pending.clear()
      this.worker = null
    })
  }

  private async destroyWorker(): Promise<void> {
    if (!this.worker) return
    const w = this.worker
    this.worker = null
    try {
      await w.terminate()
    } catch {}
  }
}

/** Predicate: is this tx a simple transfer that the worker can handle? */
export function isSimpleTransfer(tx: {
  to?: { toString(): string } | null
  data?: Uint8Array | null
}): boolean {
  if (!tx.to) return false                 // contract creation
  if (tx.data && tx.data.length > 0) return false // contract call
  return true
}
