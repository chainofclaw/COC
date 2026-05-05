/**
 * runTx worker thread entrypoint.
 *
 * Executes a single transfer transaction in an isolated worker thread
 * using a pristine in-memory state manager. The main thread preloads
 * the two touched accounts (from + to) into the worker; the worker
 * runs @ethereumjs/vm runTx and ships back the result + state diff.
 *
 * If the worker hangs (live-node runTx lost-Promise-resolution bug,
 * docs/testnet-stability-2026-04.en.md §4.3), the main thread can
 * `Worker.terminate()` — the native-code terminate kills the worker
 * regardless of JS microtask state, which `Promise.race` timeout
 * cannot do from inside the same thread.
 *
 * Scope (MVP): legacy / EIP-1559 value transfers (tx.to set, data
 * empty or short). Contract creation and calls fall back to the
 * main-thread codepath because they can access arbitrary state slots
 * that this harness does not preload.
 */
import { parentPort, workerData } from "node:worker_threads"
import { createVM, runTx } from "@ethereumjs/vm"
import { createBlock } from "@ethereumjs/block"
import { createTxFromRLP } from "@ethereumjs/tx"
import {
  Mainnet,
  Common,
  Hardfork,
  createCustomCommon as createCommonInternal,
} from "@ethereumjs/common"
import { Account, Address, bytesToHex, hexToBytes } from "@ethereumjs/util"

interface PreloadedAccount {
  address: string            // 0x…
  nonce: string              // decimal string (bigint-safe)
  balance: string            // decimal string
  codeHash?: string          // 0x…
  code?: string              // 0x… hex bytes (optional)
}

interface WorkerRunTxRequest {
  rawTx: string              // hex (0x…)
  preload: PreloadedAccount[]
  blockContext: {
    blockNumber: string      // decimal
    baseFeePerGas: string    // decimal
    timestampSec: string     // decimal
    gasLimit: string         // decimal
    coinbase?: string
  }
  chainId: number
  hardfork: string
}

interface WorkerRunTxResponse {
  ok: boolean
  gasUsed?: string           // decimal
  exceptionError?: string
  createdAddress?: string
  logs?: Array<{ address: string; topics: string[]; data: string }>
  accountsAfter?: PreloadedAccount[]   // state diff: only touched accounts
  error?: string
}

async function handle(req: WorkerRunTxRequest): Promise<WorkerRunTxResponse> {
  try {
    const common = new Common({
      chain: { ...Mainnet, chainId: req.chainId },
      hardfork: (req.hardfork as Hardfork) ?? Hardfork.Cancun,
    })
    const vm = await createVM({ common })

    // Defensive BigInt: structured clone can reach the worker with
    // undefined slots even when the TypeScript types say string, so
    // coerce to string before BigInt and default to "0" if missing.
    const toBI = (v: string | undefined | null): bigint => BigInt(v ?? "0")

    // Preload accounts into the worker's fresh in-memory state manager.
    for (const a of req.preload) {
      const addr = Address.fromString(a.address)
      const account = Account.fromAccountData({
        nonce: toBI(a.nonce),
        balance: toBI(a.balance),
      })
      await vm.stateManager.putAccount(addr, account)
      if (a.code && a.code !== "0x") {
        await vm.stateManager.putCode(addr, hexToBytes(a.code))
      }
    }

    const tx = createTxFromRLP(hexToBytes(req.rawTx), { common })
    const block = createBlock(
      {
        header: {
          number: toBI(req.blockContext.blockNumber),
          baseFeePerGas: toBI(req.blockContext.baseFeePerGas),
          timestamp: toBI(req.blockContext.timestampSec),
          gasLimit: req.blockContext.gasLimit ? toBI(req.blockContext.gasLimit) : 30_000_000n,
          ...(req.blockContext.coinbase
            ? { coinbase: Address.fromString(req.blockContext.coinbase) }
            : {}),
        },
      },
      { common },
    )

    const result = await runTx(vm, {
      tx,
      block,
      skipHardForkValidation: true,
      skipNonce: true,
      skipBalance: true,
    })

    // Collect the post-state for every preloaded address.
    const accountsAfter: PreloadedAccount[] = []
    for (const a of req.preload) {
      const addr = Address.fromString(a.address)
      const account = await vm.stateManager.getAccount(addr)
      if (!account) continue
      accountsAfter.push({
        address: a.address,
        nonce: account.nonce.toString(),
        balance: account.balance.toString(),
      })
    }

    return {
      ok: true,
      gasUsed: result.totalGasSpent.toString(),
      exceptionError: result.execResult.exceptionError
        ? String(result.execResult.exceptionError.error)
        : undefined,
      createdAddress: result.createdAddress?.toString(),
      logs: (result.execResult.logs ?? []).map((e) => {
        const [addrBytes, topics, data] = e as [Uint8Array, Uint8Array[], Uint8Array]
        return {
          address: bytesToHex(addrBytes),
          topics: topics.map((t) => bytesToHex(t)),
          data: bytesToHex(data),
        }
      }),
      accountsAfter,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

if (!parentPort) {
  throw new Error("runtx-worker-entry must run as a worker thread")
}

// Persistent worker: handle N sequential tx requests. Main thread reuses
// the worker across blocks to amortize startup cost (~100ms first spawn,
// <1ms per reuse after createVM is cached inside common).
parentPort.on("message", async (msg) => {
  if (msg && msg.type === "shutdown") {
    process.exit(0)
  }
  if (!msg || !msg.req) return
  const res = await handle(msg.req as WorkerRunTxRequest)
  parentPort!.postMessage({ id: msg.id, res })
})

// Optional startup self-check using workerData (not required).
if (workerData?.selfTest) {
  parentPort.postMessage({ ready: true })
}
