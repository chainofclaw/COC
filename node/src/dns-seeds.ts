/**
 * DNS Seed Discovery
 *
 * Resolves TXT records from DNS seed domains to discover
 * bootstrap peers for the network.
 *
 * TXT record format: "coc-peer:<id>:<url>"
 * Example: "coc-peer:node-1:http://192.168.1.1:19780"
 */

import { resolveTxt } from "node:dns/promises"
import type { NodePeer } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("dns-seeds")

const DNS_PEER_PREFIX = "coc-peer:"

export interface DnsSeedConfig {
  seeds: string[]      // DNS domain names to query
  timeoutMs: number    // Per-query timeout
  cacheTtlMs: number   // Cache TTL
}

const DEFAULT_CONFIG: DnsSeedConfig = {
  seeds: [],
  timeoutMs: 5_000,
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes
}

interface CacheEntry {
  peers: NodePeer[]
  expiresAt: number
}

export class DnsSeedResolver {
  private readonly cfg: DnsSeedConfig
  private cache = new Map<string, CacheEntry>()

  constructor(config?: Partial<DnsSeedConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Resolve all configured DNS seeds and return discovered peers.
   */
  async resolve(): Promise<NodePeer[]> {
    if (this.cfg.seeds.length === 0) return []

    const allPeers: NodePeer[] = []
    const seen = new Set<string>()

    for (const seed of this.cfg.seeds) {
      try {
        const peers = await this.resolveSeed(seed)
        for (const peer of peers) {
          if (!seen.has(peer.id)) {
            seen.add(peer.id)
            allPeers.push(peer)
          }
        }
      } catch (err) {
        log.error("DNS seed resolution failed", { seed, error: String(err) })
      }
    }

    if (allPeers.length > 0) {
      log.info("DNS seeds resolved", { peers: allPeers.length })
    }

    return allPeers
  }

  /**
   * Resolve a single DNS seed domain.
   */
  private async resolveSeed(domain: string): Promise<NodePeer[]> {
    // Check cache
    const now = Date.now()
    const cached = this.cache.get(domain)
    if (cached && now < cached.expiresAt) {
      return cached.peers
    }

    const peers: NodePeer[] = []

    try {
      const records = await withTimeout(resolveTxt(domain), this.cfg.timeoutMs)

      for (const record of records) {
        // TXT records may be split into chunks, join them
        const txt = record.join("")

        if (!txt.startsWith(DNS_PEER_PREFIX)) continue

        const parts = txt.slice(DNS_PEER_PREFIX.length).split(":")
        if (parts.length < 2) continue

        const id = parts[0]
        // Rejoin remaining parts in case URL contains ":"
        const url = parts.slice(1).join(":")

        if (id && url && isValidUrl(url)) {
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue
            if (isPrivateHost(parsed.hostname)) continue
          } catch { continue }
          peers.push({ id, url })
        }
      }
    } catch (err) {
      log.error("TXT record resolution failed", { domain, error: String(err) })
    }

    // Cache results
    this.cache.set(domain, {
      peers,
      expiresAt: now + this.cfg.cacheTtlMs,
    })

    return peers
  }

  clearCache(): void {
    this.cache.clear()
  }
}

function isPrivateHost(hostname: string): boolean {
  // Strip brackets from IPv6 literals (URL.hostname returns "[::1]" → "::1")
  const h = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  // Filter localhost and IPv6 loopback/private ranges
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  // IPv6 ULA (fd00::/8) and link-local (fe80::/10)
  const lower = h.toLowerCase()
  if (lower.startsWith("fd") || lower.startsWith("fe80")) return true
  // IPv4-mapped IPv6
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower
  const parts = v4.split(".")
  if (parts.length !== 4) return false
  const [a, b] = parts.map(Number)
  if (a === 10) return true                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true   // 172.16.0.0/12
  if (a === 192 && b === 168) return true             // 192.168.0.0/16
  if (a === 127) return true                          // 127.0.0.0/8
  if (a === 169 && b === 254) return true             // 169.254.0.0/16 (link-local)
  if (a === 0) return true                            // 0.0.0.0/8
  return false
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS query timeout")), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer!)
  }
}
