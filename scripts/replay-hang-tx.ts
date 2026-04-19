/**
 * Offline replay of a hung tx against a pristine @ethereumjs/vm.
 *
 * Run after a hang-txs-{ts}.json is captured from testnet:
 *   node --experimental-strip-types scripts/replay-hang-tx.ts <hang-txs.json>
 *
 * Creates a fresh in-memory VM, prefunds the sender with 1M ETH so nonce/
 * balance checks pass trivially, then runs each raw tx with a 20-second
 * wall-clock timeout. If runTx returns within the timeout, the hang is
 * context-dependent (needs the real chain state). If it hangs locally
 * too, we have a minimal reproduction to file upstream.
 */
import { readFileSync } from "node:fs"
import { createVM, runTx } from "@ethereumjs/vm"
import { createTxFromRLP } from "@ethereumjs/tx"
import { createBlock } from "@ethereumjs/block"
import { Common, Mainnet, Hardfork } from "@ethereumjs/common"
import { Account, Address, hexToBytes, bytesToHex } from "@ethereumjs/util"

interface HangDump {
  timestamp: number
  blockHeight: string
  blockHash: string
  parentHash: string
  baseFee?: string
  timestampMs: number
  txs: string[]
}

const dumpPath = process.argv[2]
if (!dumpPath) {
  console.error("Usage: replay-hang-tx.ts <hang-txs.json>")
  process.exit(1)
}

const raw = readFileSync(dumpPath, "utf-8").trim()
const lines = raw.split("\n").filter((l) => l.trim())
const dumps: HangDump[] = lines.map((l) => JSON.parse(l))

console.log(`Loaded ${dumps.length} hang dump(s) from ${dumpPath}`)

const chainId = 18780
const common = new Common({ chain: { ...Mainnet, chainId }, hardfork: Hardfork.Cancun })

for (const dump of dumps) {
  console.log(`\n═══ Block h=${dump.blockHeight} (${dump.txs.length} tx) ═══`)
  console.log(`   parent=${dump.parentHash}`)
  console.log(`   baseFee=${dump.baseFee ?? "none"} timestamp=${dump.timestampMs}`)

  for (let i = 0; i < dump.txs.length; i++) {
    const rawTx = dump.txs[i]
    console.log(`\n── tx[${i}] rawPrefix=${rawTx.slice(0, 18)} len=${(rawTx.length - 2) / 2}B`)

    const vm = await createVM({ common })
    const tx = createTxFromRLP(hexToBytes(rawTx), { common })
    const sender = tx.getSenderAddress()

    // Prefund sender with 1M ETH so balance checks pass
    await vm.stateManager.putAccount(
      sender,
      Account.fromAccountData({ balance: BigInt("0x33b2e3c9fd0803ce8000000") }),
    )

    const executionBlock = createBlock(
      {
        header: {
          number: BigInt(parseInt(dump.blockHeight)),
          baseFeePerGas: dump.baseFee ? BigInt(dump.baseFee) : 0n,
          timestamp: BigInt(Math.floor(dump.timestampMs / 1000)),
          gasLimit: 30_000_000n,
        },
      },
      { common },
    )

    const started = Date.now()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("replay-hang-timeout-20s")), 20_000)
    })

    try {
      const result = await Promise.race([
        runTx(vm, { tx, block: executionBlock, skipHardForkValidation: true, skipNonce: true, skipBalance: true }),
        timeout,
      ])
      const ms = Date.now() - started
      console.log(`   ✓ completed in ${ms}ms, gasUsed=${result.totalGasSpent} status=${result.execResult.exceptionError ? "fail" : "ok"}`)
      if (result.execResult.exceptionError) {
        console.log(`     error=${result.execResult.exceptionError.error}`)
      }
    } catch (err) {
      const ms = Date.now() - started
      console.log(`   ✗ HUNG/FAILED after ${ms}ms: ${(err as Error).message}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
