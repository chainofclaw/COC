'use client'

import { useTranslations } from 'next-intl'

interface GovernanceStatsProps {
  totalProposals: number
  activeProposals: number
  passedProposals: number
  treasuryBalance: string
  humanCount: number
  clawCount: number
}

export function GovernanceStats({
  totalProposals, activeProposals, passedProposals,
  treasuryBalance, humanCount, clawCount,
}: GovernanceStatsProps) {
  const t = useTranslations('governance')

  const stats = [
    { label: t('stats.totalProposals'), value: totalProposals, color: 'text-accent-cyan' },
    { label: t('stats.activeProposals'), value: activeProposals, color: 'text-amber-400' },
    { label: t('stats.passedProposals'), value: passedProposals, color: 'text-emerald-400' },
    { label: t('stats.treasury'), value: treasuryBalance, color: 'text-accent-blue' },
    { label: t('stats.humans'), value: humanCount, color: 'text-emerald-400' },
    { label: t('stats.claws'), value: clawCount, color: 'text-purple-400' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {stats.map((stat, i) => (
        <div key={i} className="rounded-xl bg-bg-elevated border border-text-muted/10 p-4 text-center">
          <p className={`text-2xl font-display font-bold ${stat.color}`}>{stat.value}</p>
          <p className="text-xs text-text-muted font-display mt-1">{stat.label}</p>
        </div>
      ))}
    </div>
  )
}
