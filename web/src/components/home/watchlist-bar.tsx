'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  getWatchlists,
  getActiveWatchlist,
  setActiveWatchlistId,
  createWatchlist,
  renameWatchlist,
  deleteWatchlist,
  removeTicker,
  type Watchlist,
} from '@/lib/watchlists'

// ---------------------------------------------------------------------------
// WatchlistBar — inline multi-watchlist manager
// ---------------------------------------------------------------------------

export function WatchlistBar() {
  const [mounted, setMounted] = useState(false)
  const [lists, setLists] = useState<Watchlist[]>([])
  const [active, setActive] = useState<Watchlist | null>(null)

  // Dropdown & inline editing state
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const dropdownRef = useRef<HTMLDivElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  // ------ Sync from localStorage ------
  function sync() {
    const wls = getWatchlists()
    setLists(wls)
    setActive(getActiveWatchlist())
  }

  useEffect(() => {
    setMounted(true)
    sync()
    const handler = () => sync()
    window.addEventListener('watchlist-change', handler)
    return () => window.removeEventListener('watchlist-change', handler)
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setEditingId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownOpen])

  // Auto-focus inputs
  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus()
  }, [creatingNew])
  useEffect(() => {
    if (editingId) editInputRef.current?.focus()
  }, [editingId])

  if (!mounted) return null

  // ------ Handlers ------

  function handleSelect(wl: Watchlist) {
    setActiveWatchlistId(wl.id)
    setDropdownOpen(false)
    setEditingId(null)
  }

  function handleCreate() {
    const name = newName.trim()
    if (!name) return
    createWatchlist(name)
    setNewName('')
    setCreatingNew(false)
  }

  function handleRename(id: string) {
    const name = editName.trim()
    if (!name) {
      setEditingId(null)
      return
    }
    renameWatchlist(id, name)
    setEditingId(null)
    setEditName('')
  }

  function handleDelete(id: string) {
    deleteWatchlist(id)
    setEditingId(null)
  }

  function handleRemoveTicker(ticker: string) {
    if (!active) return
    removeTicker(active.id, ticker)
  }

  // ------ Empty state ------
  if (lists.length === 0 && !creatingNew) {
    return (
      <div className="mb-5 p-3 bg-gray-50 border border-gray-200 border-dashed rounded-xl">
        <button
          onClick={() => setCreatingNew(true)}
          className="text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
        >
          + Create your first watchlist
        </button>
        {creatingNew && (
          <CreateInput
            ref={newInputRef}
            value={newName}
            onChange={setNewName}
            onSubmit={handleCreate}
            onCancel={() => { setCreatingNew(false); setNewName('') }}
          />
        )}
      </div>
    )
  }

  // ------ Main render ------
  return (
    <div className="mb-5 p-3 bg-amber-50 border border-amber-100 rounded-xl">
      {/* Header row: selector + new button */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-amber-400 text-sm">★</span>

        {/* Watchlist selector dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 rounded-lg transition-colors"
          >
            {active?.name ?? 'Select watchlist'}
            <svg className={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-20 py-1">
              {lists.map((wl) => (
                <div
                  key={wl.id}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs group ${
                    wl.id === active?.id ? 'bg-amber-50' : 'hover:bg-gray-50'
                  }`}
                >
                  {editingId === wl.id ? (
                    <input
                      ref={editInputRef}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(wl.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={() => handleRename(wl.id)}
                      className="flex-1 px-1.5 py-0.5 border border-amber-300 rounded text-xs outline-none focus:ring-1 focus:ring-amber-400"
                    />
                  ) : (
                    <>
                      <button
                        onClick={() => handleSelect(wl)}
                        className="flex-1 text-left font-medium text-gray-800 truncate"
                      >
                        {wl.id === active?.id && (
                          <span className="text-amber-500 mr-1.5">&#10003;</span>
                        )}
                        {wl.name}
                        <span className="ml-1.5 text-gray-400 font-normal">
                          ({wl.tickers.length})
                        </span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingId(wl.id)
                          setEditName(wl.name)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-gray-600 transition-opacity"
                        aria-label="Rename"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(wl.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
                        aria-label="Delete"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* New watchlist button / inline input */}
        {creatingNew ? (
          <CreateInput
            ref={newInputRef}
            value={newName}
            onChange={setNewName}
            onSubmit={handleCreate}
            onCancel={() => { setCreatingNew(false); setNewName('') }}
          />
        ) : (
          <button
            onClick={() => setCreatingNew(true)}
            className="px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 rounded-lg transition-colors"
          >
            + New
          </button>
        )}
      </div>

      {/* Ticker chips for active watchlist */}
      {active && active.tickers.length > 0 && (
        <div className="flex gap-2 flex-wrap mt-2">
          {active.tickers.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 bg-white border border-amber-200 rounded-lg text-xs font-mono font-medium text-amber-800 group">
              <Link
                href={`/stock/${t}`}
                className="hover:underline"
              >
                {t}
              </Link>
              <button
                onClick={() => handleRemoveTicker(t)}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-amber-400 hover:text-red-500 transition-opacity"
                aria-label={`Remove ${t}`}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {active && active.tickers.length === 0 && (
        <p className="text-xs text-amber-600/60 mt-1">
          Star stocks from the table below to add them here.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline create input (reused in empty state & header)
// ---------------------------------------------------------------------------

import { forwardRef } from 'react'

interface CreateInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}

const CreateInput = forwardRef<HTMLInputElement, CreateInputProps>(
  function CreateInput({ value, onChange, onSubmit, onCancel }, ref) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="Watchlist name..."
          className="px-2 py-1 text-xs border border-amber-300 rounded-lg outline-none focus:ring-1 focus:ring-amber-400 w-36"
        />
        <button
          onClick={onSubmit}
          className="px-2 py-1 text-xs font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors"
        >
          Add
        </button>
        <button
          onClick={onCancel}
          className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Cancel
        </button>
      </div>
    )
  }
)
