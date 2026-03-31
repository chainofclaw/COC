import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { verifyContract, type VerifyParams } from '@/lib/solc-verify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = Number(process.env.COC_VERIFY_MAX_BODY_BYTES ?? 64 * 1024)
const MAX_SOURCE_CODE_CHARS = Number(process.env.COC_VERIFY_MAX_SOURCE_CHARS ?? 100_000)
const MAX_OPTIMIZE_RUNS = Number(process.env.COC_VERIFY_MAX_OPTIMIZE_RUNS ?? 1_000_000)
const RATE_LIMIT_WINDOW_MS = Number(process.env.COC_VERIFY_RATE_WINDOW_MS ?? 60_000)
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.COC_VERIFY_RATE_MAX_REQUESTS ?? 5)
const REQUIRE_VERIFY_API_KEY =
  process.env.COC_VERIFY_REQUIRE_API_KEY === '1' || process.env.NODE_ENV === 'production'
const VERIFY_API_KEY = process.env.COC_VERIFY_API_KEY

type Bucket = { count: number; resetAt: number }
const rateBuckets = new Map<string, Bucket>()

function getClientIp(request: NextRequest): string {
  const xRealIp = request.headers.get('x-real-ip')
  if (xRealIp) return xRealIp
  const xForwardedFor = request.headers.get('x-forwarded-for')
  if (xForwardedFor) {
    const parts = xForwardedFor
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    return parts[parts.length - 1] ?? 'unknown'
  }
  return 'unknown'
}

function isValidApiKey(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

function evictExpiredBuckets(now: number): void {
  for (const [key, value] of rateBuckets.entries()) {
    if (now >= value.resetAt) rateBuckets.delete(key)
  }
}

function checkAndConsumeRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now()
  evictExpiredBuckets(now)
  const current = rateBuckets.get(key)
  if (!current || now >= current.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true, retryAfterSeconds: 0 }
  }
  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    }
  }
  current.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (REQUIRE_VERIFY_API_KEY) {
      if (!VERIFY_API_KEY) {
        return NextResponse.json(
          { verified: false, matchPct: 0, error: 'Verification API is not configured' },
          { status: 503 },
        )
      }
      const requestApiKey = request.headers.get('x-verify-api-key')
      if (!requestApiKey || !isValidApiKey(requestApiKey, VERIFY_API_KEY)) {
        return NextResponse.json(
          { verified: false, matchPct: 0, error: 'Unauthorized verification request' },
          { status: 401 },
        )
      }
    }

    const clientIp = getClientIp(request)
    const rateKey = `${clientIp}:${request.headers.get('x-verify-api-key') ?? 'anon'}`
    const limit = checkAndConsumeRateLimit(rateKey)
    if (!limit.allowed) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Rate limit exceeded, try again later' },
        {
          status: 429,
          headers: { 'Retry-After': String(limit.retryAfterSeconds) },
        },
      )
    }

    const contentLengthHeader = request.headers.get('content-length')
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Request body too large' },
        { status: 413 },
      )
    }

    const rawBody = await request.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Request body too large' },
        { status: 413 },
      )
    }

    let body: Partial<VerifyParams>
    try {
      body = JSON.parse(rawBody) as Partial<VerifyParams>
    } catch {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Invalid JSON payload' },
        { status: 400 },
      )
    }

    if (!body.address || !body.sourceCode || !body.compilerVersion) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Missing required fields: address, sourceCode, compilerVersion' },
        { status: 400 },
      )
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Invalid address format' },
        { status: 400 },
      )
    }

    if (body.sourceCode.length > MAX_SOURCE_CODE_CHARS) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'sourceCode exceeds allowed size' },
        { status: 413 },
      )
    }

    if (!/^(0\.\d+\.\d+|v\d+\.\d+\.\d+\+commit\.[0-9a-fA-F]+)$/.test(body.compilerVersion)) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Invalid compilerVersion format' },
        { status: 400 },
      )
    }

    if (
      body.optimizeRuns !== undefined &&
      (!Number.isInteger(body.optimizeRuns) || body.optimizeRuns < 0 || body.optimizeRuns > MAX_OPTIMIZE_RUNS)
    ) {
      return NextResponse.json(
        { verified: false, matchPct: 0, error: 'Invalid optimizeRuns value' },
        { status: 400 },
      )
    }

    const params: VerifyParams = {
      address: body.address,
      sourceCode: body.sourceCode,
      compilerVersion: body.compilerVersion,
      optimize: body.optimize ?? true,
      optimizeRuns: body.optimizeRuns ?? 200,
      contractName: body.contractName,
    }

    const result = await verifyContract(params)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { verified: false, matchPct: 0, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
