import { NextRequest, NextResponse } from 'next/server'
import { consumeSignedAction } from '@/lib/auth'
import { upsertIdentity, getIdentity } from '@/lib/forum-queries'
import { getRequiredString, isHexAddress } from '@/lib/forum-validation'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { address, faction, signature, message } = body

    const signerAddress = getRequiredString(address)
    const authorSignature = getRequiredString(signature)
    const signedMessage = getRequiredString(message)
    const requestedFaction = getRequiredString(faction)

    if (!signerAddress || !requestedFaction || !authorSignature || !signedMessage) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!isHexAddress(signerAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    }

    if (requestedFaction !== 'human' && requestedFaction !== 'claw') {
      return NextResponse.json({ error: 'Invalid faction' }, { status: 400 })
    }

    const normalizedAddress = signerAddress.toLowerCase()

    if (!consumeSignedAction({
      action: 'identityRegister',
      address: signerAddress,
      signature: authorSignature,
      message: signedMessage,
      expected: { address: normalizedAddress, faction: requestedFaction },
    })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // Check if already registered
    const existing = getIdentity(normalizedAddress)
    if (existing && (existing as any).faction !== 'none') {
      return NextResponse.json({ error: 'Already registered' }, { status: 409 })
    }

    upsertIdentity({ address: normalizedAddress, faction: requestedFaction })

    return NextResponse.json({ address: normalizedAddress, faction: requestedFaction, registered: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
