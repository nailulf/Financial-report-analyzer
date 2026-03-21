import Link from 'next/link'
import { SearchBar } from './search-bar'

export function Navbar() {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <span className="text-lg font-bold text-gray-900 tracking-tight">IDX</span>
          <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">Analyzer</span>
        </Link>

        <div className="flex-1 max-w-sm">
          <SearchBar />
        </div>

        <nav className="hidden sm:flex items-center gap-5 text-sm font-medium text-gray-500">
          <Link href="/" className="hover:text-gray-900 transition-colors">Screener</Link>
          <Link href="/money-flow" className="hover:text-gray-900 transition-colors">Money Flow</Link>
          <Link href="/compare" className="hover:text-gray-900 transition-colors">Compare</Link>
          <Link href="/investors" className="hover:text-gray-900 transition-colors">Investors</Link>
        </nav>
      </div>
    </header>
  )
}
