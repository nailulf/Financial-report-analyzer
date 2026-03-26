'use client'

import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: number
  message: string
  detail?: string
  variant: ToastVariant
  duration: number  // ms, 0 = sticky
}

interface ToastContextValue {
  addToast: (opts: Omit<Toast, 'id'>) => number
  removeToast: (id: number) => void
}

// ── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

// ── Styling ──────────────────────────────────────────────────────────────────

const VARIANT_STYLES: Record<ToastVariant, { bg: string; border: string; icon: string; iconColor: string }> = {
  success: { bg: 'bg-white',   border: 'border-[#3D8A5A]', icon: '✓', iconColor: 'text-[#3D8A5A] bg-[#C8F0D8]' },
  error:   { bg: 'bg-white',   border: 'border-red-400',    icon: '✗', iconColor: 'text-red-500 bg-red-50' },
  warning: { bg: 'bg-white',   border: 'border-amber-400',  icon: '⚠', iconColor: 'text-amber-600 bg-amber-50' },
  info:    { bg: 'bg-white',   border: 'border-[#5B8DEF]',  icon: 'ℹ', iconColor: 'text-[#5B8DEF] bg-blue-50' },
}

// ── Toast Item ───────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [exiting, setExiting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (toast.duration > 0) {
      timerRef.current = setTimeout(() => {
        setExiting(true)
        setTimeout(onDismiss, 200)
      }, toast.duration)
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [toast.duration, onDismiss])

  const s = VARIANT_STYLES[toast.variant]

  return (
    <div
      className={`${s.bg} border ${s.border} rounded-lg shadow-lg px-4 py-3 flex items-start gap-3 max-w-sm transition-all duration-200 ${
        exiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'
      }`}
    >
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0 ${s.iconColor}`}>
        {s.icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-[#1A1918]">{toast.message}</p>
        {toast.detail && <p className="text-[10px] text-[#9C9B99] mt-0.5">{toast.detail}</p>}
      </div>
      <button
        onClick={() => { setExiting(true); setTimeout(onDismiss, 200) }}
        className="text-[#9C9B99] hover:text-[#6D6C6A] text-sm leading-none shrink-0"
      >
        ×
      </button>
    </div>
  )
}

// ── Provider ─────────────────────────────────────────────────────────────────

let _nextId = 1

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((opts: Omit<Toast, 'id'>) => {
    const id = _nextId++
    setToasts((prev) => [...prev, { ...opts, id }])
    return id
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* Toast container — bottom-right fixed */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
