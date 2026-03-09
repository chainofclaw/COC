import { NextRequest, NextResponse } from 'next/server'
import { verifyContract, type VerifyParams } from '@/lib/solc-verify'

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json() as Partial<VerifyParams>

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
