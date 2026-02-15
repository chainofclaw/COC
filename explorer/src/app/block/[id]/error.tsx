'use client'

export default function BlockError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6 text-center">
      <h2 className="text-xl font-bold text-red-600 mb-2">Failed to load block</h2>
      <p className="text-gray-500 text-sm mb-4">{error.message}</p>
      <button
        onClick={reset}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
      >
        Retry
      </button>
    </div>
  )
}
