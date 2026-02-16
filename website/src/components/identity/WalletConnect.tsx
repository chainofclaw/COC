'use client'

import { useWalletContext } from '@/components/shared/WalletProvider'
import { useTranslations } from 'next-intl'

export function WalletConnect() {
  const { address, isConnected, faction, connectionState, error, connectMetaMask, connectOpenClaw, disconnect } = useWalletContext()
  const t = useTranslations('identity')

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-elevated border border-text-muted/10">
          <span className={`w-2 h-2 rounded-full ${faction === 'Human' ? 'bg-emerald-400' : 'bg-purple-400'}`} />
          <span className="text-sm font-display text-text-secondary">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
          <span className={`text-xs font-display ${faction === 'Human' ? 'text-emerald-400' : 'text-purple-400'}`}>
            {faction}
          </span>
        </div>
        <button
          onClick={disconnect}
          className="text-xs text-text-muted hover:text-red-400 transition-colors font-display"
        >
          {t('disconnect')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={connectMetaMask}
        disabled={connectionState === 'connecting'}
        className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all font-display text-sm disabled:opacity-50"
      >
        {connectionState === 'connecting' ? '...' : t('connectHuman')}
      </button>
      <button
        onClick={connectOpenClaw}
        disabled={connectionState === 'connecting'}
        className="px-4 py-2 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 transition-all font-display text-sm disabled:opacity-50"
      >
        {connectionState === 'connecting' ? '...' : t('connectClaw')}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  )
}
