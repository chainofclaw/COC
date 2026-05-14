import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  ChainEventEmitter,
  formatNewHeadsNotification,
  formatLogNotification,
} from "./chain-events.ts"
import type { BlockEvent, PendingTxEvent, LogEvent } from "./chain-events.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import type { IndexedLog } from "./storage/block-index.ts"
import { Wallet, Transaction } from "ethers"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

function makeBlock(num: bigint): ChainBlock {
  return {
    number: num,
    hash: `0x${"ab".repeat(32)}` as Hex,
    parentHash: `0x${"00".repeat(32)}` as Hex,
    proposer: "validator-1",
    timestampMs: Date.now(),
    txs: [],
    finalized: false,
    stateRoot: "0x" as Hex,
  }
}

function createSignedTx(nonce: number): Hex {
  const wallet = new Wallet(FUNDED_PK)
  const tx = Transaction.from({
    to: "0x0000000000000000000000000000000000000001",
    value: "0x1",
    nonce,
    gasLimit: "0x5208",
    gasPrice: "0x3b9aca00",
    chainId: CHAIN_ID,
    data: "0x",
  })
  tx.signature = wallet.signingKey.sign(tx.unsignedHash)
  return tx.serialized as Hex
}

function makeLog(): IndexedLog {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678" as Hex,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex],
    data: "0x0000000000000000000000000000000000000000000000000000000000000001",
    blockNumber: 1n,
    blockHash: "0xabcdef" as Hex,
    transactionHash: "0x111111" as Hex,
    transactionIndex: 0,
    logIndex: 0,
  }
}

describe("ChainEventEmitter", () => {
  it("emits and receives newBlock events", () => {
    const emitter = new ChainEventEmitter()
    const received: BlockEvent[] = []
    emitter.onNewBlock((e) => received.push(e))

    const event: BlockEvent = {
      block: makeBlock(1n),
      receipts: [{ transactionHash: "0xaaa" as Hex, status: "0x1", gasUsed: "0x5208" }],
    }
    emitter.emitNewBlock(event)

    assert.equal(received.length, 1)
    assert.equal(received[0].block.number, 1n)
    assert.equal(received[0].receipts.length, 1)
    emitter.removeAllListeners()
  })

  it("emits and receives pendingTx events", () => {
    const emitter = new ChainEventEmitter()
    const received: PendingTxEvent[] = []
    emitter.onPendingTx((e) => received.push(e))

    const event: PendingTxEvent = {
      hash: "0xdeadbeef" as Hex,
      from: "0x1234" as Hex,
      nonce: 5n,
      gasPrice: 1000000000n,
    }
    emitter.emitPendingTx(event)

    assert.equal(received.length, 1)
    assert.equal(received[0].hash, "0xdeadbeef")
    assert.equal(received[0].nonce, 5n)
    emitter.removeAllListeners()
  })

  it("emits and receives log events", () => {
    const emitter = new ChainEventEmitter()
    const received: LogEvent[] = []
    emitter.onLog((e) => received.push(e))

    const event: LogEvent = { log: makeLog() }
    emitter.emitLog(event)

    assert.equal(received.length, 1)
    assert.equal(received[0].log.blockNumber, 1n)
    emitter.removeAllListeners()
  })

  it("supports multiple listeners per event", () => {
    const emitter = new ChainEventEmitter()
    let count = 0
    emitter.onNewBlock(() => { count += 1 })
    emitter.onNewBlock(() => { count += 10 })

    emitter.emitNewBlock({ block: makeBlock(1n), receipts: [] })
    assert.equal(count, 11)
    emitter.removeAllListeners()
  })

  it("off removes specific listener", () => {
    const emitter = new ChainEventEmitter()
    let count = 0
    const handler = () => { count += 1 }
    emitter.onNewBlock(handler)

    emitter.emitNewBlock({ block: makeBlock(1n), receipts: [] })
    assert.equal(count, 1)

    emitter.offNewBlock(handler)
    emitter.emitNewBlock({ block: makeBlock(2n), receipts: [] })
    assert.equal(count, 1) // Not incremented
    emitter.removeAllListeners()
  })

  it("offPendingTx removes listener", () => {
    const emitter = new ChainEventEmitter()
    let count = 0
    const handler = () => { count += 1 }
    emitter.onPendingTx(handler)
    emitter.emitPendingTx({ hash: "0x1" as Hex, from: "0x2" as Hex, nonce: 0n, gasPrice: 0n })
    assert.equal(count, 1)

    emitter.offPendingTx(handler)
    emitter.emitPendingTx({ hash: "0x3" as Hex, from: "0x4" as Hex, nonce: 1n, gasPrice: 0n })
    assert.equal(count, 1)
    emitter.removeAllListeners()
  })

  it("offLog removes listener", () => {
    const emitter = new ChainEventEmitter()
    let count = 0
    const handler = () => { count += 1 }
    emitter.onLog(handler)
    emitter.emitLog({ log: makeLog() })
    assert.equal(count, 1)

    emitter.offLog(handler)
    emitter.emitLog({ log: makeLog() })
    assert.equal(count, 1)
    emitter.removeAllListeners()
  })

  it("removeAllListeners clears everything", () => {
    const emitter = new ChainEventEmitter()
    let count = 0
    emitter.onNewBlock(() => { count += 1 })
    emitter.onPendingTx(() => { count += 1 })
    emitter.onLog(() => { count += 1 })

    emitter.removeAllListeners()

    emitter.emitNewBlock({ block: makeBlock(1n), receipts: [] })
    emitter.emitPendingTx({ hash: "0x1" as Hex, from: "0x2" as Hex, nonce: 0n, gasPrice: 0n })
    emitter.emitLog({ log: makeLog() })

    assert.equal(count, 0)
  })

  it("listenerCount returns correct count", () => {
    const emitter = new ChainEventEmitter()
    assert.equal(emitter.listenerCount("newBlock"), 0)

    const h1 = () => {}
    const h2 = () => {}
    emitter.onNewBlock(h1)
    emitter.onNewBlock(h2)
    assert.equal(emitter.listenerCount("newBlock"), 2)

    emitter.offNewBlock(h1)
    assert.equal(emitter.listenerCount("newBlock"), 1)

    emitter.removeAllListeners()
    assert.equal(emitter.listenerCount("newBlock"), 0)
  })
})

describe("formatNewHeadsNotification", () => {
  it("formats block into eth_subscription newHeads format", async () => {
    const block = makeBlock(42n)
    block.timestampMs = 1700000000000
    const rawTx = createSignedTx(0)
    const parsed = Transaction.from(rawTx)
    block.txs = [rawTx]
    block.stateRoot = `0x${"11".repeat(32)}` as Hex
    block.baseFee = 1_000_000_000n

    const result = await formatNewHeadsNotification({
      block,
      receipts: [{
        transactionHash: parsed.hash,
        status: "0x1",
        gasUsed: "0x5208",
        logs: [{
          address: "0x0000000000000000000000000000000000000001",
          topics: [`0x${"22".repeat(32)}`],
          data: "0x",
        }],
      }],
    })
    assert.equal(result.number, "0x2a")
    assert.equal(result.hash, `0x${"ab".repeat(32)}`)
    assert.equal(result.parentHash, `0x${"00".repeat(32)}`)
    assert.equal(result.timestamp, "0x6553f100")
    assert.equal(result.gasUsed, "0x5208")
    assert.equal(result.difficulty, "0x0")
    assert.equal(result.stateRoot, `0x${"11".repeat(32)}`)
    assert.equal(result.baseFeePerGas, "0x3b9aca00")
    assert.match(result.transactionsRoot as string, /^0x[0-9a-f]{64}$/)
    assert.match(result.receiptsRoot as string, /^0x[0-9a-f]{64}$/)
    assert.match(result.logsBloom as string, /^0x[0-9a-f]{512}$/)
  })

  it("#487: includes all Cancun + finalized + size + totalDifficulty + mixHash fields (parity with eth_getBlockByNumber)", async () => {
    // Pre-fix WebSocket newHeads subscription returned 16 fields while
    // eth_getBlockByNumber returned 26 (minus `transactions` which is
    // correctly omitted for headers-only). Missing: mixHash, size,
    // totalDifficulty, withdrawals, withdrawalsRoot, blobGasUsed,
    // excessBlobGas, parentBeaconBlockRoot, finalized.
    //
    // Live testnet 88780 reproduction:
    //   WS newHeads payload keys: 16
    //   RPC eth_getBlockByNumber keys: 26 (incl. transactions)
    //   Diff (in RPC, not in WS): 10 fields
    //
    // ethers/viem feature-detect Cancun by inspecting the head — pre-fix
    // a subscription client saw a "pre-Cancun" chain while a query client
    // saw the correct Cancun fields. Same class as #481 (genesis vs
    // regular block shape drift), but on the WS notification path.
    const block = makeBlock(100n)
    block.timestampMs = 1700000000000
    block.stateRoot = `0x${"11".repeat(32)}` as Hex
    block.baseFee = 1_000_000_000n
    block.finalized = true
    block.blobGasUsed = 0x20000n
    block.excessBlobGas = 0x40000n
    block.parentBeaconBlockRoot = `0x${"55".repeat(32)}` as Hex

    const result = await formatNewHeadsNotification({
      block,
      receipts: [],
    })

    // All 25 header fields must be present (transactions is the only
    // omission vs eth_getBlockByNumber).
    const expectedKeys = [
      "baseFeePerGas", "blobGasUsed", "difficulty", "excessBlobGas", "extraData",
      "finalized", "gasLimit", "gasUsed", "hash", "logsBloom", "miner", "mixHash",
      "nonce", "number", "parentBeaconBlockRoot", "parentHash", "receiptsRoot",
      "sha3Uncles", "size", "stateRoot", "timestamp", "totalDifficulty",
      "transactionsRoot", "withdrawals", "withdrawalsRoot",
    ]
    const actualKeys = new Set(Object.keys(result))
    for (const key of expectedKeys) {
      assert.equal(
        actualKeys.has(key),
        true,
        `newHeads must include ${key} (pre-fix it was missing). Current keys: ${[...actualKeys].sort().join(",")}`,
      )
    }

    // Type/value checks for the previously-missing fields.
    assert.equal(typeof result.size, "string", "size must be hex string")
    assert.match(result.size as string, /^0x[0-9a-f]+$/, "size must be valid hex")
    assert.equal(typeof result.finalized, "boolean", "finalized must be boolean")
    assert.equal(result.finalized, true, "fixture set finalized=true → must be propagated")
    assert.equal(result.mixHash, `0x${"00".repeat(32)}`, "mixHash must be zero hash (PoS)")
    assert.equal(result.totalDifficulty, "0x0", "totalDifficulty must be 0x0 (PoS)")
    assert.deepEqual(result.withdrawals, [], "withdrawals must be empty array")
    assert.equal(
      result.withdrawalsRoot,
      "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
      "withdrawalsRoot must be EMPTY_TRIE_ROOT",
    )
    assert.equal(result.blobGasUsed, "0x20000", "blobGasUsed must propagate from block")
    assert.equal(result.excessBlobGas, "0x40000", "excessBlobGas must propagate from block")
    assert.equal(result.parentBeaconBlockRoot, `0x${"55".repeat(32)}`, "parentBeaconBlockRoot must propagate from block")

    // newHeads correctly excludes `transactions` (header-only stream).
    assert.equal(actualKeys.has("transactions"), false, "newHeads must NOT include transactions[]")
  })

  it("#487: defaults blob fields to 0x0 + finalized to false when block omits them", async () => {
    const block = makeBlock(101n)
    block.timestampMs = 1700000000000
    block.baseFee = 1_000_000_000n
    // Intentionally NOT setting finalized / blobGasUsed / excessBlobGas /
    // parentBeaconBlockRoot to test the default fallbacks.

    const result = await formatNewHeadsNotification({ block, receipts: [] })

    assert.equal(result.finalized, false, "finalized defaults to false when block.finalized is undefined")
    assert.equal(result.blobGasUsed, "0x0", "blobGasUsed defaults to 0x0")
    assert.equal(result.excessBlobGas, "0x0", "excessBlobGas defaults to 0x0")
    assert.equal(result.parentBeaconBlockRoot, `0x${"00".repeat(32)}`, "parentBeaconBlockRoot defaults to zero hash")
  })
})

describe("formatLogNotification", () => {
  it("formats log into eth_subscription logs format", () => {
    const log = makeLog()
    const result = formatLogNotification(log)

    assert.equal(result.address, log.address)
    assert.deepEqual(result.topics, log.topics)
    assert.equal(result.data, log.data)
    assert.equal(result.blockNumber, "0x1")
    assert.equal(result.transactionIndex, "0x0")
    assert.equal(result.logIndex, "0x0")
    assert.equal(result.removed, false)
  })
})
