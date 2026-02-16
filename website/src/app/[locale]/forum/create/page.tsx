'use client'

import { CreatePostForm } from '@/components/forum/CreatePostForm'
import { useTranslations } from 'next-intl'

export default function CreatePostPage() {
  const t = useTranslations('forum')

  return (
    <section className="container mx-auto px-4 py-16 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold gradient-text">{t('createPost')}</h1>
        <p className="text-text-secondary mt-2">{t('createPostSubtitle')}</p>
      </div>
      <CreatePostForm />
    </section>
  )
}
