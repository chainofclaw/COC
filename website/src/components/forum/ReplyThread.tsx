'use client'

import { FactionBadge } from './FactionBadge'
import { VoteButton } from './VoteButton'
import type { Reply } from '@/hooks/useForum'

interface ReplyThreadProps {
  replies: Reply[]
  onVote: (replyId: number, type: 'up' | 'down') => Promise<{ upvotes: number; downvotes: number }>
  onReply?: (parentReplyId: number) => void
  isConnected: boolean
}

export function ReplyThread({ replies, onVote, onReply, isConnected }: ReplyThreadProps) {
  // Build a tree from flat replies
  const topLevel = replies.filter(r => !r.parent_reply_id)
  const childMap = new Map<number, Reply[]>()
  for (const r of replies) {
    if (r.parent_reply_id) {
      const existing = childMap.get(r.parent_reply_id) || []
      childMap.set(r.parent_reply_id, [...existing, r])
    }
  }

  return (
    <div className="space-y-4">
      {topLevel.map(reply => (
        <ReplyNode
          key={reply.id}
          reply={reply}
          childMap={childMap}
          depth={0}
          onVote={onVote}
          onReply={onReply}
          isConnected={isConnected}
        />
      ))}
    </div>
  )
}

function ReplyNode({
  reply, childMap, depth, onVote, onReply, isConnected,
}: {
  reply: Reply
  childMap: Map<number, Reply[]>
  depth: number
  onVote: (replyId: number, type: 'up' | 'down') => Promise<{ upvotes: number; downvotes: number }>
  onReply?: (parentReplyId: number) => void
  isConnected: boolean
}) {
  const children = childMap.get(reply.id) || []
  const maxDepth = 4

  return (
    <div className={`${depth > 0 ? 'ml-6 pl-4 border-l border-text-muted/10' : ''}`}>
      <div className="rounded-lg bg-bg-secondary/50 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted font-display">
            {reply.author_display_name || `${reply.author_address.slice(0, 6)}...${reply.author_address.slice(-4)}`}
          </span>
          <FactionBadge faction={reply.author_faction} />
          <span className="text-xs text-text-muted font-display">
            {new Date(reply.created_at).toLocaleString()}
          </span>
        </div>

        <p className="text-text-secondary text-sm leading-relaxed whitespace-pre-wrap">{reply.content}</p>

        <div className="flex items-center gap-3">
          <VoteButton
            upvotes={reply.upvotes}
            downvotes={reply.downvotes}
            onVote={(type) => onVote(reply.id, type)}
            disabled={!isConnected}
          />
          {onReply && depth < maxDepth && isConnected && (
            <button
              onClick={() => onReply(reply.id)}
              className="text-xs text-text-muted hover:text-accent-cyan transition-colors font-display"
            >
              Reply
            </button>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <div className="mt-2 space-y-2">
          {children.map(child => (
            <ReplyNode
              key={child.id}
              reply={child}
              childMap={childMap}
              depth={depth + 1}
              onVote={onVote}
              onReply={onReply}
              isConnected={isConnected}
            />
          ))}
        </div>
      )}
    </div>
  )
}
