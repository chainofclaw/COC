# `openclaw coc pose-status` skill

Phase L.2 implementation skeleton. Contract: see
`docs/openclaw-skills-v0.2-spec.md` § 1.

## What it does

Reports a single rolled-up view of:

- node identity + version (via `coc_nodeInfo`)
- current PoSe epoch + age (via `coc_poseStatus`)
- challenge / receipt / reward / slash counters
- a lightweight health verdict (clock skew, counter consistency)

Replaces the manual chain of `curl /pose/status` + `coc_chainStats` +
log scraping that operators were doing during the Prowl beta.

## Usage

```bash
# Default node, human output
node --experimental-strip-types index.ts

# JSON output (machine-readable, schema 0.2)
node --experimental-strip-types index.ts --json

# Past epoch
node --experimental-strip-types index.ts --epoch 137

# Tail a node continuously
node --experimental-strip-types index.ts --watch

# Direct RPC bypass (no ~/.coc/nodeops.json)
node --experimental-strip-types index.ts --rpc http://node-1.example:18780 \
  --auth-token <token>
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | skill-internal error |
| `2` | bad flags |
| `3` | RPC timeout / network error |
| `4` | auth failure |

## Tests

```bash
node --experimental-strip-types --test index.test.ts
```

Coverage: happy path, RPC timeout, flag conflict. Spec conformance is
asserted by parsing the `--json` output and validating field names +
`schemaVersion`.

## Future work (deferred to Phase L.3)

- Pretty-print TUI in `--watch` mode (currently just prints + clears
  screen)
- Aggregation across multiple nodes (`--node all`) with side-by-side
  comparison
- Publishing this skill to the OpenClaw plugin marketplace alongside
  `chain-stats`, `health`, `upgrade`
