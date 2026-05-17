import { NextRequest, NextResponse } from 'next/server'
import { createReply, getPost, replyBelongsToPost } from '@/lib/forum-queries'
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

    const post = getPost(postId)
    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const body = await request.json()
    const { content, address, signature, message, parent_reply_id } = body

    const replyContent = getRequiredString(content)
    const signerAddress = getRequiredString(address)
    const authorSignature = getRequiredString(signature)
    const signedMessage = getRequiredString(message)

    if (!replyContent || !signerAddress || !authorSignature || !signedMessage) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!isHexAddress(signerAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    }

    if (replyContent.length > 10000) {
      return NextResponse.json({ error: 'Content too long' }, { status: 400 })
    }

    const hasParentReply = parent_reply_id !== undefined && parent_reply_id !== null
    const parentReplyId = hasParentReply ? parsePositiveInt(parent_reply_id) : null

    if (
      hasParentReply &&
      (parentReplyId === null || !replyBelongsToPost(parentReplyId, postId))
    ) {
      return NextResponse.json({ error: 'Parent reply not found' }, { status: 404 })
    }

    if (!consumeSignedAction({
      action: 'reply',
      address: signerAddress,
      signature: authorSignature,
      message: signedMessage,
      expected: { post_id: postId, content: replyContent, parent_reply_id: parentReplyId },
    })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const reply = createReply({
      post_id: postId,
      content: replyContent,
      author_address: signerAddress.toLowerCase(),
      author_signature: authorSignature,
      parent_reply_id: parentReplyId ?? undefined,
    })

    return NextResponse.json(reply, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
