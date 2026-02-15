'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Explorer error:', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center py-20">
      <h2 className="text-6xl font-bold text-red-300 mb-4">Error</h2>
      <p className="text-xl text-gray-600 mb-4">Something went wrong</p>
      <p className="text-sm text-gray-500 mb-2 max-w-md text-center">
        {error.message || 'An unexpected error occurred while loading this page.'}
      </p>
      {error.digest && (
        <p className="text-xs text-gray-400 mb-6 font-mono">Digest: {error.digest}</p>
      )}
      <div className="flex gap-4">
        <button
          onClick={reset}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Try Again
        </button>
        <a
          href="/"
          className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
        >
          Back to Explorer
        </a>
      </div>
    </div>
  )
}
