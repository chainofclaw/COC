export interface PendingStoreLike<T> {
  listWhere(predicate: (item: T) => boolean): T[]
  removeWhere(predicate: (item: T) => boolean): number
}

export interface PruneStoreOptions<T> {
  nowEpoch: number
  retentionEpochs: number
  store: PendingStoreLike<T>
  extractEpoch: (item: T) => number | null
  archive: (items: T[], cutoffEpoch: number) => boolean
}

export interface PruneStoreOutcome {
  cutoffEpoch: number | null
  staleCount: number
  removedCount: number
  archived: boolean
  skippedReason?: "retention_disabled" | "before_cutoff" | "no_stale" | "archive_failed"
}

export function toEpochNumber(value: unknown): number | null {
  if (typeof value === "bigint") {
    if (value < 0n) return null
    const n = Number(value)
    return Number.isFinite(n) ? Math.floor(n) : null
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

export function extractPendingV1Epoch(item: unknown): number | null {
  const epoch = (item as { challenge?: { epochId?: unknown } } | null | undefined)?.challenge?.epochId
  return toEpochNumber(epoch)
}

export function extractPendingV2Epoch(item: unknown): number | null {
  const epoch = (item as { evidenceLeaf?: { epoch?: unknown } } | null | undefined)?.evidenceLeaf?.epoch
  return toEpochNumber(epoch)
}

export function pruneStoreByEpoch<T>(options: PruneStoreOptions<T>): PruneStoreOutcome {
  const { nowEpoch, retentionEpochs, store, extractEpoch, archive } = options
  if (retentionEpochs <= 0) {
    return {
      cutoffEpoch: null,
      staleCount: 0,
      removedCount: 0,
      archived: false,
      skippedReason: "retention_disabled",
    }
  }

  const cutoffEpoch = nowEpoch - retentionEpochs
  if (cutoffEpoch <= 0) {
    return {
      cutoffEpoch,
      staleCount: 0,
      removedCount: 0,
      archived: false,
      skippedReason: "before_cutoff",
    }
  }

  const isStale = (item: T): boolean => {
    const epoch = extractEpoch(item)
    return epoch === null || epoch < cutoffEpoch
  }

  const staleItems = store.listWhere(isStale)
  if (staleItems.length === 0) {
    return {
      cutoffEpoch,
      staleCount: 0,
      removedCount: 0,
      archived: false,
      skippedReason: "no_stale",
    }
  }

  const archived = archive(staleItems, cutoffEpoch)
  if (!archived) {
    return {
      cutoffEpoch,
      staleCount: staleItems.length,
      removedCount: 0,
      archived: false,
      skippedReason: "archive_failed",
    }
  }

  const removedCount = store.removeWhere(isStale)
  return {
    cutoffEpoch,
    staleCount: staleItems.length,
    removedCount,
    archived: true,
  }
}
