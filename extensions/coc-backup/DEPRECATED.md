# coc-backup is deprecated

All functionality has moved to [`@openclaw/claw-mem`](https://github.com/NGPlateform/claw-mem).

The only remaining files here are `index.ts` (a one-line re-export shim) and
`package.json` (which declares a `peerDependency` on `@openclaw/claw-mem` so
OpenClaw configs that still reference `extensions/coc-backup` keep loading).

## What moved where

All 33 `src/` files moved to claw-mem. Key mappings:

| Old path | New path in claw-mem |
|----------|----------------------|
| `src/backup/*.ts`       | `src/services/backup/*.ts` (scheduler, uploader, manifest-builder, binary-handler, change-detector, anchor, context-snapshot, semantic-snapshot) |
| `src/recovery/*.ts`     | `src/services/recovery/*.ts` |
| `src/carrier/*.ts`      | `src/services/carrier/*.ts` |
| `src/cli/commands.ts`   | split into `src/cli/commands/{backup,carrier,guardian,recovery,did}.ts` |
| `src/soul-client.ts`    | `src/services/soul-client.ts` (+ `listCarriers()` event walker) |
| `src/ipfs-client.ts`    | `src/services/ipfs-client.ts` |
| `src/did-client.ts`     | `src/services/did-client.ts` |
| `src/lifecycle.ts`      | `src/services/lifecycle.ts` |
| `src/local-state.ts`    | `src/services/local-state.ts` |
| `src/crypto.ts`         | `src/services/crypto.ts` |
| `src/plugin-api.ts`     | `src/services/plugin-api.ts` |
| `src/config-schema.ts`  | `src/services/backup-config-schema.ts` (+ adapter in `backup-config-adapter.ts`; user-facing shape in `src/config.ts`) |
| `src/types.ts`          | `src/services/backup-types.ts` (renamed to avoid clash with claw-mem's own `src/types.ts`) |
| `src/utils.ts`          | `src/services/backup-utils.ts` |

All 12 test files were ported to `test/backup-suite/` under claw-mem and
rewritten from `vitest` to Node's built-in `node:test` runner. The reverse-
coupling of semantic-snapshot back into claw-mem's SQLite was replaced with
a cleanly dependency-injected `SemanticSnapshotter` that takes
`ObservationStore` / `SummaryStore` as constructor args.

New facades added on top:

- `BackupManager` — lazy construction of SoulClient + IpfsClient + BackupScheduler
- `RecoveryManager` — thin wrapper over restore / autoRestore / doctor / memorySearch
- `CarrierManager` — lazy CarrierDaemon, auto-start at `activate()` if `config.backup.carrier.enabled`
- `BootstrapManager` — new `claw-mem bootstrap dev` / `bootstrap prod` flows

## Migration

See [`claw-mem/docs/MIGRATION.md`](https://github.com/NGPlateform/claw-mem/blob/main/docs/MIGRATION.md)
for a step-by-step upgrade. TL;DR:

```bash
# old
openclaw coc-backup init
openclaw coc-backup backup
openclaw coc-backup guardian add ...

# new
openclaw backup configure
openclaw backup init
openclaw backup create
openclaw guardian add ...
```

All legacy command names still work while `extensions/coc-backup` is
installed alongside `@openclaw/claw-mem`. This folder is expected to be
removed entirely in a later COC release.
