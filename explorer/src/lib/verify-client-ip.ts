export function isVerifyTrustProxyEnabled(value = process.env.COC_VERIFY_TRUST_PROXY): boolean {
  return value === '1'
}

function lastForwardedFor(value: string | null): string | undefined {
  const parts = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return parts?.[parts.length - 1]
}

export function getVerifyRateLimitClientIp(
  headers: Pick<Headers, 'get'>,
  trustProxy = isVerifyTrustProxyEnabled(),
): string {
  if (!trustProxy) return 'direct'

  const realIp = headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  return lastForwardedFor(headers.get('x-forwarded-for')) ?? 'unknown'
}
