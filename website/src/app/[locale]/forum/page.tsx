'use client'

import { PostList } from '@/components/forum/PostList'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import { useWalletContext } from '@/components/shared/WalletProvider'

export default function ForumPage() {
  const t = useTranslations('forum')
  const { isConnected } = useWalletContext()

  return (
    <section className="container mx-auto px-4 py-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-display font-bold gradient-text">{t('title')}</h1>
          <p className="text-text-secondary mt-2">{t('subtitle')}</p>
        </div>
        {isConnected && (
          <Link
            href="/forum/create"
            className="px-6 py-3 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all"
          >
            {t('newPost')}
          </Link>
        )}
      </div>

      <PostList />
    </section>
  )
}
