'use client'

import { CreateProposalForm } from '@/components/governance/CreateProposalForm'
import { useTranslations } from 'next-intl'

export default function CreateProposalPage() {
  const t = useTranslations('governance')

  return (
    <section className="container mx-auto px-4 py-16 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold gradient-text">{t('createProposal')}</h1>
        <p className="text-text-secondary mt-2">{t('createProposalSubtitle')}</p>
      </div>
      <CreateProposalForm />
    </section>
  )
}
