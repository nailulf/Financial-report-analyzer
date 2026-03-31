'use client'

import { useState, useEffect, useCallback } from 'react'

const TABS = [
  { id: 'overview',      label: 'RINGKASAN' },
  { id: 'fundamentals',  label: 'FUNDAMENTAL' },
  { id: 'money-flow',    label: 'ARUS DANA' },
  { id: 'about',         label: 'TENTANG' },
]

export function NavTabs() {
  const [active, setActive] = useState('overview')

  const handleClick = (id: string) => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(id)
  }

  const onScroll = useCallback(() => {
    const offset = 120
    for (const tab of [...TABS].reverse()) {
      const el = document.getElementById(tab.id)
      if (el && el.getBoundingClientRect().top <= offset) {
        setActive(tab.id)
        return
      }
    }
    setActive('overview')
  }, [])

  useEffect(() => {
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [onScroll])

  return (
    <div className="bg-white border-b border-[#E0E0E5] flex px-12 sticky top-0 z-20">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => handleClick(tab.id)}
          className={`px-4 py-[10px] font-mono text-[12px] font-medium tracking-[1px] transition-colors cursor-pointer ${
            active === tab.id
              ? 'text-[#00FF88] border-b-2 border-[#00FF88]'
              : 'text-[#888888] hover:text-[#555555]'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
