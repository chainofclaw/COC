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

function makeBlock(num: bigint): ChainBlock {
  return {
    number: num,
    hash: "0xabcdef" as Hex,
    parentHash: "0x000000" as Hex,
    proposer: "validator-1",
    timestampMs: Date.now(),
    txs: [],
    stateRoot: "0x" as Hex,
  }
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
  it("formats block into eth_subscription newHeads format", () => {
    const block = makeBlock(42n)
    block.timestampMs = 1700000000000
    block.txs = [{ hash: "0x1" } as any, { hash: "0x2" } as any]

    const result = formatNewHeadsNotification(block)
    assert.equal(result.number, "0x2a")
    assert.equal(result.hash, "0xabcdef")
    assert.equal(result.parentHash, "0x000000")
    assert.equal(result.timestamp, "0x6553f100")
    assert.equal(result.gasUsed, "0xa410") // 2 txs * 21000 = 42000 = 0xa410
    assert.equal(result.difficulty, "0x0")
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
