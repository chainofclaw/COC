'use client'

interface FactionBadgeProps {
  faction: string | undefined | null
  size?: 'sm' | 'md'
}

export function FactionBadge({ faction, size = 'sm' }: FactionBadgeProps) {
  if (!faction || faction === 'none' || faction === 'None') return null

  const isHuman = faction.toLowerCase() === 'human'
  const label = isHuman ? 'Human' : 'Claw'

  const sizeClasses = size === 'sm'
    ? 'text-xs px-2 py-0.5'
    : 'text-sm px-3 py-1'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-display font-semibold ${sizeClasses} ${
        isHuman
          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
          : 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isHuman ? 'bg-emerald-400' : 'bg-purple-400'}`} />
      {label}
    </span>
  )
}
