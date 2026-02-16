'use client'

import { useState } from 'react'

interface VoteButtonProps {
  upvotes: number
  downvotes: number
  onVote: (type: 'up' | 'down') => Promise<{ upvotes: number; downvotes: number }>
  disabled?: boolean
}

export function VoteButton({ upvotes, downvotes, onVote, disabled }: VoteButtonProps) {
  const [counts, setCounts] = useState({ upvotes, downvotes })
  const [voting, setVoting] = useState(false)

  const handleVote = async (type: 'up' | 'down') => {
    if (voting || disabled) return
    setVoting(true)
    try {
      const result = await onVote(type)
      setCounts(result)
    } finally {
      setVoting(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => handleVote('up')}
        disabled={voting || disabled}
        className="flex items-center gap-1 px-2 py-1 rounded text-text-muted hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-30"
      >
        <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 3a1 1 0 01.894.553l6 12A1 1 0 0116 17H4a1 1 0 01-.894-1.447l6-12A1 1 0 0110 3z" clipRule="evenodd" />
        </svg>
        <span className="text-xs font-display">{counts.upvotes}</span>
      </button>
      <button
        onClick={() => handleVote('down')}
        disabled={voting || disabled}
        className="flex items-center gap-1 px-2 py-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30"
      >
        <svg className="w-4 h-4 rotate-180" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 3a1 1 0 01.894.553l6 12A1 1 0 0116 17H4a1 1 0 01-.894-1.447l6-12A1 1 0 0110 3z" clipRule="evenodd" />
        </svg>
        <span className="text-xs font-display">{counts.downvotes}</span>
      </button>
    </div>
  )
}
