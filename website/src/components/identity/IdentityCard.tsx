'use client'

import { FactionBadge } from '@/components/forum/FactionBadge'
import { useTranslations } from 'next-intl'

interface IdentityCardProps {
  address: string
  faction: string
  verified: boolean
  registeredAt?: number
  displayName?: string
}

export function IdentityCard({ address, faction, verified, registeredAt, displayName }: IdentityCardProps) {
  const t = useTranslations('identity')

  return (
    <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-display font-semibold text-text-primary">{t('identityInfo')}</h3>
        <FactionBadge faction={faction} size="md" />
      </div>

      <div className="space-y-3">
        {displayName && (
          <div>
            <span className="text-xs text-text-muted font-display">{t('displayName')}</span>
            <p className="text-text-primary font-body">{displayName}</p>
          </div>
        )}

        <div>
          <span className="text-xs text-text-muted font-display">{t('address')}</span>
          <p className="text-text-secondary font-display text-sm break-all">{address}</p>
        </div>

        <div className="flex items-center gap-4">
          <div>
            <span className="text-xs text-text-muted font-display">{t('status')}</span>
            <p className={`text-sm font-display ${verified ? 'text-emerald-400' : 'text-amber-400'}`}>
              {verified ? t('verified') : t('unverified')}
            </p>
          </div>

          {registeredAt && (
            <div>
              <span className="text-xs text-text-muted font-display">{t('registeredAt')}</span>
              <p className="text-sm text-text-secondary font-display">
                {new Date(registeredAt * 1000).toLocaleDateString()}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
