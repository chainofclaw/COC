# Semantic Memory Backup and Recovery

## Overview

The coc-backup extension's file-level backup ensures that all of an Agent's data files can be recovered after a host failure. But an AI Agent is more than files — it has ongoing work, accumulated decision-making experience, and semantic understanding of its projects. After a traditional file-only restore, the Agent gets its raw files back but doesn't know:

- What it was working on and how far it got
- What key decisions it made and why
- What it learned from past work

The **semantic memory layer** bridges to [claude-mem](https://github.com/thedotmack/claude-mem)'s SQLite database, extracting structured observations and session summaries before backup, and formatting them into the Agent's startup context after recovery. This means a resurrected Agent doesn't just "get its files back" — it "remembers who it is and what it was doing."

### Relationship to Existing Backup

| Level | Module | What's backed up | Effect after restore |
|-------|--------|------------------|---------------------|
| File-level | change-detector + uploader | Raw files (MEMORY.md, sessions/*.jsonl, *.sqlite) | Agent gets all files back |
| Metadata-level | context-snapshot.ts | Session count, token estimate, last message time | Agent knows where the last conversation stopped |
| **Semantic-level** | **semantic-snapshot.ts + context-injector.ts** | **Structured decisions, learnings, discoveries, project context** | **Agent understands what it was doing and what it learned** |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    claude-mem plugin (runs independently)    │
│                                                             │
│  SessionStart → PostToolUse → Stop hooks                   │
│       ↓              ↓            ↓                         │
│  SDK Agent extracts structured observations + summaries     │
│       ↓                                                     │
│  ~/.claude-mem/claude-mem.db (SQLite)                       │
│  ┌──────────────────────────────────────────┐              │
│  │ observations: type, title, facts,        │              │
│  │               narrative, concepts        │              │
│  │ session_summaries: request, learned,     │              │
│  │                    completed, next_steps │              │
│  │ observations_fts: FTS5 full-text index   │              │
│  └──────────────────────────────────────────┘              │
└────────────────────────┬────────────────────────────────────┘
                         │ Read-only (node:sqlite)
┌────────────────────────┴────────────────────────────────────┐
│                    coc-backup semantic memory layer          │
│                                                             │
│  Before backup:                                             │
│  ┌─────────────────────┐    ┌──────────────────────┐       │
│  │ semantic-snapshot.ts │───→│ .coc-backup/          │      │
│  │ Read claude-mem DB   │    │ semantic-snapshot.json│      │
│  │ Token-budgeted pack  │    └──────────┬───────────┘       │
│  └─────────────────────┘               │                    │
│                                        ↓                    │
│  ┌─────────────────────┐    ┌──────────────────────┐       │
│  │ scheduler.ts        │───→│ manifest.json         │      │
│  │ _buildSemanticDigest│    │ + semanticDigest      │      │
│  └─────────────────────┘    └──────────────────────┘       │
│                                                             │
│  After restore:                                             │
│  ┌─────────────────────┐    ┌──────────────────────┐       │
│  │ context-injector.ts │───→│ RECOVERY_CONTEXT.md   │      │
│  │ Read snapshot JSON  │    │ (Markdown format)     │      │
│  │ Format recovery ctx │    └──────────────────────┘       │
│  └─────────────────────┘                                    │
│                                                             │
│  Search:                                                    │
│  ┌─────────────────────┐                                    │
│  │ memory-search.ts    │ ← soul-memory-search tool         │
│  │ Worker proxy / FTS5 │                                   │
│  └─────────────────────┘                                    │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Bridge, not embed**: coc-backup only reads claude-mem's SQLite database; it does not embed the SDK agent pipeline. Live observation capture remains claude-mem's responsibility.
2. **Self-contained recovery context**: `RECOVERY_CONTEXT.md` and `semantic-snapshot.json` are readable without the claude-mem worker, ensuring resurrection works even on carrier nodes without claude-mem.
3. **Budget at backup time**: Token budgeting happens at backup time (not recovery time); recovery only formats.
4. **Backward compatible**: `semanticDigest` is an optional manifest field; old manifests are unaffected.

---

## Semantic Snapshot

### Data Source

`semantic-snapshot.ts` reads two core tables from claude-mem's SQLite database:

**observations table** (generated by claude-mem's SDK agent after each tool use):

| Field | Purpose |
|-------|---------|
| `type` | Observation type: decision / discovery / pattern / learning / issue / explanation |
| `title` | One-line title summary |
| `facts` | Structured facts array (JSON) |
| `narrative` | Full narrative description |
| `concepts` | Associated concept tags (JSON) |
| `created_at` | Creation timestamp |

**session_summaries table** (generated by claude-mem at end of each session):

| Field | Purpose |
|-------|---------|
| `request` | What the user asked for |
| `learned` | Key information learned |
| `completed` | What work was completed |
| `next_steps` | Recommended next actions |
| `created_at` | Creation timestamp |

### Token-Budgeted Packing

The semantic snapshot uses a greedy algorithm to pack data within a token budget. Token estimate: `tokens = ceil(chars / 4)`.

Packing order:
1. **Summaries first** (higher information density) — each summary uses ~50-200 tokens to cover an entire session
2. **Observations second** — each observation uses ~20-100 tokens, providing fine-grained decision and discovery records

```
Budget: 8000 tokens (default)

Pack summaries:  [S1: 120t] [S2: 95t] [S3: 180t] ... → cumulative: 1200t
Pack observations: [O1: 80t] [O2: 45t] [O3: 60t] ... → cumulative: 6800t
                                                         stop (remaining < next entry)
```

### Output Format

```json
{
  "version": 1,
  "capturedAt": "2026-04-17T10:00:00.000Z",
  "tokenBudget": 8000,
  "tokensUsed": 6800,
  "observations": [
    {
      "id": 42,
      "type": "decision",
      "title": "Implemented Redis caching layer",
      "facts": ["Reduced DB queries by 60%", "Added 2GB memory usage"],
      "narrative": "Added Redis to reduce database load during peak hours...",
      "concepts": ["redis", "performance", "caching"],
      "createdAt": "2026-04-17T09:30:00.000Z"
    }
  ],
  "summaries": [
    {
      "request": "Optimize database performance",
      "learned": "Redis + connection pool reduced latency 40%",
      "completed": "Implemented caching in production",
      "next_steps": "Monitor metrics, consider distributed caching",
      "createdAt": "2026-04-17T09:45:00.000Z"
    }
  ],
  "activeProjects": ["api-server", "dashboard"]
}
```

### Database Location Strategy

The semantic snapshot locates the claude-mem database in this order:

1. Explicitly configured path (`semanticSnapshot.claudeMemDbPath`)
2. Default location `~/.claude-mem/claude-mem.db`

The database is opened in read-only mode. If it doesn't exist or the schema doesn't match, an empty snapshot is generated (graceful degradation).

---

## Recovery Context Injection

### When It Fires

In `orchestrator.ts`'s recovery flow, after file restoration and before writing the restore marker:

```
autoRestore / restoreFromCid
  ├── 1. On-chain lookup → CID resolution
  ├── 2. Download files → decrypt → write to disk
  ├── 3. Merkle verification + on-chain anchor verification
  ├── 4. ★ injectRecoveryContext()  ← semantic context injection
  ├── 5. Write restore-complete.json marker
  └── 6. Notify agent process to restart
```

### RECOVERY_CONTEXT.md Format

```markdown
# Recovery Context

> Restored from backup at 2026-04-17T14:00:00Z. Agent `0xabcdef...` resurrected.

## Last Session Summaries

### Apr 17, 2026
- **Working on**: Optimize database performance
- **Learned**: Redis + connection pool reduced latency 40%
- **Completed**: Implemented caching in production
- **Next Steps**: Monitor metrics, consider distributed caching

## Recent Observations

| Time  | Type      | Title                           | Key Facts                        |
|-------|-----------|---------------------------------|----------------------------------|
| 09:30 | decision  | Implemented Redis caching layer | Reduced queries by 60%           |
| 08:00 | discovery | Found N+1 query in dashboard    | Dashboard fires 200 queries/page |

## Active Projects
- api-server
- dashboard

## Snapshot Metadata
- Captured at: 2026-04-17T10:00:00Z
- Observations: 42
- Summaries: 5
- Tokens used: 6800 / 8000

## Recovery Integrity
- Files restored: 156
- Total bytes: 12,580,000
- Backups applied: 3 manifests
- Merkle verified: yes
- On-chain anchor: verified
- Agent ID: 0xabcdef1234567890
```

### Degradation Without Semantic Snapshot

If `.coc-backup/semantic-snapshot.json` doesn't exist (old backup or backup taken when claude-mem was not running), a minimal `RECOVERY_CONTEXT.md` is still generated containing only the Recovery Integrity section.

---

## On-Chain Semantic Digest Anchoring

### SemanticDigest

Optional `semanticDigest` field in the backup manifest:

```json
{
  "version": 1,
  "agentId": "0x...",
  "timestamp": "2026-04-17T10:05:00Z",
  "files": { "...": "..." },
  "merkleRoot": "0x...",
  "semanticDigest": {
    "observationCount": 42,
    "summaryCount": 5,
    "contentHash": "a1b2c3d4e5f6...",
    "snapshotTokens": 6800
  }
}
```

| Field | Description |
|-------|-------------|
| `observationCount` | Number of observations in the snapshot |
| `summaryCount` | Number of summaries in the snapshot |
| `contentHash` | SHA-256 hash of the serialized semantic content |
| `snapshotTokens` | Actual tokens used |

### Verification Path

The semantic digest requires no smart contract modifications. Verification is transitive through the existing Merkle anchoring:

```
semantic-snapshot.json → SHA-256 → contentHash
                                        ↓
semantic-snapshot.json → IPFS CID → manifest.files[path].hash
                                        ↓
manifest.files → Merkle tree → merkleRoot
                                        ↓
merkleRoot → SoulRegistry.anchorBackup() → stored on-chain
```

As long as the manifest's Merkle root matches the on-chain record, the semantic data's integrity is guaranteed.

---

## Semantic Memory Search

### soul-memory-search Tool

A resurrected Agent can use the `soul-memory-search` tool to search past memories:

```
Tool: soul-memory-search
Parameters:
  query: "Redis caching"     (required) Search text
  limit: 10                  (optional) Max results
  type: "decision"           (optional) Filter by type
```

### Search Strategy (Two-Layer Fallback)

| Priority | Strategy | Condition | Speed | Quality |
|----------|----------|-----------|-------|---------|
| 1 | claude-mem worker proxy | Worker reachable at `127.0.0.1:37777` | ~100ms | High (vector semantic search) |
| 2 | SQLite FTS5 | Restored SQLite has FTS5 index | ~10ms | Medium (full-text match) |
| 3 | SQLite LIKE | FTS unavailable | ~50ms | Low (keyword match) |

### Database Lookup Order

Search locates the database in this order:

1. `{dataDir}/memory/` — `.sqlite` or `.db` files (restored databases take priority)
2. `~/.claude-mem/claude-mem.db` (global claude-mem database)

Prioritizing the restored database ensures the Agent searches its own memories, not the host machine's.

---

## Configuration

Add the `semanticSnapshot` section to the coc-backup extension config:

```json
{
  "enabled": true,
  "rpcUrl": "http://127.0.0.1:18780",
  "ipfsUrl": "http://127.0.0.1:18790",
  "contractAddress": "0x...",
  "privateKey": "0x...",
  "semanticSnapshot": {
    "enabled": true,
    "tokenBudget": 8000,
    "maxObservations": 50,
    "maxSummaries": 10,
    "claudeMemDbPath": ""
  }
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enabled` | `true` | Enable semantic snapshot capture |
| `tokenBudget` | `8000` | Max token budget for semantic snapshot |
| `maxObservations` | `50` | Max observations to read from database |
| `maxSummaries` | `10` | Max summaries to read from database |
| `claudeMemDbPath` | `""` | Explicit path to claude-mem database (empty = auto-detect) |

### File Classification Rules

Semantic memory files in the backup classification:

| File Path | Category | Encrypted |
|-----------|----------|-----------|
| `.coc-backup/semantic-snapshot.json` | memory | No |
| `RECOVERY_CONTEXT.md` | memory | No |
| `.coc-backup/context-snapshot.json` | workspace | No |

---

## Complete Backup-Recovery Data Flow

### Backup Path (Extended)

```
1. scheduler.runBackup()
2. captureContextSnapshot(baseDir)          ← session metadata
3. captureSemanticSnapshot(baseDir, config)  ← ★ semantic snapshot
4. detectChanges(baseDir, config, prev)      ← file change detection
   └── semantic-snapshot.json included as "memory" category file
5. uploadFiles(changedFiles, ipfs, key)      ← IPFS upload
6. _buildSemanticDigest(baseDir)             ← ★ compute SHA-256 digest
7. buildManifest(agentId, entries, parent, digest) ← build manifest
   └── manifest.semanticDigest is set
8. anchorBackup(manifest, ipfs, soul)        ← on-chain anchoring
```

### Recovery Path (Extended)

```
1. autoRestore() / restoreFromCid()
2. restoreFromChain(agentId, ...)
   ├── getSoul() → validate active + has backups
   ├── getLatestBackup() → get CID hash
   ├── cidResolver.resolve() → reverse-map CID
   └── restoreFromManifestCid(cid, ...)
       ├── resolveChainFromCid() → recursively download manifest chain
       ├── verifyManifestMerkleRoot() → Merkle self-consistency check
       ├── verifyOnChainAnchor() → on-chain anchor verification
       ├── applyManifestChain() → download, decrypt, write files
       └── verifyRestoredFiles() → disk integrity verification
3. ★ injectRecoveryContext(targetDir, recovery, agentId)
   ├── Read .coc-backup/semantic-snapshot.json
   ├── Format as Markdown
   └── Write RECOVERY_CONTEXT.md
4. writeRestoreMarker()
5. notifyAgentRestart()
```

---

## Prerequisites

| Dependency | Version | Purpose | Required? |
|------------|---------|---------|-----------|
| Node.js | 22+ | `node:sqlite` built-in SQLite module | Yes |
| claude-mem | Any | Provides observation/summary data source | No (generates empty snapshot if absent) |
| claude-mem worker | Any | Semantic search proxy (port 37777) | No (falls back to SQLite FTS) |

---

## Agent Tools

The coc-backup extension now registers **13** Agent tools:

| Tool | Category | Description |
|------|----------|-------------|
| `soul-backup` | Backup | Run a backup cycle |
| `soul-restore` | Recovery | Restore from manifest CID |
| `soul-auto-restore` | Recovery | Auto-restore from on-chain data |
| `soul-status` | Status | Check registration and backup status |
| `soul-doctor` | Diagnostics | Run full health check |
| `soul-resurrection` | Resurrection | Manage owner-key resurrection requests |
| `soul-guardian-initiate` | Guardian | Initiate guardian resurrection |
| `soul-guardian-approve` | Guardian | Approve resurrection request |
| `soul-guardian-manage` | Guardian | Manage guardian list |
| `soul-recovery-initiate` | Social Recovery | Initiate ownership transfer |
| `soul-recovery-approve` | Social Recovery | Approve ownership transfer |
| `soul-carrier-request` | Carrier | Submit resurrection request to carrier daemon |
| **`soul-memory-search`** | **Semantic Memory** | **Search past observations and summaries** |

---

## Tests

The semantic memory layer adds 16 new tests (all passing):

| Test File | Count | Coverage |
|-----------|-------|----------|
| `test/semantic-snapshot.test.ts` | 6 | Snapshot capture, token budget, read/write, graceful degradation, disabled state |
| `test/context-injector.test.ts` | 5 | Full context generation, empty snapshot degradation, anchor status formatting, pipe character escaping |
| `test/memory-search.test.ts` | 5 | FTS5 search, type filtering, limit, empty database, LIKE fallback |

Total coc-backup extension tests: **63** (47 existing + 16 new), zero regressions.
