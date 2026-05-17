/**
 * Helpers for scripts that need a dev fallback private key.
 *
 * Usage:
 *   const privateKey = resolvePrivateKeyForRpc({
 *     envValue: process.env.PROBE_PK,
 *     envName: 'PROBE_PK',
 *     fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[5],
 *     rpcUrl: cfg.rpc,
 *     label: 'synthetic active probe',
 *   })
 */

export const HARDHAT_DEV_PRIVATE_KEYS = Object.freeze([
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
])

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'host.docker.internal',
  'anvil',
  'hardhat',
])

export function isLocalOrDevnetRpc(rpcUrl) {
  try {
    const parsed = new URL(rpcUrl)
    const host = parsed.hostname.toLowerCase()
    return LOCAL_HOSTS.has(host) || /^node-\d+$/.test(host) || /^coc-node-\d+$/.test(host)
  } catch {
    return false
  }
}

export function isPrivateKeyHex(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value ?? '').trim())
}

export function resolvePrivateKeyForRpc({ envValue, envName, fallbackDevKey, rpcUrl, label }) {
  const trimmed = envValue?.trim()
  if (trimmed) {
    if (!isPrivateKeyHex(trimmed)) {
      throw new Error(`${envName} must be a 0x-prefixed 64-character hex private key`)
    }
    return trimmed
  }

  if (isLocalOrDevnetRpc(rpcUrl)) {
    if (!isPrivateKeyHex(fallbackDevKey)) {
      throw new Error(`invalid ${label} fallback dev key`)
    }
    return fallbackDevKey
  }

  throw new Error(`${envName} is required for ${label} when RPC is not localhost/devnet (${rpcUrl})`)
}
