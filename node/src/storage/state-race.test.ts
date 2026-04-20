/**
 * PersistentStateManager / state-trie concurrency stress tests.
 *
 * Hypothesis (from testnet observation, 2026-04-19):
 *   Hang in applyBlock → runTx traces back to concurrent getAccount/
 *   putAccount against the SAME address in rapid succession, observed
 *   when a single stress deployer pushed nonce=0,1,2,3,4… within a
 *   tight window. Switching to multi-account stress eliminated all
 *   hangs across 30+ minutes. These tests attempt to reproduce the
 *   race in isolation against a real LevelDB backend so the fix can
 *   be verified deterministically.
 *
 * Each test wraps its core work in a 20s hard wall-clock timeout —
 * a hang presents as Promise.race losing to the timeout, which is
 * exactly the testnet symptom (runTx never resolves).
 */
import { test } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersistentStateManager } from "./persistent-state-manager.ts"
import { PersistentStateTrie } from "./state-trie.ts"
import { LevelDatabase } from "./db.ts"
import { Address, Account } from "@ethereumjs/util"

const TIMEOUT_MS = 20_000

async function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const tm = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}: timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  })
  try {
    return await Promise.race([p, tm])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function openManager(): Promise<{
  sm: PersistentStateManager
  trie: PersistentStateTrie
  db: LevelDatabase
  dir: string
}> {
  const dir = mkdtempSync(join(tmpdir(), "coc-state-race-"))
  const db = new LevelDatabase(dir, "state")
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  return { sm, trie, db, dir }
}

async function close(ctx: { db: LevelDatabase; dir: string }): Promise<void> {
  try { await ctx.db.close() } catch {}
  try { rmSync(ctx.dir, { recursive: true, force: true }) } catch {}
}

test("state-race: 200 sequential putAccount on same address completes", async () => {
  const ctx = await openManager()
  try {
    const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    await withTimeout("sequential-put", (async () => {
      for (let i = 0; i < 200; i++) {
        const account = Account.fromAccountData({ balance: BigInt(i * 1000), nonce: BigInt(i) })
        await ctx.sm.putAccount(addr, account)
      }
    })())
    const got = await ctx.sm.getAccount(addr)
    assert.strictEqual(got?.nonce, 199n)
  } finally {
    await close(ctx)
  }
})

test("state-race: 50 concurrent putAccount on same address completes", async () => {
  const ctx = await openManager()
  try {
    const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    // Parallel puts on the same address — the suspected trigger for the
    // testnet hang. If there is a race in the trie write path, this is
    // where it should surface.
    await withTimeout("concurrent-put", Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const account = Account.fromAccountData({ balance: BigInt(i * 1000), nonce: BigInt(i) })
        return ctx.sm.putAccount(addr, account)
      }),
    ))
    // Any of the 50 nonces is acceptable — we are checking for completion, not ordering
    const got = await ctx.sm.getAccount(addr)
    assert.ok(got, "account should exist after concurrent puts")
  } finally {
    await close(ctx)
  }
})

test("state-race: interleaved get/put bursts on same address completes", async () => {
  const ctx = await openManager()
  try {
    const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    // Mirror the testnet pattern: putAccount from tx validation + getAccount
    // from EVM SLOAD running on neighbouring txs in the same block.
    await withTimeout("interleaved", Promise.all([
      (async () => {
        for (let i = 0; i < 100; i++) {
          const account = Account.fromAccountData({ balance: BigInt(i * 1000), nonce: BigInt(i) })
          await ctx.sm.putAccount(addr, account)
        }
      })(),
      (async () => {
        for (let i = 0; i < 100; i++) {
          await ctx.sm.getAccount(addr)
        }
      })(),
    ]))
  } finally {
    await close(ctx)
  }
})

test("state-race: checkpoint+put+revert cycle on same address completes", async () => {
  const ctx = await openManager()
  try {
    const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    // applyBlock checkpoints state before executing txs, commits on success,
    // reverts on failure. Simulate 50 of those cycles targeting one address.
    await withTimeout("checkpoint-cycle", (async () => {
      for (let i = 0; i < 50; i++) {
        await ctx.sm.checkpoint()
        const account = Account.fromAccountData({ balance: BigInt(i * 1000), nonce: BigInt(i) })
        await ctx.sm.putAccount(addr, account)
        if (i % 3 === 0) await ctx.sm.revert()
        else await ctx.sm.commit()
      }
    })())
  } finally {
    await close(ctx)
  }
})

test("state-race: 5 accounts × 40 puts each in parallel completes (baseline)", async () => {
  // Baseline — mirrors multi-account stress which produced 0 hangs on testnet.
  // Confirms the fixture itself isn't simply too slow to complete in 20s.
  const ctx = await openManager()
  try {
    const addrs = [
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
      "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    ].map((h) => Address.fromString(h))

    await withTimeout("multi-account-baseline", Promise.all(
      addrs.flatMap((addr) =>
        Array.from({ length: 40 }, (_, i) => {
          const account = Account.fromAccountData({ balance: BigInt(i * 1000), nonce: BigInt(i) })
          return ctx.sm.putAccount(addr, account)
        }),
      ),
    ))
  } finally {
    await close(ctx)
  }
})
