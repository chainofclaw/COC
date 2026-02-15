export interface PoseChallengerAuthorizer {
  isAllowed(senderId: string): Promise<boolean>
}

export interface CachedPoseChallengerAuthorizerOptions {
  staticAllowlist?: string[]
  cacheTtlMs?: number
  failOpen?: boolean
  dynamicResolver?: (senderId: string) => Promise<boolean>
}

interface CacheEntry {
  allowed: boolean
  expiresAtMs: number
}

const DEFAULT_CACHE_TTL_MS = 30_000

export class CachedPoseChallengerAuthorizer implements PoseChallengerAuthorizer {
  private readonly staticAllowlist: Set<string>
  private readonly cacheTtlMs: number
  private readonly failOpen: boolean
  private readonly dynamicResolver?: (senderId: string) => Promise<boolean>
  private readonly cache = new Map<string, CacheEntry>()

  constructor(opts: CachedPoseChallengerAuthorizerOptions = {}) {
    this.staticAllowlist = new Set((opts.staticAllowlist ?? []).map((x) => x.toLowerCase()))
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.failOpen = opts.failOpen === true
    this.dynamicResolver = opts.dynamicResolver
  }

  async isAllowed(senderId: string): Promise<boolean> {
    const key = senderId.trim().toLowerCase()
    if (!key) return false
    if (this.staticAllowlist.has(key)) return true
    if (!this.dynamicResolver) {
      // Backward compatibility: empty allowlist means no static restriction.
      return this.staticAllowlist.size === 0
    }

    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached && cached.expiresAtMs >= now) {
      return cached.allowed
    }

    let allowed = false
    try {
      allowed = await this.dynamicResolver(key)
    } catch {
      // Optional fail-open mode for availability-first deployments.
      allowed = this.failOpen && this.staticAllowlist.size === 0
    }

    this.cache.set(key, { allowed, expiresAtMs: now + this.cacheTtlMs })
    return allowed
  }

  clearCache(): void {
    this.cache.clear()
  }
}

export function createPoseChallengerAuthorizer(opts: CachedPoseChallengerAuthorizerOptions): PoseChallengerAuthorizer {
  return new CachedPoseChallengerAuthorizer(opts)
}
