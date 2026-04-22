import { sendGAEvent } from '@next/third-parties/google'

export const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? ''
export const GA_ENABLED = GA_ID.length > 0

export type GAEventParams = Record<string, string | number | boolean | null | undefined>

export function trackEvent(name: string, params: GAEventParams = {}) {
  if (!GA_ENABLED) return
  if (typeof window === 'undefined') return
  sendGAEvent('event', name, params)
}

export const track = {
  stockViewed: (ticker: string) => trackEvent('stock_viewed', { ticker }),

  screenerFilterApplied: (filters: Record<string, string>) => {
    const keys = Object.keys(filters).filter((k) => filters[k])
    trackEvent('screener_filter_applied', {
      filter_count: keys.length,
      filters_active: keys.join(',') || 'none',
    })
  },

  screenerFilterCleared: () => trackEvent('screener_filter_cleared'),

  strategySaved: (name: string, filterCount: number) =>
    trackEvent('strategy_saved', { strategy_name: name, filter_count: filterCount }),

  refreshData: (ticker: string, scrapers: string[]) =>
    trackEvent('refresh_data', {
      ticker,
      scrapers: scrapers.join(',') || 'none',
      scraper_count: scrapers.length,
    }),

  watchlistToggle: (ticker: string, added: boolean) =>
    trackEvent('watchlist_toggle', { ticker, action: added ? 'add' : 'remove' }),

  watchlistCreated: () => trackEvent('watchlist_created'),

  compareTickerAdded: (ticker: string, total: number) =>
    trackEvent('compare_ticker_added', { ticker, total_tickers: total }),
}
