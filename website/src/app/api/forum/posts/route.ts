import { NextRequest, NextResponse } from 'next/server'
import { listPosts, createPost, type PostCategory } from '@/lib/forum-queries'
import { verifyAuth } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)
  const category = searchParams.get('category') as PostCategory | undefined
  const faction = searchParams.get('faction') as 'all' | 'human' | 'claw' | undefined
  const sortBy = searchParams.get('sortBy') as 'newest' | 'popular' | 'discussed' | undefined
  const search = searchParams.get('search') || undefined

  const result = listPosts({ page, limit, category: category || undefined, faction: faction || undefined, sortBy, search })
  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { title, content, category, address, signature, message } = body

    if (!title || !content || !address || !signature || !message) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (title.length > 200) {
      return NextResponse.json({ error: 'Title too long' }, { status: 400 })
    }

    if (content.length > 50000) {
      return NextResponse.json({ error: 'Content too long' }, { status: 400 })
    }

    // Verify EIP-191 signature
    if (!verifyAuth({ address, signature, message })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const validCategories = ['general', 'proposal', 'technical', 'governance']
    const postCategory = validCategories.includes(category) ? category : 'general'

    const post = createPost({
      title: title.trim(),
      content: content.trim(),
      author_address: address.toLowerCase(),
      author_signature: signature,
      category: postCategory,
    })

    return NextResponse.json(post, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
