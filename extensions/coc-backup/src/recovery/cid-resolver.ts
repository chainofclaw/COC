// CID Resolver: three-layer resolution from bytes32 hash to IPFS CID string
// Layer 1: Local JSON index (fastest, survives restarts)
// Layer 2: IPFS MFS well-known path (decentralized, survives node loss)
// Layer 3: On-chain CidRegistry contract (ultimate fallback, requires gas)

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cidToBytes32 } from "../backup/anchor.ts"
import type { IpfsClient } from "../ipfs-client.ts"

// ── Types ────────────────────────────────────────────────────────────────

export interface CidResolver {
  resolve(cidHash: string): Promise<string | null>
  register(cidHash: string, cid: string): Promise<void>
}

export interface CidMapEntry {
  cidHash: string
  cid: string
  registeredAt: number
}

interface CidIndex {
  version: 1
  entries: Record<string, CidMapEntry>
}

interface CidRegistryContract {
  resolveCid(cidHash: string): Promise<string>
  registerCid(cidHash: string, cid: string): Promise<string>
  isRegistered(cidHash: string): Promise<boolean>
}

interface Logger {
  info(msg: string): void
  warn(msg: string): void
}

// ── Local Index Layer ────────────────────────────────────────────────────

function emptyIndex(): CidIndex {
  return { version: 1, entries: {} }
}

async function readLocalIndex(indexPath: string): Promise<CidIndex> {
  try {
    const content = await readFile(indexPath, "utf8")
    const parsed = JSON.parse(content)
    if (parsed.version === 1 && parsed.entries) return parsed
    return emptyIndex()
  } catch {
    return emptyIndex()
  }
}

async function writeLocalIndex(indexPath: string, index: CidIndex): Promise<void> {
  const dir = join(indexPath, "..")
  await mkdir(dir, { recursive: true })
  await writeFile(indexPath, JSON.stringify(index, null, 2))
}

// ── MFS Layer ────────────────────────────────────────────────────────────

function mfsCidMapPath(agentId: string): string {
  return `/soul-backups/${agentId.slice(0, 10)}/cid-map.json`
}

async function resolveFromMfs(
  ipfs: IpfsClient,
  agentId: string,
  cidHash: string,
): Promise<string | null> {
  try {
    const path = mfsCidMapPath(agentId)
    const content = await ipfs.mfsRead(path)
    const map: Record<string, string> = JSON.parse(content)
    return map[cidHash] ?? null
  } catch {
    return null
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export interface CidResolverOptions {
  dataDir: string
  agentId: string
  ipfs: IpfsClient
  cidRegistry?: CidRegistryContract
  logger: Logger
}

/**
 * Create a CidResolver with three-layer fallback.
 */
export function createCidResolver(opts: CidResolverOptions): CidResolver {
  const indexPath = join(opts.dataDir, ".coc-backup", "cid-index.json")

  return {
    async resolve(cidHash: string): Promise<string | null> {
      // Layer 1: Local index (fast path)
      const localIndex = await readLocalIndex(indexPath)
      const localEntry = localIndex.entries[cidHash]
      if (localEntry) {
        // Verify integrity
        if (cidToBytes32(localEntry.cid) === cidHash) {
          return localEntry.cid
        }
        opts.logger.warn(`Local CID index has corrupt entry for ${cidHash}, skipping`)
      }

      // Layer 2: MFS well-known path
      const mfsResult = await resolveFromMfs(opts.ipfs, opts.agentId, cidHash)
      if (mfsResult) {
        if (cidToBytes32(mfsResult) === cidHash) {
          // Cache locally for next time
          await cacheLocally(indexPath, cidHash, mfsResult)
          return mfsResult
        }
        opts.logger.warn(`MFS CID map has corrupt entry for ${cidHash}`)
      }

      // Layer 3: On-chain CidRegistry
      if (opts.cidRegistry) {
        try {
          const onChainCid = await opts.cidRegistry.resolveCid(cidHash)
          if (onChainCid && onChainCid.length > 0) {
            if (cidToBytes32(onChainCid) === cidHash) {
              await cacheLocally(indexPath, cidHash, onChainCid)
              return onChainCid
            }
            opts.logger.warn(`On-chain CID registry has corrupt entry for ${cidHash}`)
          }
        } catch (error) {
          opts.logger.warn(`On-chain CID resolution failed: ${String(error)}`)
        }
      }

      return null
    },

    async register(cidHash: string, cid: string): Promise<void> {
      // Verify hash matches
      const computed = cidToBytes32(cid)
      if (computed !== cidHash) {
        throw new Error(`CID hash mismatch: expected ${cidHash}, got ${computed}`)
      }

      // Layer 1: Write to local index
      await cacheLocally(indexPath, cidHash, cid)

      // Layer 2: Update MFS cid-map.json
      try {
        await updateMfsCidMap(opts.ipfs, opts.agentId, cidHash, cid)
      } catch (error) {
        opts.logger.warn(`MFS CID map update failed (non-fatal): ${String(error)}`)
      }

      // Layer 3: Register on-chain (if configured)
      if (opts.cidRegistry) {
        try {
          const isRegistered = await opts.cidRegistry.isRegistered(cidHash)
          if (!isRegistered) {
            await opts.cidRegistry.registerCid(cidHash, cid)
          }
        } catch (error) {
          opts.logger.warn(`On-chain CID registration failed (non-fatal): ${String(error)}`)
        }
      }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function cacheLocally(indexPath: string, cidHash: string, cid: string): Promise<void> {
  const index = await readLocalIndex(indexPath)
  const updated: CidIndex = {
    ...index,
    entries: {
      ...index.entries,
      [cidHash]: { cidHash, cid, registeredAt: Date.now() },
    },
  }
  await writeLocalIndex(indexPath, updated)
}

async function updateMfsCidMap(
  ipfs: IpfsClient,
  agentId: string,
  cidHash: string,
  cid: string,
): Promise<void> {
  const path = mfsCidMapPath(agentId)

  // Read existing map
  let map: Record<string, string> = {}
  try {
    const existing = await ipfs.mfsRead(path)
    map = JSON.parse(existing)
  } catch {
    // No existing map, create new
  }

  map[cidHash] = cid

  // Ensure directory exists
  const dir = path.slice(0, path.lastIndexOf("/"))
  await ipfs.mfsMkdir(dir)

  // Write updated map
  const content = JSON.stringify(map, null, 2)
  await ipfs.mfsWrite(path, content)
}

/**
 * Update MFS with the latest manifest pointer for easy browsing.
 */
export async function updateMfsLatestPointer(
  ipfs: IpfsClient,
  agentId: string,
  manifestCid: string,
): Promise<void> {
  const dir = `/soul-backups/${agentId.slice(0, 10)}`
  await ipfs.mfsMkdir(dir)
  try {
    await ipfs.mfsRm(`${dir}/latest`)
  } catch {
    // May not exist yet
  }
  await ipfs.mfsCp(manifestCid, `${dir}/latest`)
}
