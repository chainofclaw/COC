'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { VotePanel } from '@/components/governance/VotePanel'
import { ProposalTimeline } from '@/components/governance/ProposalTimeline'
import { BicameralView } from '@/components/governance/BicameralView'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { useGovernance, type ProposalData } from '@/hooks/useGovernance'
import { PROPOSAL_TYPES, PROPOSAL_STATES } from '@/lib/contracts'
import { useTranslations } from 'next-intl'

export default function ProposalDetailPage() {
  const params = useParams()
  const proposalId = Number(params.id)
  const { signer, address, isConnected } = useWalletContext()
  const { getProposal, getProposalStateLabel } = useGovernance(signer)
  const t = useTranslations('governance')
  const [proposal, setProposal] = useState<ProposalData | null>(null)
  const [hasVoted, setHasVoted] = useState(false)

  const fetchProposal = useCallback(async () => {
    const p = await getProposal(proposalId)
    if (p) setProposal(p)
  }, [proposalId, getProposal])

  useEffect(() => {
    fetchProposal()
  }, [fetchProposal])

  if (!proposal) {
    return <div className="container mx-auto px-4 py-16 text-center text-text-muted font-display">Loading...</div>
  }

  const isActive = proposal.state === 0 && proposal.votingDeadline * 1000 > Date.now()
  const typeLabel = PROPOSAL_TYPES[proposal.proposalType] || 'Unknown'
  const stateLabel = getProposalStateLabel(proposal.state)

  return (
    <section className="container mx-auto px-4 py-16 max-w-4xl">
      <div className="mb-8 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted font-display">#{proposal.id}</span>
          <span className="text-xs px-2 py-0.5 rounded border border-accent-blue/30 text-accent-blue font-display">
            {typeLabel}
          </span>
          <span className="text-xs px-2 py-0.5 rounded border border-accent-cyan/30 text-accent-cyan font-display">
            {stateLabel}
          </span>
        </div>

        <h1 className="text-3xl font-display font-bold text-text-primary">{proposal.title}</h1>

        <div className="flex items-center gap-3 text-sm text-text-muted font-display">
          <span>by {proposal.proposer.slice(0, 6)}...{proposal.proposer.slice(-4)}</span>
          <span>{new Date(proposal.createdAt * 1000).toLocaleString()}</span>
        </div>
      </div>

      <div className="space-y-6">
        <ProposalTimeline
          state={proposal.state}
          createdAt={proposal.createdAt}
          votingDeadline={proposal.votingDeadline}
          executionDeadline={proposal.executionDeadline}
        />

        <VotePanel
          proposalId={proposal.id}
          forVotesHuman={proposal.forVotesHuman}
          againstVotesHuman={proposal.againstVotesHuman}
          forVotesClaw={proposal.forVotesClaw}
          againstVotesClaw={proposal.againstVotesClaw}
          abstainVotes={proposal.abstainVotes}
          hasVoted={hasVoted}
          isActive={isActive}
          onVoteComplete={fetchProposal}
        />

        <BicameralView
          forVotesHuman={proposal.forVotesHuman}
          againstVotesHuman={proposal.againstVotesHuman}
          forVotesClaw={proposal.forVotesClaw}
          againstVotesClaw={proposal.againstVotesClaw}
          approvalPercent={60}
          bicameralEnabled={false}
        />

        {/* Execution details */}
        {proposal.executionTarget !== '0x0000000000000000000000000000000000000000' && (
          <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6 space-y-3">
            <h3 className="text-lg font-display font-semibold text-text-primary">{t('executionDetails')}</h3>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-text-muted font-display">Target: </span>
                <span className="text-text-secondary font-display break-all">{proposal.executionTarget}</span>
              </div>
              {proposal.value > 0n && (
                <div>
                  <span className="text-text-muted font-display">Value: </span>
                  <span className="text-text-secondary font-display">{proposal.value.toString()} wei</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
