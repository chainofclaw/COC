import type { SlashEvidence } from "../../services/verifier/anti-cheat-policy.ts"

export class EvidenceStore {
  private readonly queue: SlashEvidence[] = []
  private readonly maxSize: number

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
  }

  push(evidence: SlashEvidence): void {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift()
    }
    this.queue.push(evidence)
  }

  drain(): SlashEvidence[] {
    return this.queue.splice(0)
  }

  peek(): readonly SlashEvidence[] {
    return this.queue
  }

  get size(): number {
    return this.queue.length
  }
}
