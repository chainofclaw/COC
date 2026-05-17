import { NextRequest, NextResponse } from 'next/server'
import { listPosts, createPost, type PostCategory } from '@/lib/forum-queries'
import { consumeSignedAction } from '@/lib/auth'
import { getRequiredString, isHexAddress, parsePositiveIntParam } from '@/lib/forum-validation'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const page = parsePositiveIntParam(searchParams.get('page'), 1, 10_000)
  const limit = parsePositiveIntParam(searchParams.get('limit'), 20, 100)
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

    const postTitle = getRequiredString(title)
    const postContent = getRequiredString(content)
    const signerAddress = getRequiredString(address)
    const authorSignature = getRequiredString(signature)
    const signedMessage = getRequiredString(message)

    if (!postTitle || !postContent || !signerAddress || !authorSignature || !signedMessage) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!isHexAddress(signerAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    }

    if (postTitle.length > 200) {
      return NextResponse.json({ error: 'Title too long' }, { status: 400 })
    }

    if (postContent.length > 50000) {
      return NextResponse.json({ error: 'Content too long' }, { status: 400 })
    }

    const validCategories = ['general', 'proposal', 'technical', 'governance']
    const postCategory = validCategories.includes(category) ? category : 'general'

    if (!consumeSignedAction({
      action: 'createPost',
      address: signerAddress,
      signature: authorSignature,
      message: signedMessage,
      expected: { title: postTitle, content: postContent, category: postCategory },
    })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const post = createPost({
      title: postTitle,
      content: postContent,
      author_address: signerAddress.toLowerCase(),
      author_signature: authorSignature,
      category: postCategory,
    })

    return NextResponse.json(post, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
