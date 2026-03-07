import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type PendingChallengeState = "opening" | "committed" | "revealed"

export interface PendingChallengeRecord {
  commitHash: string
  salt: string
  targetNodeId: string
  faultType: number
  evidenceLeafHash: string
  evidenceData: string
  challengerSig: string
  state: PendingChallengeState
  createdAtMs: number
  challengeId?: string
  openTxHash?: string
}

function sortRecords(records: PendingChallengeRecord[]): PendingChallengeRecord[] {
  return [...records].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs
    return a.commitHash.localeCompare(b.commitHash)
  })
}

export class PendingChallengeStore {
  private readonly records = new Map<string, PendingChallengeRecord>()
  private readonly path?: string

  constructor(path?: string) {
    this.path = path
    if (path) this.loadFromDisk()
  }

  list(): PendingChallengeRecord[] {
    return sortRecords([...this.records.values()])
  }

  get(commitHash: string): PendingChallengeRecord | undefined {
    return this.records.get(commitHash)
  }

  upsert(record: PendingChallengeRecord): void {
    this.records.set(record.commitHash, { ...record })
    this.syncToDisk()
  }

  remove(commitHash: string): boolean {
    const removed = this.records.delete(commitHash)
    if (removed) this.syncToDisk()
    return removed
  }

  get size(): number {
    return this.records.size
  }

  private loadFromDisk(): void {
    if (!this.path || !existsSync(this.path)) return
    try {
      const raw = readFileSync(this.path, "utf-8")
      const parsed = JSON.parse(raw) as PendingChallengeRecord[]
      if (!Array.isArray(parsed)) return
      for (const record of parsed) {
        if (!record || typeof record.commitHash !== "string" || record.commitHash.length === 0) continue
        this.records.set(record.commitHash, record)
      }
    } catch {
      // best-effort restore
    }
  }

  private syncToDisk(): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.list(), null, 2))
      renameSync(tmp, this.path)
    } catch {
      // best-effort persistence
    }
  }
}
