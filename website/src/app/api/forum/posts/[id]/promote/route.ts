import { NextRequest, NextResponse } from 'next/server'
import { getPost, isPostAuthor, linkProposal } from '@/lib/forum-queries'
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

    if (post.proposal_id) {
      return NextResponse.json({ error: 'Post already linked to a proposal' }, { status: 409 })
    }

    const body = await request.json()
    const { chain_proposal_id, address, signature, message } = body

    const signerAddress = getRequiredString(address)
    const authorSignature = getRequiredString(signature)
    const signedMessage = getRequiredString(message)

    if (!chain_proposal_id || !signerAddress || !authorSignature || !signedMessage) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!isHexAddress(signerAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    }

    const chainProposalId = parsePositiveInt(chain_proposal_id)
    if (chainProposalId === null) {
      return NextResponse.json({ error: 'Invalid proposal ID' }, { status: 400 })
    }

    if (!isPostAuthor(postId, signerAddress)) {
      return NextResponse.json({ error: 'Only the post author can link a proposal' }, { status: 403 })
    }

    if (!consumeSignedAction({
      action: 'promotePost',
      address: signerAddress,
      signature: authorSignature,
      message: signedMessage,
      expected: { post_id: postId, chain_proposal_id: chainProposalId },
    })) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    linkProposal(postId, chainProposalId, signerAddress.toLowerCase())

    return NextResponse.json({ post_id: postId, chain_proposal_id: chainProposalId, linked: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
