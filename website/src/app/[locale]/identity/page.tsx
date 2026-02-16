'use client'

import { WalletConnect } from '@/components/identity/WalletConnect'
import { FactionSelector } from '@/components/identity/FactionSelector'
import { IdentityCard } from '@/components/identity/IdentityCard'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { useTranslations } from 'next-intl'
import { useState, useEffect } from 'react'

export default function IdentityPage() {
  const { address, isConnected, faction, signMessage } = useWalletContext()
  const t = useTranslations('identity')
  const [identity, setIdentity] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (address) {
      fetchIdentity(address)
    }
  }, [address])

  const fetchIdentity = async (addr: string) => {
    try {
      const res = await fetch(`/api/identity/${addr}`)
      if (res.ok) {
        setIdentity(await res.json())
      }
    } catch {
      // not registered yet
    }
  }

  const handleRegister = async (detectedFaction: 'human' | 'claw') => {
    if (!address) return
    setLoading(true)
    try {
      const message = `COC Identity Registration\nAddress: ${address}\nFaction: ${detectedFaction}\nTimestamp: ${Date.now()}`
      const signature = await signMessage(message)

      const res = await fetch('/api/identity/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, faction: detectedFaction, signature, message }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Registration failed')
      }

      await fetchIdentity(address)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="container mx-auto px-4 py-16 max-w-2xl">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-display font-bold gradient-text mb-4">{t('title')}</h1>
        <p className="text-text-secondary">{t('subtitle')}</p>
      </div>

      <div className="space-y-8">
        {/* Wallet connection */}
        <div className="flex justify-center">
          <WalletConnect />
        </div>

        {/* Identity card (if registered) */}
        {identity && identity.faction !== 'none' && (
          <IdentityCard
            address={identity.address}
            faction={identity.faction}
            verified={identity.verified === 1}
            registeredAt={Math.floor(identity.created_at / 1000)}
            displayName={identity.display_name}
          />
        )}

        {/* Registration (if connected but not registered) */}
        {isConnected && (!identity || identity.faction === 'none') && (
          <FactionSelector onRegister={handleRegister} />
        )}

        {/* Info */}
        <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-6 space-y-3">
          <h3 className="font-display font-semibold text-text-primary">{t('howItWorks')}</h3>
          <ul className="space-y-2 text-sm text-text-secondary">
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">1.</span>
              {t('step1')}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">2.</span>
              {t('step2')}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">3.</span>
              {t('step3')}
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}
