/**
 * Chaos-resilience test for the 2026-04-25 incident class.
 *
 * The incident: a prover sidecar shared a validator's docker volume
 * with default rw=true mode; on validator force-recreate, LevelDB lock
 * state got corrupted and the chain stopped for 95 minutes.
 *
 * These tests pin the defense:
 *   1. Real RW directory → probe returns false (not read-only)
 *   2. Real RO directory (chmod a-w) → probe returns true
 *   3. Non-existent dir on writable parent → mkdir succeeds → returns false
 *   4. Probe inconclusive paths log a warning but default to "not RO"
 *      (don't false-positive halt a misconfigured but writable prover)
 *
 *   5. Gate enforce=true + RW mount → throws with specific error message
 *      that references the incident date
 *   6. Gate enforce=false + RW mount → warns but does NOT throw
 *      (the COC_REQUIRE_RO_STORAGE=0 escape hatch for the validator
 *      process itself)
 *   7. Gate + RO mount → logs "confirmed read-only", returns ok
 *
 * No real LevelDB / docker dependencies — pure node:fs probe semantics.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, chmodSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeMountIsReadOnly, enforceReadOnlyStorage } from "./storage-mount-check.ts"

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "coc-mount-test-"))
})

afterEach(() => {
  // Restore writability before cleanup; chmod failures shouldn't mask
  // the actual test result.
  try { chmodSync(tmpRoot, 0o755) } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("probeMountIsReadOnly", () => {
  it("returns false for a writable directory", async () => {
    const ro = await probeMountIsReadOnly(tmpRoot)
    assert.equal(ro, false, "writable tmpdir must not be flagged as RO")
  })

  it("returns true for a chmod-readonly directory", async () => {
    chmodSync(tmpRoot, 0o555)  // rwx removed for owner-write
    try {
      const ro = await probeMountIsReadOnly(tmpRoot)
      // On some systems running as root, chmod 0o555 doesn't actually
      // block writes (root bypasses DAC). Skip if that's the case.
      const isRoot = process.getuid?.() === 0
      if (isRoot && ro === false) {
        return  // root can write anywhere; can't test RO from root
      }
      assert.equal(ro, true, "chmod 0o555 dir should be detected RO (non-root)")
    } finally {
      chmodSync(tmpRoot, 0o755)
    }
  })

  it("creates dir if missing on writable parent (mkdir succeeds → returns false)", async () => {
    const child = join(tmpRoot, "new-storage-dir")
    assert.equal(existsSync(child), false)
    const ro = await probeMountIsReadOnly(child)
    assert.equal(ro, false)
    assert.equal(existsSync(child), true, "probe should have created the dir")
  })

  it("captures warnings via opts.warn for inconclusive cases (not strictly RO)", async () => {
    // Use a path component that would be ENOTDIR (parent is a file, not dir)
    const filePath = join(tmpRoot, "regular-file")
    writeFileSync(filePath, "data")
    const child = join(filePath, "cant-mkdir-here")  // parent is a file
    const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = []
    const ro = await probeMountIsReadOnly(child, {
      warn: (msg, data) => warnings.push({ msg, data }),
    })
    assert.equal(ro, false, "ENOTDIR is not 'read-only' — default to false")
    assert.ok(warnings.length >= 1, `expected at least one warning, got ${warnings.length}`)
    assert.ok(
      warnings.some((w) => w.msg.includes("inconclusive")),
      "warning should mention 'inconclusive'",
    )
  })

  it("does not leave probe files behind (writes + unlinks)", async () => {
    await probeMountIsReadOnly(tmpRoot)
    const fs = await import("node:fs/promises")
    const entries = await fs.readdir(tmpRoot)
    const probes = entries.filter((e) => e.startsWith(".ro-probe-"))
    assert.deepEqual(probes, [], "no .ro-probe-* file should remain after probe")
  })
})

describe("enforceReadOnlyStorage", () => {
  function captureLog(): { info: string[]; warn: string[]; error: string[]; logger: NonNullable<Parameters<typeof enforceReadOnlyStorage>[1]>["log"] } {
    const info: string[] = []
    const warn: string[] = []
    const error: string[] = []
    const logger = {
      info: (msg: string) => info.push(msg),
      warn: (msg: string) => warn.push(msg),
      error: (msg: string) => error.push(msg),
    }
    return { info, warn, error, logger }
  }

  it("throws on RW mount when enforce=true (default)", async () => {
    const { logger, error } = captureLog()
    await assert.rejects(
      () => enforceReadOnlyStorage(tmpRoot, { enforce: true, log: logger }),
      /storage volume must be read-only/,
    )
    assert.ok(error.length > 0, "error log should be emitted")
    assert.ok(
      error[0].includes("incident 2026-04-25"),
      `error message should reference incident date; got: ${error[0]}`,
    )
  })

  it("warns but does NOT throw on RW mount when enforce=false (validator bypass path)", async () => {
    const { logger, warn, error } = captureLog()
    const result = await enforceReadOnlyStorage(tmpRoot, { enforce: false, log: logger })
    assert.equal(result.readOnly, false)
    assert.ok(warn.length > 0, "warn should fire")
    assert.equal(error.length, 0, "no error log when enforce=false")
  })

  it("logs 'confirmed read-only' on RO mount and does not throw", async () => {
    chmodSync(tmpRoot, 0o555)
    try {
      const isRoot = process.getuid?.() === 0
      if (isRoot) {
        // root can always write, can't make this assertion under root
        return
      }
      const { logger, info, error } = captureLog()
      const result = await enforceReadOnlyStorage(tmpRoot, { enforce: true, log: logger })
      assert.equal(result.readOnly, true)
      assert.ok(
        info.some((m) => m.includes("confirmed read-only")),
        "should emit confirmation log",
      )
      assert.equal(error.length, 0)
    } finally {
      chmodSync(tmpRoot, 0o755)
    }
  })

  it("default enforce=true matches prover-sidecar deployment policy", async () => {
    // Sanity: omitting `enforce` should behave the same as explicit
    // `enforce: true`. This guards against a future refactor accidentally
    // flipping the default.
    const { logger } = captureLog()
    await assert.rejects(
      () => enforceReadOnlyStorage(tmpRoot, { log: logger }),
      /must be read-only/,
    )
  })

  it("incident-anchor message helps future operators connect dots", async () => {
    const { logger, error } = captureLog()
    await assert.rejects(
      () => enforceReadOnlyStorage(tmpRoot, { enforce: true, log: logger }),
    )
    // The error message must be specific enough that someone hitting
    // it grepping for "incident" will find the post-mortem doc.
    assert.ok(
      error[0].includes("2026-04-25"),
      "error message must reference incident date",
    )
    assert.ok(
      error[0].includes("prover sidecar"),
      "error message must explain which deployment role is at risk",
    )
    assert.ok(
      error[0].includes("COC_REQUIRE_RO_STORAGE"),
      "error message must point to the escape hatch env var",
    )
  })
})

// ─── Documenting the 2026-04-25 incident scenario as a regression pin ───
//
// The incident sequence:
//   1. prover sidecar runs with -v node1-data:/data/coc (default RW)
//   2. validator (node-1) is force-recreated
//   3. LevelDB LOCK state gets stomped by the prover's mere presence
//   4. After ~60s, a LevelDB compaction fails and wipes state trie
//   5. chain halts because BFT can't reach quorum on stateRoot
//
// Step 1 is exactly what the new defense catches. Without the gate,
// the prover starts and the corruption window opens. With the gate,
// the prover refuses to start before any damage is possible.
describe("regression pin: 2026-04-25 incident pattern", () => {
  it("blocks the deployment that caused the 95-min testnet halt", async () => {
    // Simulate the exact mistake: prover sidecar pointed at a
    // shared-with-validator directory that's still RW.
    const sharedValidatorDir = join(tmpRoot, "data", "coc")
    mkdirSync(sharedValidatorDir, { recursive: true })
    // Pretend leveldb-state is in there (validator was using it)
    const ldbDir = join(sharedValidatorDir, "leveldb-state")
    mkdirSync(ldbDir)

    // Prover startup sequence — would silently corrupt chain in the
    // old code. Now it must throw before any damage is possible.
    const { logger, error } = captureLog()
    await assert.rejects(
      () =>
        enforceReadOnlyStorage(sharedValidatorDir, {
          enforce: true,
          log: logger,
        }),
      (err: Error) => {
        return (
          err.message.includes("must be read-only") &&
          error.some((e) => e.includes("WILL eventually corrupt"))
        )
      },
      "deploying a prover sidecar with RW shared volume must throw before damage occurs",
    )

    // Sanity: the validator's existing leveldb-state dir is untouched
    assert.equal(existsSync(ldbDir), true, "validator's data must not be modified by the failed probe")
  })

  it("validator process can opt out via COC_REQUIRE_RO_STORAGE=0 (it owns its volume)", async () => {
    // The same physical volume, but this is the validator process itself.
    // It legitimately needs RW. Setting enforce=false (mapped from the
    // env var in coc-node.ts) lets it through with a warning.
    const validatorDir = join(tmpRoot, "data", "coc")
    mkdirSync(validatorDir, { recursive: true })
    const { logger, warn } = captureLog()
    const result = await enforceReadOnlyStorage(validatorDir, {
      enforce: false,
      log: logger,
    })
    assert.equal(result.readOnly, false)
    assert.ok(
      warn.some((w) => w.includes("WILL eventually corrupt")),
      "validator opt-out should still get the explicit warning logged",
    )
  })
})

function captureLog(): { info: string[]; warn: string[]; error: string[]; logger: NonNullable<Parameters<typeof enforceReadOnlyStorage>[1]>["log"] } {
  const info: string[] = []
  const warn: string[] = []
  const error: string[] = []
  return {
    info, warn, error,
    logger: {
      info: (msg: string) => info.push(msg),
      warn: (msg: string) => warn.push(msg),
      error: (msg: string) => error.push(msg),
    },
  }
}
