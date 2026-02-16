import { NextRequest, NextResponse } from 'next/server'
import { getPost, linkProposal } from '@/lib/forum-queries'
import { verifyAuth } from '@/lib/auth'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const postId = parseInt(id, 10)

    if (isNaN(postId)) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    const post = getPost(postId)
    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    if (post.proposal_id) {
      return NextResponse.json({ error: 'Post already linked to a proposal' }, { status: 409 })
    }

    const body = await request.json()
    const { chain_proposal_id, address, signature, message } = body

    if (!chain_proposal_id || !address || !signature || !message) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!verifyAuth({ address, signature, message })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    linkProposal(postId, chain_proposal_id, address.toLowerCase())

    return NextResponse.json({ post_id: postId, chain_proposal_id, linked: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
