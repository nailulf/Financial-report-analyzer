import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="max-w-7xl mx-auto px-4 py-24 text-center">
      <p className="text-5xl font-bold text-gray-200 mb-4">404</p>
      <h1 className="text-xl font-semibold text-gray-700 mb-2">Stock not found</h1>
      <p className="text-gray-500 mb-6">That ticker doesn't exist in the database.</p>
      <Link href="/" className="text-blue-600 hover:underline text-sm">← Back to screener</Link>
    </main>
  )
}
