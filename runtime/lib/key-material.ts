import { readFileSync } from "node:fs"

export interface ResolvePrivateKeyOptions {
  envValue?: string
  envFilePath?: string
  configValue?: string
  configFilePath?: string
  label: string
}

export function resolvePrivateKey(options: ResolvePrivateKeyOptions): string {
  const candidate = options.envValue
    ?? readKeyFile(options.envFilePath)
    ?? options.configValue
    ?? readKeyFile(options.configFilePath)

  if (!candidate) {
    throw new Error(`missing ${options.label} private key`)
  }
  const normalized = candidate.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`invalid ${options.label} private key format: expected 32-byte hex string with 0x prefix`)
  }
  return normalized
}

function readKeyFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  return readFileSync(filePath, "utf8").trim()
}
