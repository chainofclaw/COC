import { createHash } from 'node:crypto'

export function hashVerifyRateLimitSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function getVerifyRateLimitKey(
  clientIp: string,
  apiKey: string | null,
  scope: 'auth' | 'verify' = 'verify',
): string {
  const keyPart = apiKey ? `key:${hashVerifyRateLimitSecret(apiKey)}` : 'anon'
  return `${scope}:${clientIp}:${keyPart}`
}
