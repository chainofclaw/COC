# OpenClaw COC Skills v0.2

Operator-facing CLI skills shipping with `coc-nodeops` v0.2.

| Skill | Purpose | Status |
|---|---|---|
| [`pose-status`](./pose-status/) | PoSe epoch + node metrics roll-up | skeleton (Phase L.2) |
| [`chain-stats`](./chain-stats/) | TPS / gas / per-validator activity over a window | skeleton (Phase L.2b) |
| [`health`](./health/) | Aggregated health diagnostic (5 checks) | skeleton (Phase L.2c) |
| [`upgrade`](./upgrade/) | Dry-run image upgrade plan; apply path deferred to L.3 | skeleton (Phase L.2d) |

## Common contract

All skills follow the v0.2 contract frozen in
[`docs/openclaw-skills-v0.2-spec.md`](../../../docs/openclaw-skills-v0.2-spec.md):

- `--node <id>` selects from `~/.coc/nodeops.json` (default `default`)
- `--rpc <url>` bypasses config; `--auth-token <token>` for admin RPC
- `--json` flips to structured output (`schemaVersion: "0.2"`)
- `--timeout-ms <n>` RPC timeout (default 5000)
- `--help` exits 2 with synopsis

Exit codes:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | skill-internal error |
| `2` | bad flags |
| `3` | RPC timeout / network error |
| `4` | auth failure |

## Shared library

`lib/cli-base.ts` exports `parseBaseFlags`, `loadConfig`, `resolveNode`,
`rpcCall`, `emitError`, and `classifyError`. Used by chain-stats /
health / upgrade. **`pose-status` ships its own copies** (predates the
extraction); the L.3 follow-up will migrate it for symmetry.

## Running tests

```bash
node --experimental-strip-types --test extensions/coc-nodeops/skills/**/*.test.ts
```

All 4 skills total **15 unit tests** (pose-status × 4, chain-stats × 4,
health × 3, upgrade × 4) and pass under the same harness as the
node-layer suite.

## Development invocation

```bash
# Direct CLI run (no global install needed)
node --experimental-strip-types extensions/coc-nodeops/skills/pose-status/index.ts --rpc http://localhost:18780

# Same pattern for the other 3 skills:
node --experimental-strip-types extensions/coc-nodeops/skills/chain-stats/index.ts --window 5m --validators
node --experimental-strip-types extensions/coc-nodeops/skills/health/index.ts --strict
node --experimental-strip-types extensions/coc-nodeops/skills/upgrade/index.ts --target v1.0.0
```

Once `coc-nodeops` v0.2 ships to the OpenClaw plugin marketplace, these
become `openclaw coc <skill-name> ...`.

## Phase L.3 follow-ups (not in this release)

- pose-status migration to `lib/cli-base.ts` (DRY)
- chain-stats: real `missedRotations` via `expectedProposer` over window
- health: wire `bft.progress` to `coc_diagnostics`'s `lastFinalizedAtMs`
- health: implement `validator.rotation` check
- upgrade: implement `--apply` with validator-rotation safety bar +
  rollback path
- Marketplace publication (separate release flow under
  `$openclaw-pr-maintainer`)
