import test from "node:test"
import assert from "node:assert/strict"
import { Wallet, Transaction } from "ethers"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import { buildBlockHeaderView, computeReceiptsRoot, computeTransactionsRoot } from "./block-header.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

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

function makeBlock(txs: Hex[]): ChainBlock {
  return {
    number: 1n,
    hash: `0x${"aa".repeat(32)}` as Hex,
    parentHash: `0x${"bb".repeat(32)}` as Hex,
    proposer: "validator-1",
    timestampMs: 1_700_000_000_000,
    txs,
    finalized: false,
    gasUsed: 21_000n,
    baseFee: 1_000_000_000n,
    stateRoot: `0x${"cc".repeat(32)}` as Hex,
  }
}

test("computeTransactionsRoot returns canonical non-empty trie root", async () => {
  const root = await computeTransactionsRoot([createSignedTx(0)])
  assert.ok(/^0x[0-9a-f]{64}$/.test(root))
  assert.notEqual(root, `0x${"0".repeat(64)}`)
})

test("computeReceiptsRoot encodes typed receipt payload deterministically", async () => {
  const tx = createSignedTx(0)
  const parsed = Transaction.from(tx)
  const root = await computeReceiptsRoot([tx], [{
    transactionHash: parsed.hash,
    gasUsed: 21_000n,
    status: 1n,
    logs: [{
      address: "0x0000000000000000000000000000000000000001",
      topics: [`0x${"11".repeat(32)}`],
      data: "0x1234",
    }],
  }])
  assert.ok(/^0x[0-9a-f]{64}$/.test(root))
  assert.notEqual(root, `0x${"0".repeat(64)}`)
})

test("buildBlockHeaderView aggregates real roots and bloom", async () => {
  const tx = createSignedTx(0)
  const parsed = Transaction.from(tx)
  const header = await buildBlockHeaderView(makeBlock([tx]), [{
    transactionHash: parsed.hash,
    gasUsed: 21_000n,
    status: 1n,
    logs: [{
      address: "0x0000000000000000000000000000000000000001",
      topics: [`0x${"22".repeat(32)}`],
      data: "0x",
    }],
  }])

  assert.equal(header.stateRoot, `0x${"cc".repeat(32)}`)
  assert.equal(header.baseFeePerGas, 1_000_000_000n)
  assert.equal(header.gasUsed, 21_000n)
  assert.ok(/^0x[0-9a-f]{64}$/.test(header.transactionsRoot))
  assert.ok(/^0x[0-9a-f]{64}$/.test(header.receiptsRoot))
  assert.ok(/^0x[0-9a-f]{512}$/.test(header.logsBloom))
})
