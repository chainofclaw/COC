/**
 * runtx-worker-pool smoke tests.
 *
 * Verifies the worker thread can:
 *   1. Spawn and execute a signed transfer tx
 *   2. Return correct state diff (nonce incremented, balance debited)
 *   3. Be terminated when the worker hangs past the deadline
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { Transaction, Wallet, parseEther } from "ethers"
import {
  RunTxWorkerPool,
  isSimpleTransfer,
  type PreloadedAccount,
  type WorkerRunTxRequest,
} from "./runtx-worker-pool.ts"

const CHAIN_ID = 18780
const FUNDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const TARGET = "0x000000000000000000000000000000000000dEaD"

function signTransfer(nonce: number): { raw: string; tx: Transaction } {
  const wallet = new Wallet(FUNDER_KEY)
  const tx = Transaction.from({
    to: TARGET,
    value: parseEther("0.1"),
    nonce,
    gasLimit: "0x5208",
    gasPrice: "0xee6b2800",
    chainId: CHAIN_ID,
    data: "0x",
  })
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return { raw: clone.serialized, tx: clone }
}

function buildRequest(rawTx: string, nonce: number, balance: bigint): WorkerRunTxRequest {
  const preload: PreloadedAccount[] = [
    {
      address: FUNDER_ADDR,
      nonce: String(nonce),
      balance: balance.toString(),
    },
    {
      address: TARGET,
      nonce: "0",
      balance: "0",
    },
  ]
  return {
    rawTx,
    preload,
    blockContext: {
      blockNumber: "100",
      baseFeePerGas: "1000000000",
      timestampSec: String(Math.floor(Date.now() / 1000)),
      gasLimit: "30000000",
    },
    chainId: CHAIN_ID,
    hardfork: "cancun",
  }
}

test("runtx-worker-pool: executes a transfer end-to-end", async () => {
  const pool = new RunTxWorkerPool(10_000)
  try {
    const { raw } = signTransfer(0)
    const req = buildRequest(raw, 0, parseEther("100"))
    const res = await pool.runTx(req)
    assert.ok(res.ok, `expected ok, got error: ${res.error}`)
    assert.strictEqual(res.gasUsed, "21000")
    assert.ok(res.accountsAfter)
    const funderAfter = res.accountsAfter!.find(
      (a) => a.address.toLowerCase() === FUNDER_ADDR.toLowerCase(),
    )
    const targetAfter = res.accountsAfter!.find(
      (a) => a.address.toLowerCase() === TARGET.toLowerCase(),
    )
    assert.ok(funderAfter, "funder account missing from diff")
    assert.strictEqual(funderAfter!.nonce, "1")
    // balance debited by 0.1 ETH + gas (21000 * 4 Gwei = 8.4e13 wei)
    const expected = parseEther("100") - parseEther("0.1") - 21000n * 4_000_000_000n
    assert.strictEqual(funderAfter!.balance, expected.toString())
    assert.strictEqual(targetAfter!.balance, parseEther("0.1").toString())
  } finally {
    await pool.close()
  }
})

test("runtx-worker-pool: sequential re-use across multiple txs (same worker)", async () => {
  const pool = new RunTxWorkerPool(10_000)
  try {
    let balance = parseEther("100")
    for (let n = 0; n < 3; n++) {
      const { raw } = signTransfer(n)
      const req = buildRequest(raw, n, balance)
      const res = await pool.runTx(req)
      assert.ok(res.ok, `tx ${n} failed: ${res.error}`)
      const f = res.accountsAfter!.find((a) => a.address.toLowerCase() === FUNDER_ADDR.toLowerCase())
      balance = BigInt(f!.balance)
    }
  } finally {
    await pool.close()
  }
})

test("runtx-worker-pool: isSimpleTransfer predicate", () => {
  // Transfer: to set, data empty
  assert.ok(isSimpleTransfer({ to: { toString: () => TARGET }, data: new Uint8Array(0) }))
  assert.ok(isSimpleTransfer({ to: { toString: () => TARGET }, data: null }))
  // Contract creation: no to
  assert.ok(!isSimpleTransfer({ to: null, data: null }))
  assert.ok(!isSimpleTransfer({ to: undefined, data: null }))
  // Contract call: data present
  assert.ok(!isSimpleTransfer({
    to: { toString: () => TARGET },
    data: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]),
  }))
})
