# coc-nodeops is deprecated

All functionality has moved to [`@openclaw/claw-mem`](https://github.com/NGPlateform/claw-mem).

The only remaining files here are `index.ts` (a one-line re-export shim) and
`package.json` (which declares a `peerDependency` on `@openclaw/claw-mem` so
OpenClaw configs that still reference `extensions/coc-nodeops` keep loading).

## What moved where

| Old path | New path in claw-mem |
|----------|----------------------|
| `src/runtime/node-manager.ts`   | `src/services/node-manager.ts` (SQLite-backed, new install API) |
| `src/runtime/process-manager.ts` | `src/services/process-manager.ts` (+ `spawnHardhat`) |
| `src/runtime/rpc-client.ts`     | `src/services/rpc-client.ts` |
| `src/cli/commands.ts`           | `src/cli/commands/node.ts` (`claw-mem node …`) |
| `src/cli/init-wizard.ts`        | `src/cli/init-wizard.ts` |
| `src/network-presets.ts` + `src/node-types.ts` | merged into `src/shared/presets.ts` |
| `src/config-schema.ts`          | merged into `src/config.ts` (the `node` sub-block) |
| `src/shared/paths.ts`           | `src/shared/paths.ts` (+ `checkCocRepo` helper) |
| `src/shared/config.ts`          | replaced by `~/.claw-mem/config.json` + `services/config-persistence.ts` |

All four test files (`network-presets.test.ts`, `node-types.test.ts`,
`runtime/node-manager.test.ts`, `runtime/rpc-client.test.ts`) were ported to
`test/presets.test.ts` / `test/node-manager.test.ts` / `test/rpc-client.test.ts`
under claw-mem.

## Migration

See [`claw-mem/docs/MIGRATION.md`](https://github.com/NGPlateform/claw-mem/blob/main/docs/MIGRATION.md)
for a step-by-step upgrade. TL;DR:

```bash
# old
openclaw coc init
openclaw coc start dev-1

# new
openclaw node install -t dev -n local
openclaw node start dev-1
```

The `coc` command prefix still resolves while `extensions/coc-nodeops` is
installed alongside `@openclaw/claw-mem`. It'll be removed entirely in a
later COC release.
