// Context injector: generates RECOVERY_CONTEXT.md after restoration
// Reads the semantic snapshot and formats it into human/AI-readable Markdown
// so the resurrected agent immediately knows what it was working on

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RecoveryResult } from "../types.ts"
import type { SemanticSnapshot, ObservationEntry, SummaryEntry } from "../backup/semantic-snapshot.ts"

/**
 * Inject recovery context into the restored data directory.
 * Reads .coc-backup/semantic-snapshot.json and generates RECOVERY_CONTEXT.md.
 */
export async function injectRecoveryContext(
  targetDir: string,
  recovery: RecoveryResult,
  agentId: string,
): Promise<string> {
  const snapshot = await readSnapshot(targetDir)
  const markdown = buildRecoveryMarkdown(snapshot, recovery, agentId)
  const outputPath = join(targetDir, "RECOVERY_CONTEXT.md")
  await writeFile(outputPath, markdown)
  return outputPath
}

async function readSnapshot(targetDir: string): Promise<SemanticSnapshot | null> {
  const snapshotPath = join(targetDir, ".coc-backup", "semantic-snapshot.json")
  try {
    const content = await readFile(snapshotPath, "utf8")
    const parsed = JSON.parse(content)
    if (parsed.version !== 1) return null
    return parsed as SemanticSnapshot
  } catch {
    return null
  }
}

function buildRecoveryMarkdown(
  snapshot: SemanticSnapshot | null,
  recovery: RecoveryResult,
  agentId: string,
): string {
  const sections: string[] = []

  // Header
  sections.push("# Recovery Context")
  sections.push("")
  sections.push(`> Restored from backup at ${new Date().toISOString()}. Agent \`${agentId}\` resurrected.`)
  sections.push("")

  if (!snapshot || (snapshot.summaries.length === 0 && snapshot.observations.length === 0)) {
    sections.push("## Note")
    sections.push("")
    sections.push("No semantic memory was available at backup time. The agent's files have been restored but no prior work context is available.")
    sections.push("")
  } else {
    // Session summaries (highest information density)
    if (snapshot.summaries.length > 0) {
      sections.push("## Last Session Summaries")
      sections.push("")
      for (const summary of snapshot.summaries) {
        sections.push(formatSummary(summary))
      }
    }

    // Recent observations
    if (snapshot.observations.length > 0) {
      sections.push("## Recent Observations")
      sections.push("")
      sections.push("| Time | Type | Title | Key Facts |")
      sections.push("|------|------|-------|-----------|")
      for (const obs of snapshot.observations) {
        sections.push(formatObservationRow(obs))
      }
      sections.push("")
    }

    // Active projects
    if (snapshot.activeProjects.length > 0) {
      sections.push("## Active Projects")
      sections.push("")
      for (const project of snapshot.activeProjects) {
        sections.push(`- ${project}`)
      }
      sections.push("")
    }

    // Snapshot metadata
    sections.push("## Snapshot Metadata")
    sections.push("")
    sections.push(`- Captured at: ${snapshot.capturedAt}`)
    sections.push(`- Observations: ${snapshot.observations.length}`)
    sections.push(`- Summaries: ${snapshot.summaries.length}`)
    sections.push(`- Tokens used: ${snapshot.tokensUsed} / ${snapshot.tokenBudget}`)
    sections.push("")
  }

  // Recovery integrity (always present)
  sections.push("## Recovery Integrity")
  sections.push("")
  sections.push(`- Files restored: ${recovery.filesRestored}`)
  sections.push(`- Total bytes: ${recovery.totalBytes}`)
  sections.push(`- Backups applied: ${recovery.backupsApplied} manifests`)
  sections.push(`- Merkle verified: ${recovery.merkleVerified ? "yes" : "no"}`)
  sections.push(`- On-chain anchor: ${formatAnchorStatus(recovery)}`)
  if (recovery.resolvedAgentId) {
    sections.push(`- Agent ID: ${recovery.resolvedAgentId}`)
  }
  sections.push("")

  return sections.join("\n")
}

function formatSummary(summary: SummaryEntry): string {
  const lines: string[] = []
  const date = summary.createdAt ? formatDate(summary.createdAt) : "Unknown date"
  lines.push(`### ${date}`)
  if (summary.request) lines.push(`- **Working on**: ${summary.request}`)
  if (summary.learned) lines.push(`- **Learned**: ${summary.learned}`)
  if (summary.completed) lines.push(`- **Completed**: ${summary.completed}`)
  if (summary.next_steps) lines.push(`- **Next Steps**: ${summary.next_steps}`)
  lines.push("")
  return lines.join("\n")
}

function formatObservationRow(obs: ObservationEntry): string {
  const time = obs.createdAt ? formatTime(obs.createdAt) : "—"
  const title = obs.title ?? "—"
  const facts = obs.facts.length > 0
    ? obs.facts.slice(0, 2).join("; ")
    : "—"
  return `| ${time} | ${obs.type} | ${escapeTableCell(title)} | ${escapeTableCell(facts)} |`
}

function formatAnchorStatus(recovery: RecoveryResult): string {
  if (!recovery.anchorCheckAttempted) return "not checked"
  if (recovery.anchorCheckPassed) return "verified"
  return `failed (${recovery.anchorCheckReason ?? "unknown"})`
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
  } catch {
    return iso
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
  } catch {
    return iso
  }
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
