// DEPRECATION SHIM
// ────────────────────────────────────────────────────────────────────────
// This extension's functionality has been merged into @openclaw/claw-mem
// (see https://github.com/NGPlateform/claw-mem). The implementation that
// used to live in this folder now lives at:
//   claw-mem/src/services/{soul-client,ipfs-client,did-client,lifecycle,
//                          backup-manager,recovery-manager}.ts
//   claw-mem/src/services/backup/  (scheduler, manifest builder, uploader, ...)
//   claw-mem/src/services/recovery/  (state restorer, orchestrator, ...)
//   claw-mem/src/services/carrier/   (carrier daemon — deferred port)
//   claw-mem/src/cli/commands/backup.ts
//   claw-mem/src/tools/soul-tools.ts
//
// Carrier / guardian / DID command groups remain to be ported to claw-mem;
// for those, keep this extension installed alongside @openclaw/claw-mem
// during the transition.
//
// Migrated by claw-mem PR 6.

export { activate } from "@openclaw/claw-mem"
