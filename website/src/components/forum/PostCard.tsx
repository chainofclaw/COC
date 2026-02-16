'use client'

import { FactionBadge } from './FactionBadge'
import { Link } from '@/i18n/routing'

interface PostCardProps {
  id: number
  title: string
  content: string
  authorAddress: string
  authorFaction?: string
  authorDisplayName?: string
  category: string
  upvotes: number
  downvotes: number
  replyCount: number
  proposalId?: number | null
  pinned?: boolean
  createdAt: number
}

const CATEGORY_COLORS: Record<string, string> = {
  general: 'text-text-muted border-text-muted/30',
  proposal: 'text-accent-cyan border-accent-cyan/30',
  technical: 'text-accent-blue border-accent-blue/30',
  governance: 'text-accent-purple border-accent-purple/30',
}

export function PostCard({
  id, title, content, authorAddress, authorFaction, authorDisplayName,
  category, upvotes, downvotes, replyCount, proposalId, pinned, createdAt,
}: PostCardProps) {
  const timeAgo = getTimeAgo(createdAt)
  const excerpt = content.length > 200 ? content.slice(0, 200) + '...' : content

  return (
    <Link href={`/forum/${id}`}>
      <div className={`rounded-xl bg-bg-elevated border transition-all hover:border-accent-cyan/30 hover:shadow-glow-sm p-5 space-y-3 ${
        pinned ? 'border-accent-cyan/20' : 'border-text-muted/10'
      }`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {pinned && (
                <span className="text-xs text-accent-cyan font-display">PINNED</span>
              )}
              <span className={`text-xs px-2 py-0.5 rounded border font-display ${CATEGORY_COLORS[category] || CATEGORY_COLORS.general}`}>
                {category}
              </span>
              {proposalId && (
                <span className="text-xs px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20 font-display">
                  Proposal #{proposalId}
                </span>
              )}
            </div>
            <h3 className="text-text-primary font-display font-semibold text-lg truncate">{title}</h3>
          </div>
          <div className="flex items-center gap-2 text-text-muted text-xs font-display shrink-0">
            <span>{replyCount} replies</span>
            <span className="text-emerald-400">+{upvotes}</span>
            {downvotes > 0 && <span className="text-red-400">-{downvotes}</span>}
          </div>
        </div>

        <p className="text-text-secondary text-sm leading-relaxed">{excerpt}</p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted font-display">
              {authorDisplayName || `${authorAddress.slice(0, 6)}...${authorAddress.slice(-4)}`}
            </span>
            <FactionBadge faction={authorFaction} />
          </div>
          <span className="text-xs text-text-muted font-display">{timeAgo}</span>
        </div>
      </div>
    </Link>
  )
}

function getTimeAgo(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}
