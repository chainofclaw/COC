'use client'

import { useState } from 'react'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { useTranslations } from 'next-intl'
import { buildSignMessage } from '@/lib/auth'
import { useRouter } from '@/i18n/routing'

const CATEGORIES = ['general', 'proposal', 'technical', 'governance'] as const

export function CreatePostForm() {
  const { address, isConnected, signMessage } = useWalletContext()
  const t = useTranslations('forum')
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<string>('general')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isConnected || !address) return
    if (!title.trim() || !content.trim()) {
      setError(t('fillRequired'))
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const message = buildSignMessage('createPost', { title, category, timestamp: Date.now() })
      const signature = await signMessage(message)

      const res = await fetch('/api/forum/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, category, address, signature, message }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create post')
      }

      const post = await res.json()
      router.push(`/forum/${post.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!isConnected) {
    return (
      <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-8 text-center">
        <p className="text-text-secondary">{t('connectToPost')}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-display text-text-secondary mb-2">{t('postTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
          className="w-full px-4 py-3 rounded-lg bg-bg-secondary border border-text-muted/10 text-text-primary font-body focus:border-accent-cyan/50 focus:outline-none transition-colors"
          placeholder={t('titlePlaceholder')}
        />
      </div>

      <div>
        <label className="block text-sm font-display text-text-secondary mb-2">{t('postCategory')}</label>
        <div className="flex gap-2">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`px-4 py-2 rounded-lg text-sm font-display transition-colors ${
                category === cat
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'bg-bg-secondary text-text-muted border border-text-muted/10 hover:text-text-secondary'
              }`}
            >
              {t(`category.${cat}`)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-display text-text-secondary mb-2">{t('postContent')}</label>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={10}
          className="w-full px-4 py-3 rounded-lg bg-bg-secondary border border-text-muted/10 text-text-primary font-body focus:border-accent-cyan/50 focus:outline-none transition-colors resize-y"
          placeholder={t('contentPlaceholder')}
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="px-6 py-3 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all disabled:opacity-50"
      >
        {submitting ? t('submitting') : t('submitPost')}
      </button>
    </form>
  )
}
