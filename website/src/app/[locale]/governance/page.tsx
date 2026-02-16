'use client'

import { ProposalList } from '@/components/governance/ProposalList'
import { GovernanceStats } from '@/components/governance/GovernanceStats'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { useState, useEffect } from 'react'

export default function GovernancePage() {
  const t = useTranslations('governance')
  const { isConnected } = useWalletContext()
  const [stats, setStats] = useState({
    totalProposals: 0,
    activeProposals: 0,
    passedProposals: 0,
    treasuryBalance: '0 ETH',
    humanCount: 0,
    clawCount: 0,
  })

  useEffect(() => {
    fetch('/api/governance/stats')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setStats(data) })
      .catch(() => {})
  }, [])

  return (
    <section className="container mx-auto px-4 py-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-display font-bold gradient-text">{t('title')}</h1>
          <p className="text-text-secondary mt-2">{t('subtitle')}</p>
        </div>
        {isConnected && (
          <Link
            href="/governance/create"
            className="px-6 py-3 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all"
          >
            {t('newProposal')}
          </Link>
        )}
      </div>

      <div className="space-y-8">
        <GovernanceStats {...stats} />
        <ProposalList />
      </div>
    </section>
  )
}
