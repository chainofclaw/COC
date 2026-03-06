import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface RuntimeCounterMetrics {
  pruneRemovedV1: number
  pruneRemovedV2: number
  pruneArchiveFailedV1: number
  pruneArchiveFailedV2: number
  roleMismatchV1: number
  roleMismatchV2: number
  metricsWriteFailed: number
  metricsPromWriteFailed: number
}

export interface RuntimeMetricsSnapshot {
  generatedAtMs: number
  protocolVersion: 1 | 2
  address: string
  selfNodeRegistered: boolean
  currentEpoch: number
  pendingV1: number
  pendingV2: number
  counters: RuntimeCounterMetrics
}

export function shouldWriteMetrics(
  nowMs: number,
  lastWrittenAtMs: number,
  writeIntervalMs: number,
): boolean {
  if (!Number.isFinite(writeIntervalMs) || writeIntervalMs <= 0) return true
  if (!Number.isFinite(lastWrittenAtMs) || lastWrittenAtMs <= 0) return true
  return nowMs - lastWrittenAtMs >= writeIntervalMs
}

export function writeMetricsSnapshot(path: string, snapshot: RuntimeMetricsSnapshot): void {
  writeTextAtomic(path, JSON.stringify(snapshot, null, 2))
}

export function buildPrometheusMetrics(snapshot: RuntimeMetricsSnapshot): string {
  const registered = snapshot.selfNodeRegistered ? 1 : 0
  const c = snapshot.counters
  return [
    "# HELP coc_agent_generated_at_ms Unix timestamp in milliseconds for this metrics snapshot.",
    "# TYPE coc_agent_generated_at_ms gauge",
    `coc_agent_generated_at_ms ${snapshot.generatedAtMs}`,
    "# HELP coc_agent_protocol_version Running protocol version (1=v1, 2=v2).",
    "# TYPE coc_agent_protocol_version gauge",
    `coc_agent_protocol_version ${snapshot.protocolVersion}`,
    "# HELP coc_agent_self_node_registered Whether current operator node is registered onchain.",
    "# TYPE coc_agent_self_node_registered gauge",
    `coc_agent_self_node_registered ${registered}`,
    "# HELP coc_agent_current_epoch Current runtime epoch.",
    "# TYPE coc_agent_current_epoch gauge",
    `coc_agent_current_epoch ${snapshot.currentEpoch}`,
    "# HELP coc_agent_pending_v1 Pending v1 receipt count.",
    "# TYPE coc_agent_pending_v1 gauge",
    `coc_agent_pending_v1 ${snapshot.pendingV1}`,
    "# HELP coc_agent_pending_v2 Pending v2 receipt count.",
    "# TYPE coc_agent_pending_v2 gauge",
    `coc_agent_pending_v2 ${snapshot.pendingV2}`,
    "# HELP coc_agent_prune_removed_v1_total Total stale v1 receipts removed.",
    "# TYPE coc_agent_prune_removed_v1_total counter",
    `coc_agent_prune_removed_v1_total ${c.pruneRemovedV1}`,
    "# HELP coc_agent_prune_removed_v2_total Total stale v2 receipts removed.",
    "# TYPE coc_agent_prune_removed_v2_total counter",
    `coc_agent_prune_removed_v2_total ${c.pruneRemovedV2}`,
    "# HELP coc_agent_prune_archive_failed_v1_total Total v1 prune archive failures.",
    "# TYPE coc_agent_prune_archive_failed_v1_total counter",
    `coc_agent_prune_archive_failed_v1_total ${c.pruneArchiveFailedV1}`,
    "# HELP coc_agent_prune_archive_failed_v2_total Total v2 prune archive failures.",
    "# TYPE coc_agent_prune_archive_failed_v2_total counter",
    `coc_agent_prune_archive_failed_v2_total ${c.pruneArchiveFailedV2}`,
    "# HELP coc_agent_role_mismatch_v1_total Total v1 role mismatch detections.",
    "# TYPE coc_agent_role_mismatch_v1_total counter",
    `coc_agent_role_mismatch_v1_total ${c.roleMismatchV1}`,
    "# HELP coc_agent_role_mismatch_v2_total Total v2 role mismatch detections.",
    "# TYPE coc_agent_role_mismatch_v2_total counter",
    `coc_agent_role_mismatch_v2_total ${c.roleMismatchV2}`,
    "# HELP coc_agent_metrics_write_failed_total Total JSON metrics write failures.",
    "# TYPE coc_agent_metrics_write_failed_total counter",
    `coc_agent_metrics_write_failed_total ${c.metricsWriteFailed}`,
    "# HELP coc_agent_metrics_prom_write_failed_total Total Prometheus metrics write failures.",
    "# TYPE coc_agent_metrics_prom_write_failed_total counter",
    `coc_agent_metrics_prom_write_failed_total ${c.metricsPromWriteFailed}`,
    "",
  ].join("\n")
}

export function writePrometheusMetrics(path: string, snapshot: RuntimeMetricsSnapshot): void {
  writeTextAtomic(path, buildPrometheusMetrics(snapshot))
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, content)
  renameSync(tempPath, path)
}
