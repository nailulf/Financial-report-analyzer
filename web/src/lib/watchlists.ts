// ---------------------------------------------------------------------------
// Multiple named watchlists — localStorage-based storage
// ---------------------------------------------------------------------------

export interface Watchlist {
  id: string
  name: string
  tickers: string[]
  createdAt: number
}

const LISTS_KEY = 'idx_watchlists'
const ACTIVE_KEY = 'idx_watchlist_active'
const LEGACY_KEY = 'idx_watchlist' // old single-list key

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}

function dispatch() {
  window.dispatchEvent(new Event('watchlist-change'))
}

/** Migrate old single-list format to new multi-list format (runs once). */
function migrateLegacy(): Watchlist[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const tickers: string[] = JSON.parse(raw)
    if (!Array.isArray(tickers) || tickers.length === 0) return null

    const migrated: Watchlist = {
      id: generateId(),
      name: 'Watchlist',
      tickers,
      createdAt: Date.now(),
    }
    localStorage.setItem(LISTS_KEY, JSON.stringify([migrated]))
    localStorage.setItem(ACTIVE_KEY, migrated.id)
    localStorage.removeItem(LEGACY_KEY)
    return [migrated]
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getWatchlists(): Watchlist[] {
  try {
    const raw = localStorage.getItem(LISTS_KEY)
    if (raw) return JSON.parse(raw)
    // Try migrating legacy data
    const migrated = migrateLegacy()
    return migrated ?? []
  } catch {
    return []
  }
}

export function getActiveWatchlistId(): string | null {
  return localStorage.getItem(ACTIVE_KEY)
}

export function getActiveWatchlist(): Watchlist | null {
  const lists = getWatchlists()
  const activeId = getActiveWatchlistId()
  if (activeId) {
    const found = lists.find((l) => l.id === activeId)
    if (found) return found
  }
  // Fallback to first list
  return lists[0] ?? null
}

export function isTickerInActiveWatchlist(ticker: string): boolean {
  const active = getActiveWatchlist()
  return active ? active.tickers.includes(ticker) : false
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function save(lists: Watchlist[]) {
  localStorage.setItem(LISTS_KEY, JSON.stringify(lists))
  dispatch()
}

export function setActiveWatchlistId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id)
  dispatch()
}

export function createWatchlist(name: string): Watchlist {
  const lists = getWatchlists()
  const wl: Watchlist = {
    id: generateId(),
    name: name.trim() || 'Watchlist',
    tickers: [],
    createdAt: Date.now(),
  }
  lists.push(wl)
  save(lists)
  setActiveWatchlistId(wl.id)
  return wl
}

export function renameWatchlist(id: string, name: string) {
  const lists = getWatchlists()
  const wl = lists.find((l) => l.id === id)
  if (!wl) return
  wl.name = name.trim() || wl.name
  save(lists)
}

export function deleteWatchlist(id: string) {
  let lists = getWatchlists()
  lists = lists.filter((l) => l.id !== id)
  save(lists)
  // If deleted the active one, switch to first remaining
  if (getActiveWatchlistId() === id) {
    const next = lists[0]
    if (next) {
      localStorage.setItem(ACTIVE_KEY, next.id)
    } else {
      localStorage.removeItem(ACTIVE_KEY)
    }
  }
}

export function addTicker(watchlistId: string, ticker: string) {
  const lists = getWatchlists()
  const wl = lists.find((l) => l.id === watchlistId)
  if (!wl || wl.tickers.includes(ticker)) return
  wl.tickers.push(ticker)
  save(lists)
}

export function removeTicker(watchlistId: string, ticker: string) {
  const lists = getWatchlists()
  const wl = lists.find((l) => l.id === watchlistId)
  if (!wl) return
  wl.tickers = wl.tickers.filter((t) => t !== ticker)
  save(lists)
}

/** Toggle ticker in active watchlist. Auto-creates a watchlist if none exist. */
export function toggleTickerInActive(ticker: string): boolean {
  let active = getActiveWatchlist()
  if (!active) {
    active = createWatchlist('Watchlist')
  }
  const has = active.tickers.includes(ticker)
  if (has) {
    removeTicker(active.id, ticker)
  } else {
    addTicker(active.id, ticker)
  }
  return !has // returns new starred state
}
