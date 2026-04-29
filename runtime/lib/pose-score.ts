/**
 * PoSe scoring helpers extracted for testability (Phase C2.3).
 *
 * `verifiedStorageBytesFor` is the accessor the agent uses to credit
 * the right byte count to `verifiedStorageBytes` on each successful
 * Storage challenge. Prefers `chunkSize` (Phase C2.2's real per-chunk
 * bytes) over `fileSize` (legacy whole-file weight which double-
 * counted any file that received multiple challenges in the same
 * epoch). Without this fix the `storageGb` reward bucket either sat
 * at zero (no field populated) or at an inflated value proportional
 * to challenge frequency rather than actual storage.
 *
 * When neither field is set — e.g. a pre-C2.2 challenge that didn't
 * carry a target, or a corrupted picker response — returns undefined
 * so the scoring caller treats it as zero-weight rather than crediting
 * a partial figure.
 */
export interface StorageTargetBytesFields {
  chunkSize?: number
  fileSize?: number
}

export function verifiedStorageBytesFor(target: StorageTargetBytesFields | null | undefined): number | undefined {
  if (!target) return undefined
  if (typeof target.chunkSize === "number" && target.chunkSize > 0) return target.chunkSize
  if (typeof target.fileSize === "number" && target.fileSize > 0) return target.fileSize
  return undefined
}
