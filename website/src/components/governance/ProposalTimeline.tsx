'use client'

import { PROPOSAL_STATES } from '@/lib/contracts'
import { useTranslations } from 'next-intl'

interface ProposalTimelineProps {
  state: number
  createdAt: number
  votingDeadline: number
  executionDeadline: number
}

const TIMELINE_STEPS = [
  { state: 0, label: 'created' },
  { state: 0, label: 'voting' },
  { state: 3, label: 'queued' },
  { state: 4, label: 'executed' },
] as const

export function ProposalTimeline({ state, createdAt, votingDeadline, executionDeadline }: ProposalTimelineProps) {
  const t = useTranslations('governance')

  const stateLabel = PROPOSAL_STATES[state] || 'Unknown'
  const isFailed = state === 2 || state === 5 || state === 6 // Rejected, Cancelled, Expired

  const getStepStatus = (stepIndex: number): 'completed' | 'active' | 'pending' | 'failed' => {
    if (isFailed) {
      if (stepIndex === 0) return 'completed'
      if (stepIndex === 1 && state === 2) return 'failed'
      return 'pending'
    }
    if (state >= 4 && stepIndex <= 3) return 'completed'
    if (state >= 3 && stepIndex <= 2) return 'completed'
    if (state >= 1 && stepIndex <= 1) return 'completed'
    if (state === 0 && stepIndex === 1) return 'active'
    if (state === 0 && stepIndex === 0) return 'completed'
    if (state === 3 && stepIndex === 3) return 'active'
    return 'pending'
  }

  return (
    <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6">
      <h3 className="text-lg font-display font-semibold text-text-primary mb-4">{t('timeline')}</h3>

      <div className="flex items-center justify-between relative">
        {/* Connection line */}
        <div className="absolute top-3 left-6 right-6 h-0.5 bg-bg-secondary" />

        {TIMELINE_STEPS.map((step, i) => {
          const status = getStepStatus(i)
          return (
            <div key={i} className="relative flex flex-col items-center gap-2 z-10">
              <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${
                status === 'completed' ? 'bg-accent-cyan border-accent-cyan' :
                status === 'active' ? 'bg-bg-elevated border-accent-cyan animate-pulse' :
                status === 'failed' ? 'bg-red-500/20 border-red-500' :
                'bg-bg-secondary border-text-muted/30'
              }`}>
                {status === 'completed' && (
                  <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
                {status === 'failed' && (
                  <svg className="w-3 h-3 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
              <span className={`text-xs font-display ${
                status === 'completed' || status === 'active' ? 'text-accent-cyan' :
                status === 'failed' ? 'text-red-400' :
                'text-text-muted'
              }`}>
                {t(`step.${step.label}`)}
              </span>
            </div>
          )
        })}
      </div>

      {/* Dates */}
      <div className="mt-4 flex items-center justify-between text-xs text-text-muted font-display">
        <span>{new Date(createdAt * 1000).toLocaleDateString()}</span>
        <span>Vote ends: {new Date(votingDeadline * 1000).toLocaleDateString()}</span>
        {executionDeadline > 0 && (
          <span>Execute by: {new Date(executionDeadline * 1000).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  )
}
