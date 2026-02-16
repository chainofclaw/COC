'use client'

import { useState } from 'react'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { useGovernance } from '@/hooks/useGovernance'
import { useTranslations } from 'next-intl'

interface VotePanelProps {
  proposalId: number
  forVotesHuman: number
  againstVotesHuman: number
  forVotesClaw: number
  againstVotesClaw: number
  abstainVotes: number
  hasVoted: boolean
  isActive: boolean
  onVoteComplete?: () => void
}

export function VotePanel({
  proposalId, forVotesHuman, againstVotesHuman, forVotesClaw, againstVotesClaw,
  abstainVotes, hasVoted, isActive, onVoteComplete,
}: VotePanelProps) {
  const { signer, isConnected } = useWalletContext()
  const { vote, loading } = useGovernance(signer)
  const t = useTranslations('governance')
  const [voted, setVoted] = useState(hasVoted)

  const totalFor = forVotesHuman + forVotesClaw
  const totalAgainst = againstVotesHuman + againstVotesClaw
  const totalVotes = totalFor + totalAgainst + abstainVotes

  const handleVote = async (support: number) => {
    try {
      await vote(proposalId, support)
      setVoted(true)
      onVoteComplete?.()
    } catch {
      // error handled by hook
    }
  }

  return (
    <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6 space-y-5">
      <h3 className="text-lg font-display font-semibold text-text-primary">{t('votePanel')}</h3>

      {/* Vote progress */}
      <div className="space-y-3">
        <VoteBar label={t('voteFor')} count={totalFor} total={totalVotes} color="emerald" />
        <VoteBar label={t('voteAgainst')} count={totalAgainst} total={totalVotes} color="red" />
        <VoteBar label={t('voteAbstain')} count={abstainVotes} total={totalVotes} color="gray" />
      </div>

      {/* Faction breakdown */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/10 p-3">
          <p className="text-emerald-400 font-display text-xs mb-1">Human</p>
          <p className="text-text-secondary font-display">
            For: {forVotesHuman} / Against: {againstVotesHuman}
          </p>
        </div>
        <div className="rounded-lg bg-purple-500/5 border border-purple-500/10 p-3">
          <p className="text-purple-400 font-display text-xs mb-1">Claw</p>
          <p className="text-text-secondary font-display">
            For: {forVotesClaw} / Against: {againstVotesClaw}
          </p>
        </div>
      </div>

      {/* Vote buttons */}
      {isActive && isConnected && !voted && (
        <div className="flex gap-3">
          <button
            onClick={() => handleVote(1)}
            disabled={loading}
            className="flex-1 py-3 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 font-display font-semibold transition-all disabled:opacity-50"
          >
            {t('voteFor')}
          </button>
          <button
            onClick={() => handleVote(0)}
            disabled={loading}
            className="flex-1 py-3 rounded-lg bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 font-display font-semibold transition-all disabled:opacity-50"
          >
            {t('voteAgainst')}
          </button>
          <button
            onClick={() => handleVote(2)}
            disabled={loading}
            className="py-3 px-4 rounded-lg bg-bg-secondary text-text-muted border border-text-muted/10 hover:text-text-secondary font-display text-sm transition-all disabled:opacity-50"
          >
            {t('voteAbstain')}
          </button>
        </div>
      )}

      {voted && (
        <div className="text-center py-2 text-accent-cyan font-display text-sm">
          {t('alreadyVoted')}
        </div>
      )}

      {!isConnected && (
        <div className="text-center py-2 text-text-muted font-display text-sm">
          {t('connectToVote')}
        </div>
      )}
    </div>
  )
}

function VoteBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const percent = total > 0 ? (count / total) * 100 : 0
  const colorMap: Record<string, string> = {
    emerald: 'bg-emerald-500',
    red: 'bg-red-500',
    gray: 'bg-text-muted',
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary font-display">{label}</span>
        <span className="text-text-muted font-display">{count} ({percent.toFixed(1)}%)</span>
      </div>
      <div className="h-2 rounded-full bg-bg-secondary overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colorMap[color] || colorMap.gray}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
