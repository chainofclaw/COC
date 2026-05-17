import { NextRequest, NextResponse } from 'next/server'
import { castVote, voteTargetExists } from '@/lib/forum-queries'
import { consumeSignedAction } from '@/lib/auth'
import { getRequiredString, isHexAddress, parsePositiveInt } from '@/lib/forum-validation'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const postId = parseInt(id, 10)
    if (!Number.isInteger(postId) || postId <= 0) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    const body = await request.json()
    const { target_type, target_id, vote_type, address, signature, message } = body

    const signerAddress = getRequiredString(address)
    const authorSignature = getRequiredString(signature)
    const signedMessage = getRequiredString(message)

    if (!signerAddress || !authorSignature || !signedMessage || !vote_type) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!isHexAddress(signerAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    }

    const validTypes = ['up', 'down']
    if (!validTypes.includes(vote_type)) {
      return NextResponse.json({ error: 'Invalid vote type' }, { status: 400 })
    }

    if (target_type !== undefined && target_type !== 'post' && target_type !== 'reply') {
      return NextResponse.json({ error: 'Invalid target type' }, { status: 400 })
    }

    const targetType = target_type === 'reply' ? 'reply' : 'post'
    const targetId = targetType === 'reply' ? parsePositiveInt(target_id) : postId

    if (targetId === null) {
      return NextResponse.json({ error: 'Invalid target ID' }, { status: 400 })
    }
    if (!voteTargetExists(targetType, targetId, postId)) {
      return NextResponse.json({ error: 'Vote target not found' }, { status: 404 })
    }

    if (!consumeSignedAction({
      action: 'vote',
      address: signerAddress,
      signature: authorSignature,
      message: signedMessage,
      expected: { target: targetType, id: targetId, type: vote_type },
    })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const result = castVote({
      target_type: targetType,
      target_id: targetId,
      voter_address: signerAddress.toLowerCase(),
      vote_type,
    })

    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
