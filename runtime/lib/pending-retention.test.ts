import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  extractPendingV1Epoch,
  extractPendingV2Epoch,
  pruneStoreByEpoch,
  toEpochNumber,
} from "./pending-retention.ts"

class MemoryStore<T> {
  items: T[]

  constructor(items: T[]) {
    this.items = [...items]
  }

  listWhere(predicate: (item: T) => boolean): T[] {
    return this.items.filter(predicate)
  }

  removeWhere(predicate: (item: T) => boolean): number {
    const before = this.items.length
    this.items = this.items.filter((item) => !predicate(item))
    return before - this.items.length
  }
}

describe("pending-retention", () => {
  it("toEpochNumber handles bigint/string/invalid inputs", () => {
    assert.equal(toEpochNumber(12n), 12)
    assert.equal(toEpochNumber("15.9"), 15)
    assert.equal(toEpochNumber(7.8), 7)
    assert.equal(toEpochNumber(-1n), null)
    assert.equal(toEpochNumber("-2"), null)
    assert.equal(toEpochNumber(Number.NaN), null)
  })

  it("extractors read v1/v2 epochs and treat malformed items as null", () => {
    assert.equal(extractPendingV1Epoch({ challenge: { epochId: 9n } }), 9)
    assert.equal(extractPendingV1Epoch({ challenge: { epochId: "11" } }), 11)
    assert.equal(extractPendingV1Epoch({ challenge: { epochId: -1 } }), null)
    assert.equal(extractPendingV1Epoch({}), null)

    assert.equal(extractPendingV2Epoch({ evidenceLeaf: { epoch: 17n } }), 17)
    assert.equal(extractPendingV2Epoch({ evidenceLeaf: { epoch: "21.2" } }), 21)
    assert.equal(extractPendingV2Epoch({ evidenceLeaf: { epoch: "x" } }), null)
    assert.equal(extractPendingV2Epoch({}), null)
  })

  it("pruneStoreByEpoch archives and removes stale items when archive succeeds", () => {
    const store = new MemoryStore([
      { epoch: 3 },
      { epoch: 6 },
      { epoch: 9 },
      { epoch: null as number | null },
    ])

    let archivedCutoff = 0
    let archivedItems: { epoch: number | null }[] = []
    const outcome = pruneStoreByEpoch({
      nowEpoch: 12,
      retentionEpochs: 4,
      store,
      extractEpoch: (item) => item.epoch,
      archive: (items, cutoffEpoch) => {
        archivedCutoff = cutoffEpoch
        archivedItems = [...items]
        return true
      },
    })

    assert.equal(outcome.cutoffEpoch, 8)
    assert.equal(outcome.archived, true)
    assert.equal(outcome.staleCount, 3)
    assert.equal(outcome.removedCount, 3)
    assert.equal(archivedCutoff, 8)
    assert.deepEqual(archivedItems.map((x) => x.epoch), [3, 6, null])
    assert.deepEqual(store.items.map((x) => x.epoch), [9])
  })

  it("pruneStoreByEpoch keeps items when archive fails", () => {
    const store = new MemoryStore([
      { epoch: 1 },
      { epoch: 4 },
      { epoch: 10 },
    ])

    const outcome = pruneStoreByEpoch({
      nowEpoch: 12,
      retentionEpochs: 3,
      store,
      extractEpoch: (item) => item.epoch,
      archive: () => false,
    })

    assert.equal(outcome.cutoffEpoch, 9)
    assert.equal(outcome.archived, false)
    assert.equal(outcome.skippedReason, "archive_failed")
    assert.equal(outcome.staleCount, 2)
    assert.equal(outcome.removedCount, 0)
    assert.deepEqual(store.items.map((x) => x.epoch), [1, 4, 10])
  })

  it("pruneStoreByEpoch handles no-op paths", () => {
    const store = new MemoryStore([{ epoch: 8 }, { epoch: 9 }])

    const retentionDisabled = pruneStoreByEpoch({
      nowEpoch: 10,
      retentionEpochs: 0,
      store,
      extractEpoch: (item) => item.epoch,
      archive: () => true,
    })
    assert.equal(retentionDisabled.skippedReason, "retention_disabled")

    const beforeCutoff = pruneStoreByEpoch({
      nowEpoch: 3,
      retentionEpochs: 5,
      store,
      extractEpoch: (item) => item.epoch,
      archive: () => true,
    })
    assert.equal(beforeCutoff.skippedReason, "before_cutoff")

    const noStale = pruneStoreByEpoch({
      nowEpoch: 10,
      retentionEpochs: 2,
      store,
      extractEpoch: (item) => item.epoch,
      archive: () => true,
    })
    assert.equal(noStale.skippedReason, "no_stale")
  })
})
