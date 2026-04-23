// DEPRECATION SHIM
// ────────────────────────────────────────────────────────────────────────
// This extension's functionality has been merged into @openclaw/claw-mem
// (see https://github.com/NGPlateform/claw-mem). The implementation that
// used to live in this folder now lives at:
//   claw-mem/src/services/{node-manager,process-manager,rpc-client}.ts
//   claw-mem/src/cli/commands/node.ts
//   claw-mem/src/tools/node-tools.ts
//
// This stub remains so that older OpenClaw configurations still work; new
// installs should depend on @openclaw/claw-mem directly. Plan to remove
// this folder after 2-3 minor versions.
//
// Migrated by claw-mem PR 6.

export { activate } from "@openclaw/claw-mem"
