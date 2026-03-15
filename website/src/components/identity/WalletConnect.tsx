'use client'

import { useWalletContext } from '@/components/shared/WalletProvider'
import { useTranslations } from 'next-intl'

export function WalletConnect() {
  const { address, isConnected, faction, disconnect } = useWalletContext()
  const t = useTranslations('identity')

  // Only show wallet info when connected, hide connection buttons
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

  // Connection buttons removed - return empty
  return null
}
