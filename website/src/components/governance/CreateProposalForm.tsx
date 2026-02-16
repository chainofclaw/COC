'use client'

import { useState } from 'react'
import { useWalletContext } from '@/components/shared/WalletProvider'
import { useGovernance } from '@/hooks/useGovernance'
import { PROPOSAL_TYPES } from '@/lib/contracts'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/routing'
import { ethers } from 'ethers'

export function CreateProposalForm() {
  const { signer, isConnected } = useWalletContext()
  const { createProposal, loading } = useGovernance(signer)
  const t = useTranslations('governance')
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [proposalType, setProposalType] = useState(5) // FreeText
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !description.trim()) {
      setError(t('fillRequired'))
      return
    }

    setError(null)
    try {
      const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description))
      await createProposal({
        proposalType,
        title,
        descriptionHash,
      })
      router.push('/governance')
    } catch (err: any) {
      setError(err.message)
    }
  }

  if (!isConnected) {
    return (
      <div className="rounded-xl bg-bg-elevated border border-text-muted/10 p-8 text-center">
        <p className="text-text-secondary">{t('connectToPropose')}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-display text-text-secondary mb-2">{t('proposalType')}</label>
        <div className="flex flex-wrap gap-2">
          {PROPOSAL_TYPES.map((type, i) => (
            <button
              key={type}
              type="button"
              onClick={() => setProposalType(i)}
              className={`px-4 py-2 rounded-lg text-sm font-display transition-colors ${
                proposalType === i
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'bg-bg-secondary text-text-muted border border-text-muted/10 hover:text-text-secondary'
              }`}
            >
              {t(`type.${type}`)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-display text-text-secondary mb-2">{t('proposalTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
          className="w-full px-4 py-3 rounded-lg bg-bg-secondary border border-text-muted/10 text-text-primary font-body focus:border-accent-cyan/50 focus:outline-none transition-colors"
          placeholder={t('titlePlaceholder')}
        />
      </div>

      <div>
        <label className="block text-sm font-display text-text-secondary mb-2">{t('proposalDescription')}</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={8}
          className="w-full px-4 py-3 rounded-lg bg-bg-secondary border border-text-muted/10 text-text-primary font-body focus:border-accent-cyan/50 focus:outline-none transition-colors resize-y"
          placeholder={t('descriptionPlaceholder')}
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="px-6 py-3 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all disabled:opacity-50"
      >
        {loading ? t('submitting') : t('createProposal')}
      </button>
    </form>
  )
}
