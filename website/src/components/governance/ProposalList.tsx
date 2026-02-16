'use client'

import { useState, useEffect } from 'react'
import { ProposalCard } from './ProposalCard'
import { useTranslations } from 'next-intl'

interface ProposalSummary {
  id: number
  title: string
  proposalType: number
  proposer: string
  state: number
  forVotesHuman: number
  againstVotesHuman: number
  forVotesClaw: number
  againstVotesClaw: number
  abstainVotes: number
  votingDeadline: number
  createdAt: number
}

const STATE_FILTERS = ['all', 'active', 'passed', 'rejected', 'executed'] as const

export function ProposalList() {
  const t = useTranslations('governance')
  const [proposals, setProposals] = useState<ProposalSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [stateFilter, setStateFilter] = useState<string>('all')

  useEffect(() => {
    fetchProposals()
  }, [stateFilter])

  const fetchProposals = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (stateFilter !== 'all') params.set('state', stateFilter)
      const res = await fetch(`/api/governance/proposals?${params}`)
      if (res.ok) {
        const data = await res.json()
        setProposals(data.proposals)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1 bg-bg-elevated rounded-lg p-1">
        {STATE_FILTERS.map(filter => (
          <button
            key={filter}
            onClick={() => setStateFilter(filter)}
            className={`px-3 py-1.5 rounded-md text-xs font-display transition-colors ${
              stateFilter === filter
                ? 'bg-accent-cyan/20 text-accent-cyan'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t(`filter.${filter}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-text-muted font-display">Loading...</div>
      ) : proposals.length === 0 ? (
        <div className="text-center py-12 text-text-muted font-display">{t('noProposals')}</div>
      ) : (
        <div className="space-y-3">
          {proposals.map(p => (
            <ProposalCard key={p.id} {...p} />
          ))}
        </div>
      )}
    </div>
  )
}
