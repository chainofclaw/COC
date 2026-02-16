'use client'

interface PaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}

export function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null

  const pages: number[] = []
  const start = Math.max(1, currentPage - 2)
  const end = Math.min(totalPages, currentPage + 2)

  for (let i = start; i <= end; i++) {
    pages.push(i)
  }

  return (
    <div className="flex items-center justify-center gap-2 mt-8">
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        className="px-3 py-2 rounded-lg bg-bg-elevated text-text-secondary hover:text-accent-cyan disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-display text-sm"
      >
        &lt;
      </button>

      {start > 1 && (
        <>
          <button
            onClick={() => onPageChange(1)}
            className="px-3 py-2 rounded-lg bg-bg-elevated text-text-secondary hover:text-accent-cyan transition-colors font-display text-sm"
          >
            1
          </button>
          {start > 2 && <span className="text-text-muted">...</span>}
        </>
      )}

      {pages.map(page => (
        <button
          key={page}
          onClick={() => onPageChange(page)}
          className={`px-3 py-2 rounded-lg font-display text-sm transition-colors ${
            page === currentPage
              ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
              : 'bg-bg-elevated text-text-secondary hover:text-accent-cyan'
          }`}
        >
          {page}
        </button>
      ))}

      {end < totalPages && (
        <>
          {end < totalPages - 1 && <span className="text-text-muted">...</span>}
          <button
            onClick={() => onPageChange(totalPages)}
            className="px-3 py-2 rounded-lg bg-bg-elevated text-text-secondary hover:text-accent-cyan transition-colors font-display text-sm"
          >
            {totalPages}
          </button>
        </>
      )}

      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className="px-3 py-2 rounded-lg bg-bg-elevated text-text-secondary hover:text-accent-cyan disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-display text-sm"
      >
        &gt;
      </button>
    </div>
  )
}
