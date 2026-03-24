// Static alternative data sources shown when a completeness category scores 0.
// Each entry provides a human-readable label, short instruction, and a URL.

interface AltSource {
  label: string
  instruction: string
  url: string
}

// Map from completeness category key → list of alternative sources
const ALT_SOURCES: Record<string, AltSource[]> = {
  price_history: [
    {
      label: 'Stooq Historical Data',
      instruction: 'Search ticker + ".JK" for IDX price history CSV',
      url: 'https://stooq.com/q/d/?s={TICKER}.jk',
    },
    {
      label: 'Yahoo Finance',
      instruction: 'Download historical prices directly from Yahoo Finance',
      url: 'https://finance.yahoo.com/quote/{TICKER}.JK/history/',
    },
  ],
  annual_coverage: [
    {
      label: 'IDX e-Reporting (XBRL)',
      instruction: 'Official XBRL financial statements from IDX — search by ticker and year',
      url: 'https://e-reporting.idx.co.id/',
    },
    {
      label: 'IDX Financial Statements',
      instruction: 'Laporan keuangan tahunan — filter by emiten and year',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan/',
    },
  ],
  annual_quality: [
    {
      label: 'IDX e-Reporting (XBRL)',
      instruction: 'Check if core fields (revenue, net income, assets) are reported in XBRL',
      url: 'https://e-reporting.idx.co.id/',
    },
  ],
  quarterly_financials: [
    {
      label: 'IDX Quarterly Reports',
      instruction: 'Laporan keuangan interim per kuartal — search by ticker and period',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan/',
    },
    {
      label: 'IDX e-Reporting',
      instruction: 'Quarterly XBRL filings available for most IDX-listed companies',
      url: 'https://e-reporting.idx.co.id/',
    },
  ],
  quarterly_reports: [
    {
      label: 'IDX Financial Report Page',
      instruction: 'Download quarterly report PDFs — search "laporan keuangan" by ticker',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan/',
    },
  ],
  annual_reports: [
    {
      label: 'IDX Annual Report Page',
      instruction: 'Download laporan tahunan (annual report) PDFs from IDX',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan/',
    },
  ],
  company_profile: [
    {
      label: 'IDX Company Directory',
      instruction: 'Official company profile page on IDX — includes address, website, description',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/daftar-perusahaan-tercatat/',
    },
  ],
  board_commissioners: [
    {
      label: 'IDX Company Profile',
      instruction: 'Board of directors and commissioners listed on IDX company page',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/daftar-perusahaan-tercatat/',
    },
    {
      label: 'Annual Report PDF',
      instruction: 'Directors and commissioners are listed in the annual report',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan/',
    },
  ],
  shareholders: [
    {
      label: 'KSEI Investor Area',
      instruction: 'Shareholder registry data from Kustodian Sentral Efek Indonesia',
      url: 'https://www.ksei.co.id/data-dan-statistik',
    },
    {
      label: 'Annual Report PDF',
      instruction: 'Shareholder composition (>5%) is disclosed in the annual report',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/laporan-keuangan-dan-tahunan/',
    },
  ],
  corporate_events: [
    {
      label: 'IDX Keterbukaan Informasi',
      instruction: 'Public expose and RUPS announcements — filter by emiten code',
      url: 'https://www.idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/',
    },
    {
      label: 'IDX Public Expose',
      instruction: 'Public expose event archive from IDX',
      url: 'https://www.idx.co.id/id/berita/public-expose/',
    },
  ],
  derived_metrics: [
    {
      label: 'RTI Business',
      instruction: 'Key financial ratios (P/E, P/BV, ROE) available on RTI Business',
      url: 'https://www.rtiinves.com/research/fundamental/',
    },
    {
      label: 'Stockbit',
      instruction: 'Comprehensive ratio breakdown and financial statements for IDX stocks',
      url: 'https://stockbit.com/#/symbol/{TICKER}',
    },
  ],
}

interface AlternativeSourcesProps {
  missingCategories: string[]
  ticker: string
}

export function AlternativeSources({ missingCategories, ticker }: AlternativeSourcesProps) {
  // Only show categories that have alternatives defined
  const relevant = missingCategories.filter((cat) => ALT_SOURCES[cat]?.length)
  if (!relevant.length) return null

  return (
    <div className="border-t border-[#E5E4E1] px-5 py-4">
      <p className="text-xs font-semibold text-[#9C9B99] uppercase tracking-wide mb-3">
        Alternative Sources
        <span className="ml-1.5 font-normal text-[#9C9B99] normal-case">
          — for categories with no data
        </span>
      </p>
      <div className="space-y-4">
        {relevant.map((cat) => {
          const sources = ALT_SOURCES[cat]
          const catLabel = CAT_LABELS[cat] ?? cat
          return (
            <div key={cat}>
              <p className="text-xs font-medium text-[#6D6C6A] mb-1.5">{catLabel}</p>
              <div className="space-y-1.5">
                {sources.map((src) => {
                  const url = src.url.replace('{TICKER}', ticker)
                  return (
                    <div key={src.label} className="flex items-start gap-2 text-xs">
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#3D8A5A] hover:text-[#2d6b45] hover:underline font-medium shrink-0"
                      >
                        {src.label} ↗
                      </a>
                      <span className="text-[#9C9B99]">{src.instruction}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const CAT_LABELS: Record<string, string> = {
  price_history:        'Price History',
  annual_coverage:      'Annual Financials Coverage',
  annual_quality:       'Annual Financials Quality',
  quarterly_financials: 'Quarterly Financials',
  quarterly_reports:    'Quarterly Report PDFs',
  annual_reports:       'Annual Report PDFs',
  company_profile:      'Company Profile',
  board_commissioners:  'Board & Commissioners',
  shareholders:         'Shareholders ≥1%',
  corporate_events:     'Corporate Events',
  derived_metrics:      'Derived Metrics',
}
