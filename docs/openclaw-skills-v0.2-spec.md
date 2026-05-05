# OpenClaw COC Skills v0.2 — Specification

> **Audience**: skill implementers, OpenClaw plugin reviewers.
> **Scope**: contract for the four new skills shipping with `coc-nodeops`
> v0.2 (90-day roadmap Weeks 7–8). The CLI surface, JSON output schemas,
> and exit codes are FROZEN by this spec; implementations may evolve
> internals freely.
> **Status**: spec frozen 2026-05-05. Implementation `pose-status`
> shipping in this session as the canonical example; `chain-stats`,
> `health`, `upgrade` deferred to follow-up sessions.

## 0. Common conventions / 公共约定

All four skills follow:

- **Invocation**: `openclaw coc <skill-name> [flags]`. Each skill is a
  self-contained Node CLI script that reads `~/.coc/nodeops.json` for
  defaults and accepts `--node <id>` to target a specific node.
- **Output mode**: human-readable by default; `--json` flips to a
  structured JSON object on stdout, with diagnostics on stderr.
- **Exit codes**:
  - `0`: success
  - `1`: skill-specific error (per-skill enum below)
  - `2`: usage error (bad flags)
  - `3`: target node unreachable / RPC timeout
  - `4`: authentication failure (admin RPC token mismatch)
- **Standard flags** (every skill must accept):
  - `--node <id>`: select node from `~/.coc/nodeops.json` (default: `default`)
  - `--rpc <url>`: bypass config, hit URL directly
  - `--auth-token <token>`: admin RPC token (also reads `COC_RPC_AUTH_TOKEN`)
  - `--json`: structured output
  - `--timeout-ms <n>`: RPC call timeout (default 5000)
  - `--help`: print synopsis + exit 2

- **Naming guard**: never use `openclaw` in human-facing strings except
  in flag/path names. Per CLAUDE.md: "OpenClaw" for product/UI,
  `openclaw` for CLI/path/config.

## 1. `openclaw coc pose-status`

**Purpose / 用途**: report the PoSe epoch state and per-node challenge
metrics in a single roll-up. Replaces the manual chain of
`curl /pose/status` + `coc_chainStats` + `coc-relayer` log scraping.

**Synopsis**:

```
openclaw coc pose-status [--node <id>] [--epoch <n>] [--json] [--watch]
```

**Flags (skill-specific)**:

- `--epoch <n>`: report on a past epoch instead of the current; rejects
  if `<n>` is older than `epochRetentionDepth`.
- `--watch`: re-run every 5 seconds, redrawing in place; stops on Ctrl-C
  or first failure. Conflicts with `--json`.

**JSON schema (--json output)**:

```jsonc
{
  "schemaVersion": "0.2",
  "skill": "coc.pose-status",
  "node": {
    "id": "0xf39f…b92266",
    "rpc": "http://127.0.0.1:18780",
    "version": "COC/0.2"
  },
  "epoch": {
    "current": 142,
    "queriedEpoch": 142,
    "startedAtMs": 1714900000000,
    "ageMs": 14732
  },
  "metrics": {
    "challengesIssued": 38,
    "receiptsVerified": 36,
    "receiptsPending": 2,
    "rewardPoolWei": "1500000000000000000",
    "slashTotalWei": "0"
  },
  "health": {
    "ok": true,
    "issues": []
  }
}
```

**Skill-specific exit codes (within `1`)**:

- Pretty-printed banner identifies the failing leg in human mode; JSON
  mode encodes via the `health.issues` array.

**Backing RPC calls**: `coc_nodeInfo`, `coc_chainStats`, `coc_poseStatus`
(adminRpc-gated), `coc_getEquivocations`. All read-only.

## 2. `openclaw coc chain-stats`

**Purpose / 用途**: TPS + gas + validator activity over a sliding window.
Replaces ad-hoc explorer-screenshot workflows.

**Synopsis**:

```
openclaw coc chain-stats [--node <id>] [--window <duration>] [--validators] [--json]
```

**Flags (skill-specific)**:

- `--window <duration>`: time window (e.g. `5m`, `1h`, `24h`). Default `5m`.
- `--validators`: include per-validator block production breakdown.

**JSON schema**:

```jsonc
{
  "schemaVersion": "0.2",
  "skill": "coc.chain-stats",
  "node": { "id": "...", "rpc": "..." },
  "window": { "startMs": 0, "endMs": 0, "durationMs": 0 },
  "blocks": {
    "count": 200,
    "tipHeight": 207000,
    "minBaseFeeWei": "1000000000",
    "maxBaseFeeWei": "1000000000",
    "avgGasUsed": 21000
  },
  "tps": { "total": 12.5, "median": 11.0 },
  "validators": [
    { "id": "0x...", "blocksProposed": 67, "missedRotations": 0 }
  ]
}
```

**Backing**: `coc_chainStats`, `eth_getBlockByNumber` for sampled blocks,
`coc_validatorActivity`.

## 3. `openclaw coc health`

**Purpose / 用途**: aggregated health diagnostic — composes the existing
`coc_diagnostics` output with skill-side checks (BFT progress, sync gap,
validator rotation participation, mempool size). Returns a single
boolean + a list of issues.

**Synopsis**:

```
openclaw coc health [--node <id>] [--json] [--strict]
```

**Flags (skill-specific)**:

- `--strict`: fail (exit 1) if any WARN-level check trips, not just CRIT.

**JSON schema**:

```jsonc
{
  "schemaVersion": "0.2",
  "skill": "coc.health",
  "node": { "id": "...", "rpc": "..." },
  "ok": true,
  "checks": [
    { "name": "rpc.reachable",      "level": "ok",   "detail": "responded in 12ms" },
    { "name": "bft.progress",       "level": "ok",   "detail": "last finalized 3s ago" },
    { "name": "sync.gap",           "level": "warn", "detail": "5 blocks behind tip" },
    { "name": "mempool.size",       "level": "ok",   "detail": "12 / 5000" },
    { "name": "validator.rotation", "level": "ok",   "detail": "proposed 3/3 in last window" }
  ]
}
```

**Levels**: `ok` | `warn` | `crit`. With `--strict`, `warn` is treated as failure.

## 4. `openclaw coc upgrade`

**Purpose / 用途**: dry-run + apply node binary/image upgrade. Wraps
`docker pull` + container recreate + post-upgrade health verification.
Shipping with `dry-run` first (no-op apply), making `--apply` a Phase L
follow-up.

**Synopsis**:

```
openclaw coc upgrade [--node <id>] [--target <tag>] [--apply] [--json]
```

**Flags (skill-specific)**:

- `--target <tag>`: docker image tag to upgrade to (default: `latest`).
- `--apply`: actually perform the upgrade; without it, prints the plan
  and exits 0.

**JSON schema (dry-run)**:

```jsonc
{
  "schemaVersion": "0.2",
  "skill": "coc.upgrade",
  "node": { "id": "...", "rpc": "..." },
  "current": { "image": "ghcr.io/.../coc-node@sha256:abc...", "version": "COC/0.2" },
  "target":  { "image": "ghcr.io/.../coc-node:latest",        "digest":  "sha256:def..." },
  "actions": [
    { "step": "docker pull",            "skipped": false },
    { "step": "docker compose up -d",   "skipped": false },
    { "step": "wait for health.ok",     "skipped": false }
  ],
  "applied": false
}
```

**Apply mode** sets `applied: true` and adds a `result` field with each
step's actual exit code.

**Safety bars**:

- `--apply` requires `COC_OPS_CONFIRM=1` env or `--yes` to proceed.
- Aborts if the validator is currently the expected proposer for the
  next 3 heights (would induce stuck-round per J2.2's recovery path).
- Post-upgrade validation polls `coc.health` for ≤60 s; if not green,
  rolls back via `docker compose up -d --no-deps <node>` of the previous
  image tag.

## 5. Cross-cutting requirements

### 5.1 Error encoding

All non-zero exits write to stderr (human mode) or stdout (`--json`) a
JSON object:

```jsonc
{
  "error": {
    "code": "POSE_RPC_TIMEOUT",
    "message": "human-readable",
    "skill": "coc.pose-status",
    "remediation": "increase --timeout-ms or check node health"
  }
}
```

### 5.2 Telemetry

Each invocation emits one structured log line to
`~/.coc/skills/skill-history.ndjson`:

```jsonc
{ "ts": "...", "skill": "coc.pose-status", "exitCode": 0, "durationMs": 142 }
```

Used by future automation to correlate skill failures with chain events.

### 5.3 Test contract

Every skill ships with a `*.test.ts` covering:

- Happy path (mock RPC returns canonical fixture)
- RPC timeout (exit 3)
- Bad flags (exit 2)
- `--json` schema conforms to the spec (validated via `ajv`)

### 5.4 Versioning

`schemaVersion: "0.2"` is the contract for these skills. Bumping the
JSON schema requires either:

1. Backwards-compatible additive change (new optional fields) — bump to
   `0.2.x` (no spec freeze churn).
2. Breaking change — bump to `0.3` and update this spec; coordinate a
   release of `coc-nodeops` accordingly.

## 6. Out of scope (Phase L follow-ups)

- Skill discovery via OpenClaw plugin marketplace listing
- Cross-skill orchestration (e.g. `health → upgrade if green`)
- Per-skill rate limiting (handled by the underlying RPC layer's
  `rate-limiter.ts` for now)

---

**Cross-references**

- Roadmap: `docs/90-day-release-roadmap.zh-en.md` Week 7–8
- Implementation example: `extensions/coc-nodeops/skills/pose-status/`
  (this session)
- Existing CLAUDE.md note: `coc-nodeops` was migrated to
  `@chainofclaw/claw-mem` npm package; v0.2 lands the new skills there.
