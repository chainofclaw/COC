'use client'

import { useTranslations } from 'next-intl'

interface BicameralViewProps {
  forVotesHuman: number
  againstVotesHuman: number
  forVotesClaw: number
  againstVotesClaw: number
  approvalPercent: number
  bicameralEnabled: boolean
}

export function BicameralView({
  forVotesHuman, againstVotesHuman, forVotesClaw, againstVotesClaw,
  approvalPercent, bicameralEnabled,
}: BicameralViewProps) {
  const t = useTranslations('governance')

  const humanTotal = forVotesHuman + againstVotesHuman
  const clawTotal = forVotesClaw + againstVotesClaw
  const humanPercent = humanTotal > 0 ? (forVotesHuman / humanTotal) * 100 : 0
  const clawPercent = clawTotal > 0 ? (forVotesClaw / clawTotal) * 100 : 0
  const humanPassed = humanTotal === 0 || humanPercent >= approvalPercent
  const clawPassed = clawTotal === 0 || clawPercent >= approvalPercent

  return (
    <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-display font-semibold text-text-primary">
          {t('bicameral')}
        </h3>
        {bicameralEnabled ? (
          <span className="text-xs px-2 py-1 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20 font-display">
            ACTIVE
          </span>
        ) : (
          <span className="text-xs px-2 py-1 rounded bg-text-muted/10 text-text-muted border border-text-muted/20 font-display">
            INACTIVE
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Human chamber */}
        <div className={`rounded-lg p-4 border ${humanPassed ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-bg-secondary border-text-muted/10'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-sm font-display font-semibold text-emerald-400">
              Human Chamber
            </span>
            {humanPassed && (
              <svg className="w-4 h-4 text-emerald-400 ml-auto" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-display">
              <span className="text-emerald-400">For: {forVotesHuman}</span>
              <span className="text-red-400">Against: {againstVotesHuman}</span>
            </div>
            <div className="h-2 rounded-full bg-bg-secondary overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${humanPercent}%` }} />
            </div>
            <div className="text-xs text-text-muted font-display text-center">
              {humanPercent.toFixed(1)}% (need {approvalPercent}%)
            </div>
          </div>
        </div>

        {/* Claw chamber */}
        <div className={`rounded-lg p-4 border ${clawPassed ? 'bg-purple-500/5 border-purple-500/20' : 'bg-bg-secondary border-text-muted/10'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-purple-400" />
            <span className="text-sm font-display font-semibold text-purple-400">
              Claw Chamber
            </span>
            {clawPassed && (
              <svg className="w-4 h-4 text-purple-400 ml-auto" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-display">
              <span className="text-purple-400">For: {forVotesClaw}</span>
              <span className="text-red-400">Against: {againstVotesClaw}</span>
            </div>
            <div className="h-2 rounded-full bg-bg-secondary overflow-hidden">
              <div className="h-full bg-purple-500 transition-all" style={{ width: `${clawPercent}%` }} />
            </div>
            <div className="text-xs text-text-muted font-display text-center">
              {clawPercent.toFixed(1)}% (need {approvalPercent}%)
            </div>
          </div>
        </div>
      </div>

      {bicameralEnabled && (
        <div className={`text-center text-sm font-display ${
          humanPassed && clawPassed ? 'text-emerald-400' : 'text-amber-400'
        }`}>
          {humanPassed && clawPassed ? t('bothChambersPassed') : t('bothChambersNeeded')}
        </div>
      )}
    </div>
  )
}
