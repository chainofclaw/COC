import { ethers } from 'ethers'

export interface AuthPayload {
  address: string
  signature: string
  message: string
}

export type SignedActionData = Record<string, string | number | boolean | null>

interface ParsedSignMessage {
  action: string
  data: SignedActionData
}

interface VerifySignedActionOptions extends AuthPayload {
  action: string
  expected: SignedActionData
  maxAgeMs?: number
  nowMs?: number
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000
const FUTURE_SKEW_MS = 60 * 1000
const consumedMessages = new Map<string, number>()

/// Verify EIP-191 personal_sign signature and return the recovered address
export function verifySignature(message: string, signature: string): string {
  return ethers.verifyMessage(message, signature)
}

/// Verify that the signature was produced by the claimed address
export function verifyAuth(payload: AuthPayload): boolean {
  const recovered = verifySignature(payload.message, payload.signature)
  return recovered.toLowerCase() === payload.address.toLowerCase()
}

/// Build a deterministic signing message for forum actions
export function buildSignMessage(action: string, data: SignedActionData): string {
  const sorted = Object.keys(data).sort().reduce((acc, key) => {
    return { ...acc, [key]: data[key] }
  }, {} as Record<string, unknown>)
  return `COC Forum ${action}\n${JSON.stringify(sorted)}`
}

export function parseSignMessage(message: string): ParsedSignMessage | null {
  const firstLineEnd = message.indexOf('\n')
  if (firstLineEnd === -1) return null

  const header = message.slice(0, firstLineEnd)
  if (!header.startsWith('COC Forum ')) return null

  const action = header.slice('COC Forum '.length)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(action)) return null

  let data: unknown
  try {
    data = JSON.parse(message.slice(firstLineEnd + 1))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null

  for (const value of Object.values(data)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return null
    }
  }

  return { action, data: data as SignedActionData }
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

export function verifySignedAction(options: VerifySignedActionOptions): boolean {
  const parsed = parseSignMessage(options.message)
  if (!parsed || parsed.action !== options.action) return false
  if (options.message !== buildSignMessage(parsed.action, parsed.data)) return false

  const timestamp = parsed.data.timestamp
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) return false

  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  if (timestamp > nowMs + FUTURE_SKEW_MS) return false
  if (nowMs - timestamp > maxAgeMs) return false

  const allowedKeys = new Set([...Object.keys(options.expected), 'timestamp'])
  for (const key of Object.keys(parsed.data)) {
    if (!allowedKeys.has(key)) return false
  }
  for (const [key, expected] of Object.entries(options.expected)) {
    if (!valuesMatch(parsed.data[key], expected)) return false
  }

  try {
    return verifyAuth(options)
  } catch {
    return false
  }
}

export function consumeSignedAction(options: VerifySignedActionOptions): boolean {
  const nowMs = options.nowMs ?? Date.now()
  for (const [key, expiresAt] of consumedMessages.entries()) {
    if (expiresAt <= nowMs) consumedMessages.delete(key)
  }

  if (!verifySignedAction({ ...options, nowMs })) return false

  const replayKey = ethers.id(`${options.address.toLowerCase()}:${options.signature}:${options.message}`)
  if (consumedMessages.has(replayKey)) return false

  consumedMessages.set(replayKey, nowMs + (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS))
  return true
}

export function clearConsumedSignaturesForTests(): void {
  consumedMessages.clear()
}
