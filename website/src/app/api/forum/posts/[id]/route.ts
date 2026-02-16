import { NextRequest, NextResponse } from 'next/server'
import { getPost, getReplies } from '@/lib/forum-queries'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const postId = parseInt(id, 10)

  if (isNaN(postId)) {
    return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
  }

  const post = getPost(postId)
  if (!post) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 })
  }

  const replies = getReplies(postId)

  return NextResponse.json({ post, replies })
}
