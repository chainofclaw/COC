import { NextRequest, NextResponse } from 'next/server'
import { castVote } from '@/lib/forum-queries'
import { verifyAuth } from '@/lib/auth'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const postId = parseInt(id, 10)

    const body = await request.json()
    const { target_type, target_id, vote_type, address, signature, message } = body

    if (!address || !signature || !message || !vote_type) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!verifyAuth({ address, signature, message })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const validTypes = ['up', 'down']
    if (!validTypes.includes(vote_type)) {
      return NextResponse.json({ error: 'Invalid vote type' }, { status: 400 })
    }

    const targetType = target_type === 'reply' ? 'reply' : 'post'
    const targetId = target_type === 'reply' ? (target_id || postId) : postId

    const result = castVote({
      target_type: targetType,
      target_id: targetId,
      voter_address: address.toLowerCase(),
      vote_type,
    })

    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
