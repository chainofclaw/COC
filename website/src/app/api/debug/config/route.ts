import { NextResponse } from 'next/server'

export async function GET() {
  if (process.env.COC_DEBUG_CONFIG !== '1') {
    return new NextResponse(null, { status: 404 })
  }

  return NextResponse.json({
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'using dynamic from window.location',
    timestamp: new Date().toISOString(),
    message: 'If NEXT_PUBLIC_RPC_URL is not set, client uses window.location to build URL'
  })
}
