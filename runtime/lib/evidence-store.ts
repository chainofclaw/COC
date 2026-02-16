import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { SlashEvidence } from "../../services/verifier/anti-cheat-policy.ts"

export class EvidenceStore {
  private readonly queue: SlashEvidence[] = []
  private readonly maxSize: number
  private readonly persistencePath?: string

  constructor(maxSize = 1000, persistencePath?: string) {
    this.maxSize = maxSize
    this.persistencePath = persistencePath
    if (persistencePath) {
      this.loadFromDisk()
    }
  }

  push(evidence: SlashEvidence): void {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift()
    }
    this.queue.push(evidence)
    this.appendToDisk(evidence)
  }

  drain(): SlashEvidence[] {
    const items = this.queue.splice(0)
    this.syncToDisk()
    return items
  }

  peek(): readonly SlashEvidence[] {
    return this.queue
  }

  get size(): number {
    return this.queue.length
  }

  private appendToDisk(evidence: SlashEvidence): void {
    if (!this.persistencePath) return
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      appendFileSync(this.persistencePath, JSON.stringify(evidence) + "\n")
    } catch {
      // best-effort persistence
    }
  }

  private syncToDisk(): void {
    if (!this.persistencePath) return
    try {
      if (this.queue.length === 0) {
        writeFileSync(this.persistencePath, "")
      } else {
        const lines = this.queue.map((e) => JSON.stringify(e)).join("\n") + "\n"
        writeFileSync(this.persistencePath, lines)
      }
    } catch {
      // best-effort
    }
  }

  private loadFromDisk(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return
    try {
      const raw = readFileSync(this.persistencePath, "utf-8")
      const lines = raw.split("\n").filter((l) => l.trim().length > 0)
      for (const line of lines) {
        try {
          const evidence = JSON.parse(line) as SlashEvidence
          if (this.queue.length < this.maxSize) {
            this.queue.push(evidence)
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // ignore read errors
    }
  }
}
