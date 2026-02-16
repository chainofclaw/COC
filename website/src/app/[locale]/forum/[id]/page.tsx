'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { FactionBadge } from '@/components/forum/FactionBadge'
import { VoteButton } from '@/components/forum/VoteButton'
import { ReplyThread } from '@/components/forum/ReplyThread'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { buildSignMessage } from '@/lib/auth'
import { useTranslations } from 'next-intl'
import type { Post, Reply } from '@/hooks/useForum'

export default function PostDetailPage() {
  const params = useParams()
  const postId = Number(params.id)
  const { address, isConnected, signMessage } = useWalletContext()
  const t = useTranslations('forum')
  const [post, setPost] = useState<Post | null>(null)
  const [replies, setReplies] = useState<Reply[]>([])
  const [replyContent, setReplyContent] = useState('')
  const [replyingTo, setReplyingTo] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const fetchPost = useCallback(async () => {
    const res = await fetch(`/api/forum/posts/${postId}`)
    if (res.ok) {
      const data = await res.json()
      setPost(data.post)
      setReplies(data.replies)
    }
  }, [postId])

  useEffect(() => {
    fetchPost()
  }, [fetchPost])

  const handleSubmitReply = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isConnected || !address || !replyContent.trim()) return

    setSubmitting(true)
    try {
      const message = buildSignMessage('reply', { post_id: postId, timestamp: Date.now() })
      const signature = await signMessage(message)

      const res = await fetch(`/api/forum/posts/${postId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: replyContent,
          address,
          signature,
          message,
          parent_reply_id: replyingTo,
        }),
      })

      if (res.ok) {
        setReplyContent('')
        setReplyingTo(null)
        await fetchPost()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleVotePost = async (type: 'up' | 'down') => {
    if (!isConnected || !address) return { upvotes: post?.upvotes || 0, downvotes: post?.downvotes || 0 }
    const message = buildSignMessage('vote', { target: 'post', id: postId, type })
    const signature = await signMessage(message)
    const res = await fetch(`/api/forum/posts/${postId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: 'post', vote_type: type, address, signature, message }),
    })
    return res.json()
  }

  const handleVoteReply = async (replyId: number, type: 'up' | 'down') => {
    if (!isConnected || !address) return { upvotes: 0, downvotes: 0 }
    const message = buildSignMessage('vote', { target: 'reply', id: replyId, type })
    const signature = await signMessage(message)
    const res = await fetch(`/api/forum/posts/${postId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: 'reply', target_id: replyId, vote_type: type, address, signature, message }),
    })
    return res.json()
  }

  if (!post) {
    return <div className="container mx-auto px-4 py-16 text-center text-text-muted font-display">Loading...</div>
  }

  return (
    <section className="container mx-auto px-4 py-16 max-w-4xl">
      {/* Post header */}
      <div className="mb-8 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded border border-accent-blue/30 text-accent-blue font-display">
            {post.category}
          </span>
          {post.proposal_id && (
            <span className="text-xs px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20 font-display">
              Proposal #{post.proposal_id}
            </span>
          )}
        </div>

        <h1 className="text-3xl font-display font-bold text-text-primary">{post.title}</h1>

        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted font-display">
            {post.author_display_name || `${post.author_address.slice(0, 6)}...${post.author_address.slice(-4)}`}
          </span>
          <FactionBadge faction={post.author_faction} />
          <span className="text-sm text-text-muted font-display">
            {new Date(post.created_at).toLocaleString()}
          </span>
          <VoteButton
            upvotes={post.upvotes}
            downvotes={post.downvotes}
            onVote={handleVotePost}
            disabled={!isConnected}
          />
        </div>
      </div>

      {/* Post content */}
      <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6 mb-8">
        <div className="prose prose-invert max-w-none text-text-secondary leading-relaxed whitespace-pre-wrap">
          {post.content}
        </div>
      </div>

      {/* Replies */}
      <div className="mb-8">
        <h2 className="text-xl font-display font-semibold text-text-primary mb-4">
          {t('replies')} ({replies.length})
        </h2>
        <ReplyThread
          replies={replies}
          onVote={handleVoteReply}
          onReply={setReplyingTo}
          isConnected={isConnected}
        />
      </div>

      {/* Reply form */}
      {isConnected && (
        <form onSubmit={handleSubmitReply} className="space-y-4">
          {replyingTo && (
            <div className="flex items-center gap-2 text-sm text-text-muted font-display">
              <span>{t('replyingTo')} #{replyingTo}</span>
              <button type="button" onClick={() => setReplyingTo(null)} className="text-red-400 hover:text-red-300">
                Cancel
              </button>
            </div>
          )}
          <textarea
            value={replyContent}
            onChange={e => setReplyContent(e.target.value)}
            rows={4}
            className="w-full px-4 py-3 rounded-lg bg-bg-secondary border border-text-muted/10 text-text-primary font-body focus:border-accent-cyan/50 focus:outline-none transition-colors resize-y"
            placeholder={t('replyPlaceholder')}
          />
          <button
            type="submit"
            disabled={submitting || !replyContent.trim()}
            className="px-6 py-2.5 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all disabled:opacity-50 text-sm"
          >
            {submitting ? t('submitting') : t('submitReply')}
          </button>
        </form>
      )}
    </section>
  )
}
