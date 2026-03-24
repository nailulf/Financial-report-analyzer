import type { CompanyProfileData, Officer } from '@/lib/types/api'

function roleOrder(role: string | null): number {
  if (role === 'director')     return 0
  if (role === 'commissioner') return 1
  return 2
}

interface Props {
  profile: CompanyProfileData | null
  officers: Officer[]
}

export function CompanyProfileWidget({ profile, officers }: Props) {
  const hasData = profile || officers.length > 0
  if (!hasData) return null

  const sorted = [...officers].sort((a, b) => roleOrder(a.role) - roleOrder(b.role))

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">PROFIL PERUSAHAAN</span>
      </div>

      <div className="p-5 flex flex-col gap-5">
        {/* About */}
        {profile && (
          <div className="flex flex-col gap-2">
            {profile.description && (
              <p className="font-mono text-[13px] text-[#555555] leading-[1.5]">{profile.description}</p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {profile.website && (
                <span className="font-mono text-[12px]">
                  <span className="text-[#888888]">Situs Web: </span>
                  <a
                    href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#00FF88] hover:underline"
                  >
                    {profile.website.replace(/^https?:\/\//, '')}
                  </a>
                </span>
              )}
              {profile.address && (
                <span className="font-mono text-[12px] text-[#555555]">
                  <span className="text-[#888888]">Alamat: </span>{profile.address}
                </span>
              )}
              {profile.phone && (
                <span className="font-mono text-[12px] text-[#555555]">
                  <span className="text-[#888888]">Telepon: </span>{profile.phone}
                </span>
              )}
              {profile.email && (
                <span className="font-mono text-[12px] text-[#555555]">
                  <span className="text-[#888888]">Email: </span>{profile.email}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Management */}
        {sorted.length > 0 && (
          <div className="flex flex-col gap-3">
            <span className="font-mono text-[12px] font-bold text-[#888888] tracking-[0.5px] uppercase">Manajemen</span>
            <div className="grid grid-cols-2 gap-2">
              {sorted.map((o, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-2 bg-[#F5F5F8] px-3 py-2"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-mono text-[13px] font-semibold text-[#1A1A1A] truncate">{o.name}</span>
                    <span className="font-mono text-[12px] text-[#888888]">{o.title ?? o.role}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {o.is_independent && (
                      <span className="font-mono text-[11px] px-1.5 py-0.5 bg-[#00FF8820] text-[#00FF88] border border-[#00FF8840]">
                        Independen
                      </span>
                    )}
                    {o.role && (
                      <span className={`font-mono text-[11px] px-1.5 py-0.5 capitalize ${
                        o.role === 'director'
                          ? 'bg-blue-50 text-blue-700 border border-blue-200'
                          : 'bg-[#F5F5F8] text-[#888888] border border-[#E0E0E5]'
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
      </div>
    </div>
  )
}
