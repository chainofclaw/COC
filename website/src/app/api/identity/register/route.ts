import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { upsertIdentity, getIdentity } from '@/lib/forum-queries'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { address, faction, signature, message } = body

    if (!address || !faction || !signature || !message) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (faction !== 'human' && faction !== 'claw') {
      return NextResponse.json({ error: 'Invalid faction' }, { status: 400 })
    }

    // Verify signature
    if (!verifyAuth({ address, signature, message })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // Check if already registered
    const existing = getIdentity(address)
    if (existing && (existing as any).faction !== 'none') {
      return NextResponse.json({ error: 'Already registered' }, { status: 409 })
    }

    upsertIdentity({ address, faction })

    return NextResponse.json({ address, faction, registered: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
