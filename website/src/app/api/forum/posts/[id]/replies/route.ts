import { NextRequest, NextResponse } from 'next/server'
import { createReply, getPost } from '@/lib/forum-queries'
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

    const body = await request.json()
    const { content, address, signature, message, parent_reply_id } = body

    if (!content || !address || !signature || !message) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (content.length > 10000) {
      return NextResponse.json({ error: 'Content too long' }, { status: 400 })
    }

    if (!verifyAuth({ address, signature, message })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const reply = createReply({
      post_id: postId,
      content: content.trim(),
      author_address: address.toLowerCase(),
      author_signature: signature,
      parent_reply_id: parent_reply_id || undefined,
    })

    return NextResponse.json(reply, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
