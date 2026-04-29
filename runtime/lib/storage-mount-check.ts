/**
 * Defense added after the 2026-04-25 testnet chain halt.
 *
 * Background:
 *   The prover sidecar shared a docker volume with a validator's LevelDB
 *   directory using default rw=true mode. During a force-recreate of the
 *   validator, LevelDB's fcntl lock state entered a "half-released"
 *   condition (caused by container fs-layer + lock-state interaction)
 *   which corrupted the chain state trie. 95-min testnet halt resulted.
 *   Post-mortem: docs/incident-2026-04-25-chain-halt-post-mortem-{zh,en}.md
 *
 * Defense:
 *   At startup, prover sidecars probe whether the storage volume is
 *   mounted read-only. If not, refuse to start (configurable bypass for
 *   the validator process itself, which legitimately needs RW).
 *
 * Why a write probe instead of statfs/fstatfs(ST_RDONLY)?
 *   Docker's overlay layer doesn't always report ST_RDONLY on `:ro`
 *   bind mounts — the underlying inode is RW but the bind mount layer
 *   blocks writes via overlay rather than at the filesystem flag.
 *   Empirical write-and-unlink probe is reliable across docker versions.
 */

import { writeFile, unlink } from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export interface ProbeOpts {
  /** Optional logger for "probe inconclusive" diagnostics; defaults to silent. */
  warn?: (msg: string, data?: Record<string, unknown>) => void
}

/**
 * Returns true if `dir` is on a read-only mount, false otherwise.
 *
 * Behavior:
 *   - dir is RW → write probe succeeds → returns false
 *   - dir is RO → write probe fails with EROFS/EACCES/EPERM → returns true
 *   - dir doesn't exist → tries mkdir; if mkdir succeeds, dir is now
 *     RW (created); if mkdir fails with EROFS/EACCES → returns true
 *   - other errors (ENOTDIR, ENOSPC, etc.) → probe inconclusive,
 *     returns false (default to "not RO" so we don't false-positive
 *     reject a misconfigured but writable path)
 */
export async function probeMountIsReadOnly(dir: string, opts: ProbeOpts = {}): Promise<boolean> {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
        return true
      }
      opts.warn?.("probeMountIsReadOnly mkdir inconclusive", { dir, err: String(err) })
      return false
    }
  }
  const probe = join(dir, ".ro-probe-" + process.pid)
  try {
    await writeFile(probe, "x")
    await unlink(probe)
    return false
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") return true
    opts.warn?.("probeMountIsReadOnly write inconclusive", { dir, err: String(err) })
    return false
  }
}

export interface GateOpts {
  /**
   * Set to false to allow RW mount with a warning instead of throwing.
   * Maps to the `COC_REQUIRE_RO_STORAGE=0` env-var escape hatch in
   * runtime/coc-node.ts. Validators (which legitimately own their
   * leveldb) override via this flag.
   */
  enforce?: boolean
  log?: {
    info: (msg: string, data?: Record<string, unknown>) => void
    warn: (msg: string, data?: Record<string, unknown>) => void
    error: (msg: string, data?: Record<string, unknown>) => void
  }
}

/**
 * Gate function: probe + decide whether to throw.
 *
 * Returns the probe result for callers that want to act on it
 * (e.g. log "confirmed RO" on the happy path). Throws when
 * `enforce=true` and the mount is RW.
 */
export async function enforceReadOnlyStorage(
  storageDir: string,
  opts: GateOpts = {},
): Promise<{ readOnly: boolean }> {
  const enforce = opts.enforce ?? true
  const log = opts.log ?? {
    info: (msg, data) => console.log(`[storage-mount] ${msg}`, data ?? ""),
    warn: (msg, data) => console.warn(`[storage-mount] ${msg}`, data ?? ""),
    error: (msg, data) => console.error(`[storage-mount] ${msg}`, data ?? ""),
  }

  const readOnly = await probeMountIsReadOnly(storageDir, {
    warn: (msg, data) => log.warn(msg, data),
  })

  if (!readOnly) {
    const msg =
      `storageDir ${storageDir} is mounted RW. ` +
      `If this process is a prover sidecar sharing a validator's leveldb volume, ` +
      `this WILL eventually corrupt the chain (see incident 2026-04-25). ` +
      `Mount the volume :ro, or set COC_REQUIRE_RO_STORAGE=0 to acknowledge and bypass.`
    if (enforce) {
      log.error(msg)
      throw new Error(
        "storage volume must be read-only for prover sidecar (set COC_REQUIRE_RO_STORAGE=0 to bypass)",
      )
    }
    log.warn(msg)
  } else {
    log.info("storage mount confirmed read-only", { storageDir })
  }
  return { readOnly }
}
