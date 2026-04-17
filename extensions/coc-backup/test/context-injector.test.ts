import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { injectRecoveryContext } from "../src/recovery/context-injector.ts"
import type { RecoveryResult } from "../src/types.ts"
import type { SemanticSnapshot } from "../src/backup/semantic-snapshot.ts"

const mockRecovery: RecoveryResult = {
  filesRestored: 42,
  totalBytes: 1024000,
  backupsApplied: 3,
  merkleVerified: true,
  requestedManifestCid: "QmTestManifestCid123",
  resolvedAgentId: "0xabcdef1234567890",
  anchorCheckAttempted: true,
  anchorCheckPassed: true,
  anchorCheckReason: "verified",
}

const mockSnapshot: SemanticSnapshot = {
  version: 1,
  capturedAt: "2026-04-17T10:00:00.000Z",
  tokenBudget: 8000,
  tokensUsed: 500,
  observations: [
    {
      id: 1,
      type: "decision",
      title: "Added Redis caching layer",
      facts: ["Reduced DB queries by 60%", "Added 2GB memory usage"],
      narrative: "Implemented Redis caching to reduce database load during peak hours",
      concepts: ["redis", "performance"],
      createdAt: "2026-04-17T09:30:00.000Z",
    },
    {
      id: 2,
      type: "discovery",
      title: "Found N+1 query in dashboard",
      facts: ["Dashboard fires 200 queries per page load"],
      narrative: null,
      concepts: ["sql", "orm"],
      createdAt: "2026-04-17T08:00:00.000Z",
    },
  ],
  summaries: [
    {
      request: "Optimize database performance",
      learned: "Redis + connection pool reduced latency 40%",
      completed: "Implemented caching in production",
      next_steps: "Monitor metrics, consider distributed caching",
      createdAt: "2026-04-17T09:45:00.000Z",
    },
  ],
  activeProjects: ["my-project", "other-project"],
}

describe("context-injector", () => {
  let tmpDir: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coc-injector-test-"))
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("generates RECOVERY_CONTEXT.md with full semantic context", async () => {
    const baseDir = join(tmpDir, "full-context")
    await mkdir(join(baseDir, ".coc-backup"), { recursive: true })
    await writeFile(
      join(baseDir, ".coc-backup", "semantic-snapshot.json"),
      JSON.stringify(mockSnapshot),
    )

    const outputPath = await injectRecoveryContext(baseDir, mockRecovery, "0xabcdef1234567890")

    assert.ok(outputPath.endsWith("RECOVERY_CONTEXT.md"))

    const content = await readFile(outputPath, "utf8")

    // Verify header
    assert.ok(content.includes("# Recovery Context"))
    assert.ok(content.includes("0xabcdef1234567890"))

    // Verify summaries
    assert.ok(content.includes("## Last Session Summaries"))
    assert.ok(content.includes("Optimize database performance"))
    assert.ok(content.includes("Redis + connection pool"))
    assert.ok(content.includes("Monitor metrics"))

    // Verify observations table
    assert.ok(content.includes("## Recent Observations"))
    assert.ok(content.includes("Added Redis caching layer"))
    assert.ok(content.includes("decision"))

    // Verify active projects
    assert.ok(content.includes("## Active Projects"))
    assert.ok(content.includes("my-project"))
    assert.ok(content.includes("other-project"))

    // Verify recovery integrity
    assert.ok(content.includes("## Recovery Integrity"))
    assert.ok(content.includes("Files restored: 42"))
    assert.ok(content.includes("Merkle verified: yes"))
    assert.ok(content.includes("On-chain anchor: verified"))
    assert.ok(content.includes("Backups applied: 3"))
  })

  it("generates minimal context when no semantic snapshot exists", async () => {
    const baseDir = join(tmpDir, "no-snapshot")
    await mkdir(baseDir, { recursive: true })

    const outputPath = await injectRecoveryContext(baseDir, mockRecovery, "0xtest")

    const content = await readFile(outputPath, "utf8")

    // Should still have header and integrity
    assert.ok(content.includes("# Recovery Context"))
    assert.ok(content.includes("## Note"))
    assert.ok(content.includes("No semantic memory was available"))
    assert.ok(content.includes("## Recovery Integrity"))
    assert.ok(content.includes("Files restored: 42"))

    // Should NOT have observation/summary sections
    assert.ok(!content.includes("## Last Session Summaries"))
    assert.ok(!content.includes("## Recent Observations"))
  })

  it("handles empty snapshot (no observations or summaries)", async () => {
    const baseDir = join(tmpDir, "empty-snapshot")
    await mkdir(join(baseDir, ".coc-backup"), { recursive: true })

    const emptySnapshot: SemanticSnapshot = {
      version: 1,
      capturedAt: "2026-04-17T10:00:00.000Z",
      tokenBudget: 8000,
      tokensUsed: 0,
      observations: [],
      summaries: [],
      activeProjects: [],
    }
    await writeFile(
      join(baseDir, ".coc-backup", "semantic-snapshot.json"),
      JSON.stringify(emptySnapshot),
    )

    const outputPath = await injectRecoveryContext(baseDir, mockRecovery, "0xempty")

    const content = await readFile(outputPath, "utf8")
    assert.ok(content.includes("No semantic memory was available"))
    assert.ok(content.includes("## Recovery Integrity"))
  })

  it("formats unverified anchor status correctly", async () => {
    const baseDir = join(tmpDir, "unverified-anchor")
    await mkdir(baseDir, { recursive: true })

    const failedRecovery: RecoveryResult = {
      ...mockRecovery,
      anchorCheckAttempted: true,
      anchorCheckPassed: false,
      anchorCheckReason: "merkle_root_mismatch",
    }

    await injectRecoveryContext(baseDir, failedRecovery, "0xtest")

    const content = await readFile(join(baseDir, "RECOVERY_CONTEXT.md"), "utf8")
    assert.ok(content.includes("failed (merkle_root_mismatch)"))
  })

  it("escapes pipe characters in table cells", async () => {
    const baseDir = join(tmpDir, "pipe-escape")
    await mkdir(join(baseDir, ".coc-backup"), { recursive: true })

    const snapshotWithPipes: SemanticSnapshot = {
      ...mockSnapshot,
      observations: [{
        id: 1,
        type: "decision",
        title: "Choice A | Choice B",
        facts: ["Fact with | pipe"],
        narrative: null,
        concepts: [],
        createdAt: "2026-04-17T10:00:00.000Z",
      }],
    }
    await writeFile(
      join(baseDir, ".coc-backup", "semantic-snapshot.json"),
      JSON.stringify(snapshotWithPipes),
    )

    await injectRecoveryContext(baseDir, mockRecovery, "0xtest")

    const content = await readFile(join(baseDir, "RECOVERY_CONTEXT.md"), "utf8")
    // Pipes should be escaped in table cells
    assert.ok(content.includes("Choice A \\| Choice B"))
  })
})
