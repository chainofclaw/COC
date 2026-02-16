'use client'

import { Link } from '@/i18n/routing'
import { PROPOSAL_TYPES, PROPOSAL_STATES } from '@/lib/contracts'

interface ProposalCardProps {
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

const STATE_COLORS: Record<string, string> = {
  Pending: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  Approved: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  Rejected: 'text-red-400 bg-red-500/10 border-red-500/20',
  Queued: 'text-accent-blue bg-accent-blue/10 border-accent-blue/20',
  Executed: 'text-accent-cyan bg-accent-cyan/10 border-accent-cyan/20',
  Cancelled: 'text-text-muted bg-text-muted/10 border-text-muted/20',
  Expired: 'text-text-muted bg-text-muted/10 border-text-muted/20',
}

export function ProposalCard({
  id, title, proposalType, proposer, state,
  forVotesHuman, againstVotesHuman, forVotesClaw, againstVotesClaw, abstainVotes,
  votingDeadline, createdAt,
}: ProposalCardProps) {
  const stateLabel = PROPOSAL_STATES[state] || 'Unknown'
  const typeLabel = PROPOSAL_TYPES[proposalType] || 'Unknown'
  const totalFor = forVotesHuman + forVotesClaw
  const totalAgainst = againstVotesHuman + againstVotesClaw
  const totalVotes = totalFor + totalAgainst + abstainVotes
  const forPercent = totalVotes > 0 ? (totalFor / totalVotes) * 100 : 0
  const timeLeft = votingDeadline * 1000 - Date.now()
  const isActive = state === 0 && timeLeft > 0

  return (
    <Link href={`/governance/${id}`}>
      <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-5 space-y-4 hover:border-accent-cyan/30 hover:shadow-glow-sm transition-all">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-text-muted font-display">#{id}</span>
              <span className="text-xs px-2 py-0.5 rounded border border-accent-blue/30 text-accent-blue font-display">
                {typeLabel}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded border font-display ${STATE_COLORS[stateLabel] || ''}`}>
                {stateLabel}
              </span>
            </div>
            <h3 className="text-text-primary font-display font-semibold text-lg">{title}</h3>
          </div>
        </div>

        {/* Vote progress bar */}
        <div className="space-y-2">
          <div className="h-2 rounded-full bg-bg-secondary overflow-hidden flex">
            {totalVotes > 0 && (
              <>
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${forPercent}%` }}
                />
                <div
                  className="h-full bg-red-500 transition-all"
                  style={{ width: `${((totalAgainst / totalVotes) * 100)}%` }}
                />
              </>
            )}
          </div>
          <div className="flex items-center justify-between text-xs font-display">
            <div className="flex items-center gap-3">
              <span className="text-emerald-400">For: {totalFor}</span>
              <span className="text-red-400">Against: {totalAgainst}</span>
              <span className="text-text-muted">Abstain: {abstainVotes}</span>
            </div>
            <span className="text-text-muted">
              {isActive ? formatTimeLeft(timeLeft) : stateLabel}
            </span>
          </div>

          {/* Faction breakdown */}
          <div className="flex items-center gap-4 text-xs font-display">
            <span className="text-emerald-400/70">Human: {forVotesHuman}/{forVotesHuman + againstVotesHuman}</span>
            <span className="text-purple-400/70">Claw: {forVotesClaw}/{forVotesClaw + againstVotesClaw}</span>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-text-muted font-display">
          <span>by {proposer.slice(0, 6)}...{proposer.slice(-4)}</span>
          <span>{new Date(createdAt * 1000).toLocaleDateString()}</span>
        </div>
      </div>
    </Link>
  )
}

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'Ended'
  const hours = Math.floor(ms / 3600000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h left`
  const mins = Math.floor((ms % 3600000) / 60000)
  return `${hours}h ${mins}m left`
}
