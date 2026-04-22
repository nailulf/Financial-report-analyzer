'use client'

import { useEffect, Suspense } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { trackEvent, GA_ENABLED } from '@/lib/analytics'

function Tracker() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (!GA_ENABLED) return
    const qs = searchParams.toString()
    const page_path = qs ? `${pathname}?${qs}` : pathname
    trackEvent('page_view', {
      page_path,
      page_location: typeof window !== 'undefined' ? window.location.href : page_path,
      page_title: typeof document !== 'undefined' ? document.title : '',
    })
  }, [pathname, searchParams])

  return null
}

export function PageviewTracker() {
  if (!GA_ENABLED) return null
  return (
    <Suspense fallback={null}>
      <Tracker />
    </Suspense>
  )
}
