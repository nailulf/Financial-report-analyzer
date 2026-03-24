import Link from 'next/link'
import { SearchBar } from './search-bar'

export function Navbar() {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-[#E5E4E1] shadow-[0_1px_6px_rgba(26,25,24,0.04)]">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <span className="text-lg font-bold text-[#1A1918] tracking-tight">IDX</span>
          <span className="text-xs font-semibold text-[#3D8A5A] bg-[#C8F0D8] px-2 py-0.5 rounded-lg">Analyzer</span>
        </Link>

        <div className="flex-1 max-w-sm">
          <SearchBar />
        </div>

        <nav className="hidden sm:flex items-center gap-5 text-sm font-medium text-[#6D6C6A]">
          <Link href="/" className="hover:text-[#1A1918] transition-colors">Screener</Link>
          <Link href="/money-flow" className="hover:text-[#1A1918] transition-colors">Money Flow</Link>
          <Link href="/compare" className="hover:text-[#1A1918] transition-colors">Compare</Link>
          <Link href="/investors" className="hover:text-[#1A1918] transition-colors">Investors</Link>
        </nav>
      </div>
    </header>
  )
}
