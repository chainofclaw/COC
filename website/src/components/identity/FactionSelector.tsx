'use client'

import { useWalletContext } from '@/components/shared/WalletProvider'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

interface FactionSelectorProps {
  onRegister: (faction: 'human' | 'claw') => Promise<void>
}

export function FactionSelector({ onRegister }: FactionSelectorProps) {
  const { faction, isConnected } = useWalletContext()
  const t = useTranslations('identity')
  const [registering, setRegistering] = useState(false)

  if (!isConnected) {
    return (
      <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-8 text-center">
        <p className="text-text-secondary">{t('connectFirst')}</p>
      </div>
    )
  }

  const detectedFaction = faction === 'Human' ? 'human' : faction === 'Claw' ? 'claw' : null

  if (!detectedFaction) {
    return (
      <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-8 text-center">
        <p className="text-text-secondary">{t('unknownWallet')}</p>
      </div>
    )
  }

  const handleRegister = async () => {
    setRegistering(true)
    try {
      await onRegister(detectedFaction)
    } finally {
      setRegistering(false)
    }
  }

  const isHuman = detectedFaction === 'human'

  return (
    <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-8 space-y-6">
      <div className="text-center space-y-2">
        <div className={`inline-flex w-16 h-16 rounded-2xl items-center justify-center text-3xl ${
          isHuman ? 'bg-emerald-500/15' : 'bg-purple-500/15'
        }`}>
          {isHuman ? '\u{1F9D1}' : '\u{1F916}'}
        </div>
        <h3 className="text-xl font-display font-bold text-text-primary">
          {isHuman ? t('registerAsHuman') : t('registerAsClaw')}
        </h3>
        <p className="text-text-secondary text-sm">
          {isHuman ? t('humanDescription') : t('clawDescription')}
        </p>
      </div>

      <div className={`rounded-lg p-4 border ${
        isHuman ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-purple-500/5 border-purple-500/20'
      }`}>
        <p className="text-xs text-text-muted font-display">{t('factionNote')}</p>
      </div>

      <button
        onClick={handleRegister}
        disabled={registering}
        className={`w-full py-3 rounded-lg font-display font-semibold transition-all disabled:opacity-50 ${
          isHuman
            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
            : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30'
        }`}
      >
        {registering ? t('registering') : t('confirmRegister')}
      </button>
    </div>
  )
}
