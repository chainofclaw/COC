import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <h2 className="text-6xl font-bold text-gray-300 mb-4">404</h2>
      <p className="text-xl text-gray-600 mb-6">Page not found</p>
      <p className="text-gray-500 mb-8">
        The block, transaction, or address you are looking for does not exist.
      </p>
      <Link
        href="/"
        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
      >
        Back to Explorer
      </Link>
    </div>
  )
}
