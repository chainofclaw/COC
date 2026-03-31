import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { keccak256, toUtf8Bytes } from "ethers"

export const ZERO_BYTES32 = `0x${"0".repeat(64)}`

export function resolveHomePath(path: string): string {
  return path.replace(/^~/, process.env.HOME ?? "")
}

export function deriveDefaultAgentId(ownerAddress: string): string {
  return keccak256(toUtf8Bytes(ownerAddress))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
