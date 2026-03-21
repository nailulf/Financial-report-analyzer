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
    case 'public': return 'bg-gray-100 text-gray-600'
    default: return 'bg-gray-100 text-gray-600'
  }
}

interface Props {
  profile: CompanyProfileData | null
  officers: Officer[]
  shareholders: Shareholder[]
}

export function CompanyProfileSection({ profile, officers, shareholders }: Props) {
  const hasAnyData = profile || officers.length > 0 || shareholders.length > 0
  if (!hasAnyData) return null

  const sortedOfficers = [...officers].sort((a, b) => roleOrder(a.role) - roleOrder(b.role))

  return (
    <div className="space-y-6">
      {/* Company info */}
      {profile && (profile.description || profile.website || profile.address) && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">About</h2>
          {profile.description && (
            <p className="text-sm text-gray-600 leading-relaxed mb-4">{profile.description}</p>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
            {profile.website && (
              <span>
                <span className="text-gray-400">Website: </span>
                <a
                  href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {profile.website.replace(/^https?:\/\//, '')}
                </a>
              </span>
            )}
            {profile.address && (
              <span><span className="text-gray-400">Address: </span>{profile.address}</span>
            )}
            {profile.phone && (
              <span><span className="text-gray-400">Phone: </span>{profile.phone}</span>
            )}
            {profile.email && (
              <span><span className="text-gray-400">Email: </span>{profile.email}</span>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Officers */}
        {sortedOfficers.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Management</h2>
            <div className="space-y-3">
              {sortedOfficers.map((o, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{o.name}</p>
                    <p className="text-xs text-gray-500">{o.title ?? o.role}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {o.is_independent && (
                      <span className="text-xs px-1.5 py-0.5 bg-green-50 text-green-700 rounded">Ind.</span>
                    )}
                    {o.role && (
                      <span className={`text-xs px-1.5 py-0.5 rounded capitalize ${
                        o.role === 'director' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
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
        {shareholders.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Major Shareholders</h2>
            <div className="space-y-3">
              {shareholders.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-sm text-gray-800 truncate">{s.holder_name}</p>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {s.holder_type && (
                          <span className={`text-xs px-1.5 py-0.5 rounded ${holderTypeBg(s.holder_type)}`}>
                            {holderTypeLabel(s.holder_type)}
                          </span>
                        )}
                        <span className="text-sm font-medium text-gray-700 w-12 text-right">
                          {s.percentage != null ? `${s.percentage.toFixed(2)}%` : '—'}
                        </span>
                      </div>
                    </div>
                    {s.percentage != null && (
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full"
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
