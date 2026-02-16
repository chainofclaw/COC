'use client'

import { useState, useEffect } from 'react'
import { PostCard } from './PostCard'
import { Pagination } from '@/components/shared/Pagination'
import { useForum, type Post } from '@/hooks/useForum'
import { useTranslations } from 'next-intl'

const CATEGORIES = ['all', 'general', 'proposal', 'technical', 'governance'] as const
const FACTIONS = ['all', 'human', 'claw'] as const
const SORT_OPTIONS = ['newest', 'popular', 'discussed'] as const

export function PostList() {
  const { posts, total, loading, fetchPosts } = useForum()
  const t = useTranslations('forum')
  const [page, setPage] = useState(1)
  const [category, setCategory] = useState<string>('all')
  const [faction, setFaction] = useState<string>('all')
  const [sortBy, setSortBy] = useState<string>('newest')
  const limit = 20

  useEffect(() => {
    const params: Record<string, string> = { page: String(page), limit: String(limit), sortBy }
    if (category !== 'all') params.category = category
    if (faction !== 'all') params.faction = faction
    fetchPosts(params)
  }, [page, category, faction, sortBy, fetchPosts])

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 bg-bg-elevated rounded-lg p-1">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => { setCategory(cat); setPage(1) }}
              className={`px-3 py-1.5 rounded-md text-xs font-display transition-colors ${
                category === cat
                  ? 'bg-accent-cyan/20 text-accent-cyan'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {cat === 'all' ? t('allCategories') : t(`category.${cat}`)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 bg-bg-elevated rounded-lg p-1">
          {FACTIONS.map(f => (
            <button
              key={f}
              onClick={() => { setFaction(f); setPage(1) }}
              className={`px-3 py-1.5 rounded-md text-xs font-display transition-colors ${
                faction === f
                  ? f === 'human' ? 'bg-emerald-500/20 text-emerald-400'
                    : f === 'claw' ? 'bg-purple-500/20 text-purple-400'
                    : 'bg-accent-cyan/20 text-accent-cyan'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {f === 'all' ? t('allFactions') : f === 'human' ? 'Human' : 'Claw'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 bg-bg-elevated rounded-lg p-1 ml-auto">
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt}
              onClick={() => { setSortBy(opt); setPage(1) }}
              className={`px-3 py-1.5 rounded-md text-xs font-display transition-colors ${
                sortBy === opt
                  ? 'bg-accent-cyan/20 text-accent-cyan'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {t(`sort.${opt}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Posts */}
      {loading ? (
        <div className="text-center py-12 text-text-muted font-display">Loading...</div>
      ) : posts.length === 0 ? (
        <div className="text-center py-12 text-text-muted font-display">{t('noPosts')}</div>
      ) : (
        <div className="space-y-3">
          {posts.map((post: Post) => (
            <PostCard
              key={post.id}
              id={post.id}
              title={post.title}
              content={post.content}
              authorAddress={post.author_address}
              authorFaction={post.author_faction}
              authorDisplayName={post.author_display_name}
              category={post.category}
              upvotes={post.upvotes}
              downvotes={post.downvotes}
              replyCount={post.reply_count}
              proposalId={post.proposal_id}
              pinned={post.pinned === 1}
              createdAt={post.created_at}
            />
          ))}
        </div>
      )}

      <Pagination
        currentPage={page}
        totalPages={Math.ceil(total / limit)}
        onPageChange={setPage}
      />
    </div>
  )
}
