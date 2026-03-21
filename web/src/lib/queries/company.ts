import { createClient } from '@/lib/supabase/server'
import type { CompanyProfileData, Officer, Shareholder } from '@/lib/types/api'

export async function getCompanyProfile(ticker: string): Promise<CompanyProfileData | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('company_profiles')
    .select('description, website, address, phone, email')
    .eq('ticker', ticker.toUpperCase())
    .single()

  if (error || !data) return null

  return {
    description: (data as any).description ?? null,
    website: (data as any).website ?? null,
    address: (data as any).address ?? null,
    phone: (data as any).phone ?? null,
    email: (data as any).email ?? null,
  }
}

export async function getOfficers(ticker: string): Promise<Officer[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('company_officers')
    .select('name, role, title, is_independent')
    .eq('ticker', ticker.toUpperCase())
    .order('role', { ascending: true })

  if (error) return []

  return ((data as any[]) ?? []).map((r) => ({
    name: r.name,
    role: r.role ?? null,
    title: r.title ?? null,
    is_independent: r.is_independent ?? false,
  }))
}

export async function getShareholders(ticker: string): Promise<Shareholder[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('shareholders')
    .select('holder_name, holder_type, percentage, shares_held')
    .eq('ticker', ticker.toUpperCase())
    .order('percentage', { ascending: false })
    .limit(10)

  if (error) return []

  return ((data as any[]) ?? []).map((r) => ({
    holder_name: r.holder_name,
    holder_type: r.holder_type ?? null,
    percentage: r.percentage != null ? Number(r.percentage) : null,
    shares_held: r.shares_held != null ? Number(r.shares_held) : null,
    report_date: null,
  }))
}

export async function getMajorShareholders(ticker: string): Promise<Shareholder[]> {
  const supabase = await createClient()
  // Use the v_shareholders_major_latest view which returns only the latest snapshot
  const { data, error } = await supabase
    .from('v_shareholders_major_latest')
    .select('holder_name, holder_type, percentage, shares_held, report_date')
    .eq('ticker', ticker.toUpperCase())
    .order('percentage', { ascending: false })

  if (error) return []

  return ((data as any[]) ?? []).map((r) => ({
    holder_name: r.holder_name,
    holder_type: r.holder_type ?? null,
    percentage: r.percentage != null ? Number(r.percentage) : null,
    shares_held: r.shares_held != null ? Number(r.shares_held) : null,
    report_date: r.report_date ?? null,
  }))
}

export async function getMajorShareholderHistory(ticker: string): Promise<Shareholder[][]> {
  const supabase = await createClient()
  // Returns all snapshots grouped by report_date, newest first
  const { data, error } = await supabase
    .from('shareholders_major')
    .select('holder_name, holder_type, percentage, shares_held, report_date')
    .eq('ticker', ticker.toUpperCase())
    .order('report_date', { ascending: false })
    .order('percentage', { ascending: false })

  if (error) return []

  // Group by report_date
  const byDate = new Map<string, Shareholder[]>()
  for (const r of (data as any[]) ?? []) {
    const date = r.report_date as string
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date)!.push({
      holder_name: r.holder_name,
      holder_type: r.holder_type ?? null,
      percentage: r.percentage != null ? Number(r.percentage) : null,
      shares_held: r.shares_held != null ? Number(r.shares_held) : null,
      report_date: date,
    })
  }

  return Array.from(byDate.values())
}
