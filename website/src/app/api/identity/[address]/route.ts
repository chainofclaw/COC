import { NextRequest, NextResponse } from 'next/server'
import { getIdentity } from '@/lib/forum-queries'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  const identity = getIdentity(address)

  if (!identity) {
    return NextResponse.json({ address, faction: 'none', verified: 0 })
  }

  return NextResponse.json(identity)
}
