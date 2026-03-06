import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  buildPrometheusMetrics,
  shouldWriteMetrics,
  writeMetricsSnapshot,
  writePrometheusMetrics,
} from "./runtime-metrics.ts"

describe("runtime-metrics", () => {
  it("shouldWriteMetrics handles interval logic", () => {
    assert.equal(shouldWriteMetrics(1000, 0, 10_000), true)
    assert.equal(shouldWriteMetrics(1000, 1000, 10_000), false)
    assert.equal(shouldWriteMetrics(10_999, 1000, 10_000), false)
    assert.equal(shouldWriteMetrics(11_000, 1000, 10_000), true)
    assert.equal(shouldWriteMetrics(1000, 900, 0), true)
  })

  it("writeMetricsSnapshot writes JSON atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-runtime-metrics-"))
    try {
      const path = join(dir, "agent-metrics.json")
      writeFileSync(path, "{\"old\":true}")

      writeMetricsSnapshot(path, {
        generatedAtMs: 123,
        protocolVersion: 2,
        address: "0xabc",
        selfNodeRegistered: true,
        currentEpoch: 7,
        pendingV1: 1,
        pendingV2: 2,
        counters: {
          pruneRemovedV1: 1,
          pruneRemovedV2: 2,
          pruneArchiveFailedV1: 3,
          pruneArchiveFailedV2: 4,
          roleMismatchV1: 5,
          roleMismatchV2: 6,
          metricsWriteFailed: 0,
          metricsPromWriteFailed: 0,
        },
      })

      assert.equal(existsSync(path), true)
      assert.equal(existsSync(`${path}.tmp`), false)
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { currentEpoch: number; counters: { roleMismatchV2: number } }
      assert.equal(parsed.currentEpoch, 7)
      assert.equal(parsed.counters.roleMismatchV2, 6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("buildPrometheusMetrics exports expected metric names", () => {
    const content = buildPrometheusMetrics({
      generatedAtMs: 123,
      protocolVersion: 2,
      address: "0xabc",
      selfNodeRegistered: true,
      currentEpoch: 7,
      pendingV1: 1,
      pendingV2: 2,
      counters: {
        pruneRemovedV1: 1,
        pruneRemovedV2: 2,
        pruneArchiveFailedV1: 3,
        pruneArchiveFailedV2: 4,
        roleMismatchV1: 5,
        roleMismatchV2: 6,
        metricsWriteFailed: 7,
        metricsPromWriteFailed: 8,
      },
    })

    assert.match(content, /coc_agent_generated_at_ms 123/)
    assert.match(content, /coc_agent_protocol_version 2/)
    assert.match(content, /coc_agent_pending_v2 2/)
    assert.match(content, /coc_agent_metrics_write_failed_total 7/)
    assert.match(content, /coc_agent_metrics_prom_write_failed_total 8/)
  })

  it("writePrometheusMetrics writes prom text atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-runtime-metrics-prom-"))
    try {
      const path = join(dir, "agent-metrics.prom")
      writeFileSync(path, "old_data 1\n")

      writePrometheusMetrics(path, {
        generatedAtMs: 123,
        protocolVersion: 1,
        address: "0xdef",
        selfNodeRegistered: false,
        currentEpoch: 9,
        pendingV1: 3,
        pendingV2: 4,
        counters: {
          pruneRemovedV1: 0,
          pruneRemovedV2: 0,
          pruneArchiveFailedV1: 0,
          pruneArchiveFailedV2: 0,
          roleMismatchV1: 0,
          roleMismatchV2: 0,
          metricsWriteFailed: 0,
          metricsPromWriteFailed: 0,
        },
      })

      assert.equal(existsSync(path), true)
      assert.equal(existsSync(`${path}.tmp`), false)
      const text = readFileSync(path, "utf-8")
      assert.match(text, /coc_agent_protocol_version 1/)
      assert.match(text, /coc_agent_pending_v1 3/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
