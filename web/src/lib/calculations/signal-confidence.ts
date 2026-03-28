import { formatIDRCompact } from '@/lib/calculations/formatters'
import type { BandarSignalRow, InsiderTransactionRow, BrokerConcentrationRow } from '@/lib/queries/broker'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConfidenceScore {
  total: number               // 0–100
  label: string               // e.g. "Kuat"
  color: string               // CSS color for the label
  components: {
    brokerMagnitude: number    // 0–25
    foreignAlignment: number   // 0–25
    bandarConfirmation: number // 0–20
    insiderWeight: number      // 0–15
    brokerConcentration: number // 0–15
  }
  explanations: {
    brokerMagnitude: string
    foreignAlignment: string
    bandarConfirmation: string
    insiderWeight: string
    brokerConcentration: string
  }
}

export type SignalPhase = 'akumulasi' | 'distribusi' | 'netral'

export interface ConfidenceInput {
  signal: string                           // e.g. 'STRONG_ACC', 'DISTRIBUTION'
  phase: SignalPhase                       // primary direction from truth table
  netFlow: number
  totalTradingValue: number                // totalBuy + totalSell
  asingNetFlow: number
  lokalNetFlow: number
  pemerintahNetFlow: number
  bandarSignal: BandarSignalRow | null
  insiderTransactions: InsiderTransactionRow[]
  concentration: BrokerConcentrationRow[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type Polarity = 'bullish' | 'bearish' | 'neutral'

function phaseToPolarity(phase: SignalPhase): Polarity {
  if (phase === 'akumulasi') return 'bullish'
  if (phase === 'distribusi') return 'bearish'
  return 'neutral'
}

/** Map Stockbit accdist string to a direction */
function accdistDirection(s: string | null): 'bullish' | 'bearish' | null {
  if (!s) return null
  const lower = s.toLowerCase()
  if (lower.includes('acc')) return 'bullish'
  if (lower.includes('dist')) return 'bearish'
  return null
}

/** Strength of accdist signal: "Big Acc" > "Acc" > "Normal Acc" */
function accdistStrength(s: string | null): 'strong' | 'normal' | 'weak' | null {
  if (!s) return null
  const lower = s.toLowerCase()
  if (lower.startsWith('big')) return 'strong'
  if (lower.startsWith('normal')) return 'weak'
  return 'normal' // "Acc", "Dist" without prefix
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ─── Component Scorers ──────────────────────────────────────────────────────

function scoreBrokerMagnitude(
  netFlow: number,
  totalTradingValue: number,
  phase: SignalPhase,
): { score: number; explanation: string } {
  if (totalTradingValue <= 0) {
    return { score: 5, explanation: 'Total trading value = 0, default score' }
  }

  const ratio = Math.abs(netFlow) / totalTradingValue
  const pct = (ratio * 100).toFixed(1)
  let score: number
  if (ratio >= 0.10) score = 25
  else if (ratio >= 0.05) score = 20
  else if (ratio >= 0.02) score = 15
  else if (ratio >= 0.005) score = 10
  else score = 5

  return {
    score,
    explanation: `Net flow ${formatIDRCompact(netFlow)} = ${pct}% dari total ${formatIDRCompact(totalTradingValue)} → ${score}/25`,
  }
}

function scoreForeignAlignment(
  asingNetFlow: number,
  lokalNetFlow: number,
  pemerintahNetFlow: number,
  phase: SignalPhase,
): { score: number; explanation: string } {
  const polarity = phaseToPolarity(phase)
  const asingBuying = asingNetFlow > 0
  const totalAbsFlow = Math.abs(asingNetFlow) + Math.abs(lokalNetFlow) + Math.abs(pemerintahNetFlow)
  const asingDominance = totalAbsFlow > 0 ? Math.abs(asingNetFlow) / totalAbsFlow : 0
  const dominanceMul = asingDominance > 0.5 ? 1.0 : asingDominance > 0.2 ? 0.8 : 0.6

  let baseScore: number
  let reason: string

  if (polarity === 'neutral') {
    baseScore = 12
    reason = 'Sinyal netral'
  } else if (polarity === 'bullish' && asingBuying) {
    baseScore = 25
    reason = 'Asing net beli, sesuai sinyal bullish'
  } else if (polarity === 'bearish' && !asingBuying && asingNetFlow !== 0) {
    baseScore = 25
    reason = 'Asing net jual, sesuai sinyal bearish'
  } else if (asingNetFlow === 0) {
    baseScore = 10
    reason = 'Tidak ada flow asing'
  } else {
    baseScore = 5
    reason = 'Asing berlawanan arah dengan sinyal'
  }

  const score = Math.round(baseScore * dominanceMul)
  const domPct = (asingDominance * 100).toFixed(0)

  return {
    score: clamp(score, 0, 25),
    explanation: `Asing ${formatIDRCompact(asingNetFlow)} (${domPct}% dominasi): ${reason} → ${clamp(score, 0, 25)}/25`,
  }
}

function scoreBandarConfirmation(
  bandar: BandarSignalRow | null,
  phase: SignalPhase,
): { score: number; explanation: string } {
  if (!bandar) {
    return { score: 8, explanation: 'Tidak ada data bandar signal → default 8/20' }
  }

  const polarity = phaseToPolarity(phase)
  if (polarity === 'neutral') {
    return { score: 10, explanation: 'Sinyal netral → bandar tidak relevan → 10/20' }
  }

  // Score overall accdist (weight 60%)
  const overallDir = accdistDirection(bandar.broker_accdist)
  const overallStr = accdistStrength(bandar.broker_accdist)

  // Score top5 accdist (weight 40%)
  const top5Dir = accdistDirection(bandar.top5_accdist)
  const top5Str = accdistStrength(bandar.top5_accdist)

  function scoreOne(dir: 'bullish' | 'bearish' | null, str: 'strong' | 'normal' | 'weak' | null): number {
    if (dir === null) return 8 // no data
    const aligned = dir === polarity
    if (aligned) {
      if (str === 'strong') return 20
      if (str === 'normal') return 15
      return 10 // weak
    }
    // contradicts
    if (str === 'strong') return 2
    if (str === 'normal') return 5
    return 7 // weak contradiction
  }

  const overallScore = scoreOne(overallDir, overallStr)
  const top5Score = scoreOne(top5Dir, top5Str)
  const blended = Math.round(overallScore * 0.6 + top5Score * 0.4)

  const overallLabel = bandar.broker_accdist ?? '—'
  const top5Label = bandar.top5_accdist ?? '—'

  return {
    score: clamp(blended, 0, 20),
    explanation: `Overall "${overallLabel}" (${overallScore}/20) + Top5 "${top5Label}" (${top5Score}/20) → ${blended}/20`,
  }
}

function scoreInsiderWeight(
  insiders: InsiderTransactionRow[],
  phase: SignalPhase,
): { score: number; explanation: string } {
  if (insiders.length === 0) {
    return { score: 5, explanation: 'Tidak ada insider filing → default 5/15' }
  }

  const polarity = phaseToPolarity(phase)

  // Sum buy/sell values
  let buyValue = 0
  let sellValue = 0
  let maxOwnershipChange = 0
  for (const t of insiders) {
    const val = Math.abs(t.total_value ?? 0)
    if (t.action === 'BUY') buyValue += val
    else sellValue += val
    if (t.ownership_change_pct != null) {
      maxOwnershipChange = Math.max(maxOwnershipChange, Math.abs(t.ownership_change_pct))
    }
  }

  const insiderNetValue = buyValue - sellValue
  const maxValue = Math.max(buyValue, sellValue)

  // Does insider direction align with signal?
  const insiderBullish = insiderNetValue > 0
  const aligned =
    polarity === 'neutral' ? true
    : polarity === 'bullish' ? insiderBullish
    : !insiderBullish // bearish signal + net sell = aligned

  let score: number
  if (!aligned) {
    score = 2
  } else if (maxValue >= 10_000_000_000) { // ≥10B
    score = 15
  } else if (maxValue >= 1_000_000_000) { // ≥1B
    score = 12
  } else if (maxValue >= 100_000_000) { // ≥100M
    score = 9
  } else {
    score = 6
  }

  // Bonus for material ownership change
  if (aligned && maxOwnershipChange > 1) {
    score = Math.min(15, score + 2)
  }

  const direction = insiderNetValue >= 0 ? 'net beli' : 'net jual'
  const alignLabel = aligned ? 'sesuai' : 'berlawanan'

  return {
    score: clamp(score, 0, 15),
    explanation: `Insider ${direction} ${formatIDRCompact(maxValue)} (${alignLabel} sinyal)${maxOwnershipChange > 1 ? `, ownership Δ${maxOwnershipChange.toFixed(1)}%` : ''} → ${clamp(score, 0, 15)}/15`,
  }
}

function scoreBrokerConcentration(
  concentration: BrokerConcentrationRow[],
  phase: SignalPhase,
): { score: number; explanation: string } {
  if (concentration.length === 0) {
    return { score: 5, explanation: 'Tidak ada data konsentrasi → default 5/15' }
  }

  const polarity = phaseToPolarity(phase)

  // Top 3 non-platform by absolute net value
  const sorted = [...concentration]
    .filter((r) => !r.is_platform)
    .sort((a, b) => Math.abs(b.total_net_value) - Math.abs(a.total_net_value))
  const top3 = sorted.slice(0, 3)
  const top3Concentration = top3.reduce((s, r) => s + r.concentration_pct, 0)
  const top3NetValue = top3.reduce((s, r) => s + r.total_net_value, 0)
  const top3Bullish = top3NetValue > 0

  const aligned =
    polarity === 'neutral' ? true
    : polarity === 'bullish' ? top3Bullish
    : !top3Bullish

  let score: number
  if (!aligned) {
    score = 3
  } else if (top3Concentration >= 30) {
    score = 15
  } else if (top3Concentration >= 20) {
    score = 12
  } else if (top3Concentration >= 10) {
    score = 9
  } else {
    score = 5
  }

  // Tier bonus (replaces old flat +2 for kandidat_bandar)
  const bestTier = top3.reduce<string | null>((best, r) => {
    if (!r.tier) return best
    if (!best) return r.tier
    const order: Record<string, number> = { A: 3, A2: 2, B: 1 }
    return (order[r.tier] ?? 0) > (order[best] ?? 0) ? r.tier : best
  }, null)
  if (aligned && bestTier === 'A') score = Math.min(15, score + 3)
  else if (aligned && bestTier === 'A2') score = Math.min(15, score + 2)
  else if (aligned && bestTier === 'B') score = Math.min(15, score + 1)

  // Specificity bonus
  const hasSpecific = top3.some((r) => r.specificity_label === 'SPECIFIC')
  const hasElevated = top3.some((r) => r.specificity_label === 'ELEVATED')
  if (aligned && hasSpecific) score = Math.min(15, score + 2)
  else if (aligned && hasElevated) score = Math.min(15, score + 1)

  // Asing bonus
  const hasAsing = top3.some((r) => r.status === 'asing')
  if (aligned && hasAsing) score = Math.min(15, score + 1)

  // Counter-retail bonus
  const hasCR = top3.some((r) => r.counter_retail)
  if (aligned && hasCR) score = Math.min(15, score + 1)

  const direction = top3Bullish ? 'net beli' : 'net jual'
  const alignLabel = aligned ? 'sesuai' : 'berlawanan'
  const extras = [
    bestTier && `tier-${bestTier}`,
    hasSpecific && 'spesifik',
    hasElevated && !hasSpecific && 'elevated',
    hasAsing && 'asing',
    hasCR && 'counter-retail',
  ].filter(Boolean).join('+')

  return {
    score: clamp(score, 0, 15),
    explanation: `Top3 ${top3Concentration.toFixed(0)}% konsentrasi, ${direction} (${alignLabel})${extras ? ` [${extras}]` : ''} → ${clamp(score, 0, 15)}/15`,
  }
}

// ─── Main Scorer ────────────────────────────────────────────────────────────

const STRENGTH_LABELS: Array<{ min: number; label: string; color: string }> = [
  { min: 80, label: 'Sangat Kuat', color: '#006633' },
  { min: 60, label: 'Kuat',        color: '#155724' },
  { min: 40, label: 'Sedang',      color: '#856404' },
  { min: 20, label: 'Lemah',       color: '#CC6600' },
  { min: 0,  label: 'Sangat Lemah', color: '#721C24' },
]

export function computeConfidence(input: ConfidenceInput): ConfidenceScore {
  const { phase, netFlow, totalTradingValue, asingNetFlow, lokalNetFlow, pemerintahNetFlow, bandarSignal, insiderTransactions, concentration } = input

  const bm = scoreBrokerMagnitude(netFlow, totalTradingValue, phase)
  const fa = scoreForeignAlignment(asingNetFlow, lokalNetFlow, pemerintahNetFlow, phase)
  const bc = scoreBandarConfirmation(bandarSignal, phase)
  const iw = scoreInsiderWeight(insiderTransactions, phase)
  const bk = scoreBrokerConcentration(concentration, phase)

  const total = bm.score + fa.score + bc.score + iw.score + bk.score
  const { label, color } = STRENGTH_LABELS.find((s) => total >= s.min) ?? STRENGTH_LABELS[STRENGTH_LABELS.length - 1]

  return {
    total,
    label,
    color,
    components: {
      brokerMagnitude: bm.score,
      foreignAlignment: fa.score,
      bandarConfirmation: bc.score,
      insiderWeight: iw.score,
      brokerConcentration: bk.score,
    },
    explanations: {
      brokerMagnitude: bm.explanation,
      foreignAlignment: fa.explanation,
      bandarConfirmation: bc.explanation,
      insiderWeight: iw.explanation,
      brokerConcentration: bk.explanation,
    },
  }
}


// ─── Narrative Generator (pattern-based) ────────────────────────────────────

export interface Narrative {
  conclusion: string   // short — shown on the summary card
  detail: string       // full — shown in the tooltip
}

type ActorDir = 'beli' | 'jual' | 'netral'

function dir(v: number): ActorDir { return v > 0 ? 'beli' : v < 0 ? 'jual' : 'netral' }

function fmtActor(label: string, v: number): string {
  return `${label} ${formatIDRCompact(v)}`
}

// ─── Bandar context extraction ──────────────────────────────────────────────

interface BandarContext {
  accumulators: Array<{ code: string; name: string; conc: number; spec: number; cr: boolean }>
  distributors: Array<{ code: string; name: string; conc: number; spec: number; cr: boolean }>
  hasStrong: boolean       // at least one SPECIFIC + tier A/A2
  hasMixed: boolean        // both accumulators and distributors present
  summary: string          // short sentence for conclusion
  detail: string           // full sentence for tooltip
}

function extractBandarContext(concentration: BrokerConcentrationRow[]): BandarContext {
  const candidates = concentration.filter(
    (r) => r.status === 'kandidat_bandar' && r.tier !== null,
  )

  const accumulators = candidates
    .filter((r) => r.net_direction === 'BUY')
    .map((r) => ({ code: r.broker_code, name: r.broker_name ?? r.broker_code, conc: r.concentration_pct, spec: r.specificity ?? 0, cr: r.counter_retail }))

  const distributors = candidates
    .filter((r) => r.net_direction === 'SELL')
    .map((r) => ({ code: r.broker_code, name: r.broker_name ?? r.broker_code, conc: r.concentration_pct, spec: r.specificity ?? 0, cr: r.counter_retail }))

  const hasStrong = candidates.some(
    (r) => (r.tier === 'A' || r.tier === 'A2') && r.specificity_label === 'SPECIFIC',
  )
  const hasMixed = accumulators.length > 0 && distributors.length > 0

  // Build summary (short, for conclusion suffix)
  let summary = ''
  if (accumulators.length > 0 && distributors.length === 0) {
    const top = accumulators[0]
    summary = `Bandar ${top.name} akumulasi${top.cr ? ' (counter-retail)' : ''}`
  } else if (distributors.length > 0 && accumulators.length === 0) {
    const top = distributors[0]
    summary = `Bandar ${top.name} distribusi${top.cr ? ' (counter-retail)' : ''}`
  } else if (hasMixed) {
    summary = `Bandar campuran: ${accumulators[0].name} akumulasi, ${distributors[0].name} distribusi`
  }

  // Build detail (full, for tooltip)
  const parts: string[] = []
  for (const a of accumulators) {
    parts.push(`${a.code} (${a.name}) akumulasi ${a.conc.toFixed(1)}% konsentrasi, spesifisitas ${a.spec.toFixed(1)}x${a.cr ? ', counter-retail' : ''}`)
  }
  for (const d of distributors) {
    parts.push(`${d.code} (${d.name}) distribusi ${d.conc.toFixed(1)}% konsentrasi, spesifisitas ${d.spec.toFixed(1)}x${d.cr ? ', counter-retail' : ''}`)
  }
  const detail = parts.length > 0 ? ` Bandar: ${parts.join('; ')}.` : ''

  return { accumulators, distributors, hasStrong, hasMixed, summary, detail }
}

// ─── Narrative Generator (pattern-based + bandar context) ────────────────────

/**
 * Rule-based narrative that detects money-flow patterns and describes
 * what is actually happening — enriched with bandar detection context.
 */
export function generateNarrative(input: ConfidenceInput): Narrative {
  const { asingNetFlow: asing, lokalNetFlow: lokal, pemerintahNetFlow: bumn, netFlow, totalTradingValue, insiderTransactions, concentration } = input

  const aDir = dir(asing)
  const lDir = dir(lokal)
  const bDir = dir(bumn)

  // Magnitude check — is net flow meaningful?
  const flowRatio = totalTradingValue > 0 ? Math.abs(netFlow) / totalTradingValue : 0
  const isNoise = flowRatio < 0.005 // < 0.5% of total volume

  // Dominant actor = largest absolute flow
  const absAsing = Math.abs(asing)
  const absLokal = Math.abs(lokal)
  const absBumn = Math.abs(bumn)

  // Who is buying / selling
  const buyers: string[] = []
  const sellers: string[] = []
  if (aDir === 'beli') buyers.push(fmtActor('asing', asing))
  if (aDir === 'jual') sellers.push(fmtActor('asing', asing))
  if (lDir === 'beli') buyers.push(fmtActor('retail', lokal))
  if (lDir === 'jual') sellers.push(fmtActor('retail', lokal))
  if (bDir === 'beli') buyers.push(fmtActor('BUMN', bumn))
  if (bDir === 'jual') sellers.push(fmtActor('BUMN', bumn))

  // Insider summary
  const insiderBuys = insiderTransactions.filter((t) => t.action === 'BUY').length
  const insiderSells = insiderTransactions.filter((t) => t.action === 'SELL').length
  const insiderSuffix = insiderBuys > 0 || insiderSells > 0
    ? ` Insider: ${[insiderBuys > 0 && `${insiderBuys} BUY`, insiderSells > 0 && `${insiderSells} SELL`].filter(Boolean).join(', ')}.`
    : ''

  // Bandar context
  const bandar = extractBandarContext(concentration)

  // Helper: build { conclusion, detail } with bandar enrichment
  // - If bandar is strong and aligned → override conclusion
  // - If bandar is mixed → append context
  // - Always append bandar detail to tooltip
  const mk = (baseConclusion: string, baseDetail: string): Narrative => {
    let conclusion = baseConclusion
    const detail = baseDetail + bandar.detail + insiderSuffix

    if (bandar.hasStrong && !bandar.hasMixed && bandar.summary) {
      // Strong unidirectional bandar → prepend to conclusion
      conclusion = `${bandar.summary} — ${baseConclusion.charAt(0).toLowerCase()}${baseConclusion.slice(1)}`
    } else if (bandar.summary && !bandar.hasMixed) {
      // Weaker bandar but still present → append
      conclusion = `${baseConclusion}. ${bandar.summary}`
    } else if (bandar.hasMixed) {
      // Mixed bandar → append as context
      conclusion = `${baseConclusion}. ${bandar.summary}`
    }

    return { conclusion, detail }
  }

  // ── Pattern detection (ordered by specificity) ──

  // All actors neutral — but check if bandar is active
  if (aDir === 'netral' && lDir === 'netral' && bDir === 'netral') {
    if (bandar.hasStrong && bandar.accumulators.length > 0) {
      return mk('Pasar sepi, tapi bandar aktif akumulasi', 'Semua aktor netral, namun terdeteksi bandar spesifik sedang mengumpulkan barang.')
    }
    if (bandar.hasStrong && bandar.distributors.length > 0) {
      return mk('Pasar sepi, tapi bandar aktif distribusi', 'Semua aktor netral, namun terdeteksi bandar spesifik sedang melepas barang.')
    }
    return mk('Tidak ada pergerakan signifikan', 'Semua aktor netral — pasar sepi.')
  }

  // All aligned accumulation
  if (aDir === 'beli' && lDir === 'beli' && bDir === 'beli') {
    return mk('Semua aktor selaras masuk', `Asing ${formatIDRCompact(asing)}, retail ${formatIDRCompact(lokal)}, BUMN ${formatIDRCompact(bumn)} — akumulasi selaras.`)
  }

  // All aligned distribution
  if (aDir === 'jual' && lDir === 'jual' && bDir === 'jual') {
    return mk('Semua aktor selaras keluar', `Asing ${formatIDRCompact(asing)}, retail ${formatIDRCompact(lokal)}, BUMN ${formatIDRCompact(bumn)} — distribusi selaras.`)
  }

  // Foreign exit absorbed by domestic (PTRO pattern)
  if (aDir === 'jual' && (lDir === 'beli' || bDir === 'beli') && isNoise) {
    const absorbers = [lDir === 'beli' && fmtActor('retail', lokal), bDir === 'beli' && fmtActor('BUMN', bumn)].filter(Boolean).join(' & ')
    return mk(
      'Perpindahan kepemilikan, bukan distribusi',
      `Asing keluar ${formatIDRCompact(asing)}, diserap oleh ${absorbers}. Net flow kecil (${(flowRatio * 100).toFixed(1)}%) — saham berpindah dari asing ke domestik.`,
    )
  }

  // Genuine distribution: asing + institutions selling, retail catching
  if (aDir === 'jual' && bDir === 'jual' && lDir === 'beli') {
    return mk(
      'Potensi distribusi ke retail',
      `Asing ${formatIDRCompact(asing)} dan BUMN ${formatIDRCompact(bumn)} keluar, retail ${formatIDRCompact(lokal)} menampung.`,
    )
  }

  // Smart money accumulation: asing + BUMN buying, retail selling
  if (aDir === 'beli' && bDir === 'beli' && lDir === 'jual') {
    return mk(
      'Smart money masuk',
      `Asing ${formatIDRCompact(asing)} dan BUMN ${formatIDRCompact(bumn)} akumulasi, retail ${formatIDRCompact(lokal)} keluar.`,
    )
  }

  // Foreign-driven accumulation
  if (aDir === 'beli' && absAsing > absLokal && absAsing > absBumn) {
    const resistors = sellers.length > 0 ? ` ${sellers.join(' & ')} keluar.` : '.'
    return mk(
      'Foreign smart money masuk',
      `Asing mendominasi akumulasi ${formatIDRCompact(asing)},${resistors}`,
    )
  }

  // Foreign-driven distribution, domestic absorbing
  if (aDir === 'jual' && absAsing > absLokal && absAsing > absBumn && buyers.length > 0) {
    return mk(
      'Waspada jika tekanan asing berlanjut',
      `Asing mendominasi distribusi ${formatIDRCompact(asing)}, ${buyers.join(' & ')} menampung.`,
    )
  }

  // Foreign-driven distribution, nobody absorbing
  if (aDir === 'jual' && absAsing > absLokal && absAsing > absBumn) {
    return mk(
      'Tekanan jual asing dominan',
      `Asing mendominasi distribusi ${formatIDRCompact(asing)}, belum ada penyerap signifikan.`,
    )
  }

  // Retail-driven accumulation
  if (lDir === 'beli' && absLokal > absAsing && absLokal > absBumn) {
    const conclusion = aDir === 'jual' ? 'Retail masuk, perlu konfirmasi smart money' : 'Retail masuk, belum didukung asing'
    const note = aDir === 'jual' ? ` Asing berlawanan arah ${formatIDRCompact(asing)}.` : ''
    return mk(conclusion, `Retail mendominasi akumulasi ${formatIDRCompact(lokal)}.${note}`)
  }

  // Retail-driven distribution
  if (lDir === 'jual' && absLokal > absAsing && absLokal > absBumn) {
    const conclusion = aDir === 'beli' ? 'Potensi akumulasi smart money' : 'Retail keluar'
    const note = aDir === 'beli' ? ` Asing berlawanan arah ${formatIDRCompact(asing)}.` : ''
    return mk(conclusion, `Retail mendominasi distribusi ${formatIDRCompact(lokal)}.${note}`)
  }

  // Generic conflict: some buying, some selling
  if (buyers.length > 0 && sellers.length > 0) {
    return mk('Belum ada konsensus arah', `${buyers.join(' & ')} masuk, ${sellers.join(' & ')} keluar.`)
  }

  // Fallback
  const all = [...buyers, ...sellers]
  return mk(all.length > 0 ? 'Arus campuran' : 'Tidak ada data', `${all.join(', ')}.`)
}
