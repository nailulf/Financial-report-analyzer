'use client'

import { useState } from 'react'

// Locale-independent date formatter — avoids SSR/client hydration mismatch
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function fmtDate(iso: string, long = false): string {
  const [y, m, d] = iso.split('-').map(Number)
  const mon = long
    ? ['January','February','March','April','May','June','July','August','September','October','November','December'][m-1]
    : MONTHS[m-1]
  return d ? `${d} ${mon} ${y}` : `${mon} ${y}`
}
import type { CompanyProfileData, Officer, Shareholder } from '@/lib/types/api'

function roleOrder(role: string | null) {
  if (role === 'director') return 0
  if (role === 'commissioner') return 1
  return 2
}

function holderTypeLabel(type: string | null) {
  switch (type) {
    case 'government': return 'Gov'
    case 'institution': return 'Inst'
    case 'individual': return 'Ind'
    case 'public': return 'Public'
    default: return type ?? '—'
  }
}

function holderTypeBg(type: string | null) {
  switch (type) {
    case 'government': return 'bg-blue-50 text-blue-700'
    case 'institution': return 'bg-purple-50 text-purple-700'
    case 'individual': return 'bg-amber-50 text-amber-700'
    case 'public': return 'bg-[#EDECEA] text-[#6D6C6A]'
    default: return 'bg-[#EDECEA] text-[#6D6C6A]'
  }
}

interface Props {
  profile: CompanyProfileData | null
  officers: Officer[]
  shareholders: Shareholder[]
  shareholderHistory?: Shareholder[][]
}

export function CompanyProfileSection({ profile, officers, shareholders, shareholderHistory = [] }: Props) {
  const hasAnyData = profile || officers.length > 0 || shareholders.length > 0
  if (!hasAnyData) return null

  const sortedOfficers = [...officers].sort((a, b) => roleOrder(a.role) - roleOrder(b.role))

  const historyDates = shareholderHistory.map((snap) => snap[0]?.report_date ?? null).filter(Boolean) as string[]
  const [selectedDateIdx, setSelectedDateIdx] = useState(0)

  const displayedShareholders = shareholderHistory.length > 0
    ? (shareholderHistory[selectedDateIdx] ?? shareholders)
    : shareholders

  const snapshotDate = displayedShareholders[0]?.report_date ?? null

  return (
    <div className="space-y-6">
      {/* Company info */}
      {profile && (profile.description || profile.website || profile.address) && (
        <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
          <h2 className="text-sm font-semibold text-[#1A1918] mb-3">About</h2>
          {profile.description && (
            <p className="text-sm text-[#6D6C6A] leading-relaxed mb-4">{profile.description}</p>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[#6D6C6A]">
            {profile.website && (
              <span>
                <span className="text-[#9C9B99]">Website: </span>
                <a
                  href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#3D8A5A] hover:underline"
                >
                  {profile.website.replace(/^https?:\/\//, '')}
                </a>
              </span>
            )}
            {profile.address && (
              <span><span className="text-[#9C9B99]">Address: </span>{profile.address}</span>
            )}
            {profile.phone && (
              <span><span className="text-[#9C9B99]">Phone: </span>{profile.phone}</span>
            )}
            {profile.email && (
              <span><span className="text-[#9C9B99]">Email: </span>{profile.email}</span>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Officers */}
        {sortedOfficers.length > 0 && (
          <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
            <h2 className="text-sm font-semibold text-[#1A1918] mb-4">Management</h2>
            <div className="space-y-3">
              {sortedOfficers.map((o, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-[#1A1918]">{o.name}</p>
                    <p className="text-xs text-[#9C9B99]">{o.title ?? o.role}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {o.is_independent && (
                      <span className="text-xs px-1.5 py-0.5 bg-[#C8F0D8] text-[#3D8A5A] rounded-md">Ind.</span>
                    )}
                    {o.role && (
                      <span className={`text-xs px-1.5 py-0.5 rounded-md capitalize ${
                        o.role === 'director' ? 'bg-blue-50 text-blue-700' : 'bg-[#EDECEA] text-[#6D6C6A]'
                      }`}>
                        {o.role}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Shareholders */}
        {displayedShareholders.length > 0 && (
          <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-[#1A1918]">Major Shareholders ≥1%</h2>
                {snapshotDate && (
                  <p className="text-xs text-[#9C9B99] mt-0.5">
                    As of {fmtDate(snapshotDate, true)}
                  </p>
                )}
              </div>
              {historyDates.length > 1 && (
                <select
                  value={selectedDateIdx}
                  onChange={(e) => setSelectedDateIdx(Number(e.target.value))}
                  className="text-xs border border-[#E5E4E1] rounded-lg px-2 py-1 text-[#6D6C6A] bg-white focus:outline-none focus:ring-1 focus:ring-[#3D8A5A]"
                >
                  {historyDates.map((d, i) => (
                    <option key={d} value={i}>
                      {fmtDate(d)}{i === 0 ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="space-y-3">
              {displayedShareholders.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-sm text-[#1A1918] truncate">{s.holder_name}</p>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {s.holder_type && (
                          <span className={`text-xs px-1.5 py-0.5 rounded-md ${holderTypeBg(s.holder_type)}`}>
                            {holderTypeLabel(s.holder_type)}
                          </span>
                        )}
                        <span className="text-sm font-semibold font-mono text-[#1A1918] w-14 text-right">
                          {s.percentage != null ? `${s.percentage.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                    </div>
                    {s.percentage != null && (
                      <div className="h-1.5 bg-[#EDECEA] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#3D8A5A] rounded-full transition-all"
                          style={{ width: `${Math.min(s.percentage, 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
