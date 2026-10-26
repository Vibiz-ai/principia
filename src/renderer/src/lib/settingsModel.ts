/**
 * Five doors step 4 (design §2.4): Settings in two scopes. This company: General (name, logo, colour, task prefix,
 * profile), Team & autonomy, Connections, Repositories, Keys & secrets, Danger zone. App: General, AI providers,
 * Notifications, Cloud sync, Storage, Experimental, About. Pure: the section lists, the old section names that still
 * resolve (deep links: Agents → AI providers, Data → Storage), and the task prefix rule.
 */
export type CompanySection = 'company' | 'team' | 'connections' | 'repos' | 'keys' | 'danger'
export type AppSection = 'general' | 'providers' | 'notifications' | 'cloud' | 'phone' | 'storage' | 'experimental' | 'about'
/** Older names kept as aliases (notifications, the app menu, other views): agents → providers, data → storage. */
export type LegacySection = 'agents' | 'data'
export type SettingsSection = CompanySection | AppSection | LegacySection

export interface SectionDef<T extends string> {
  id: T
  label: string
}

/** This company's sections. Personal has no Team & autonomy or Danger zone; Repositories only where there is code. */
export function companySections(o: { personal: boolean; code: boolean }): SectionDef<CompanySection>[] {
  return [
    { id: 'company', label: 'General' },
    ...(o.personal ? [] : [{ id: 'team' as const, label: 'Team & autonomy' }]),
    { id: 'connections', label: 'Connections' },
    ...(o.code || o.personal ? [{ id: 'repos' as const, label: 'Repositories' }] : []),
    { id: 'keys', label: 'Keys & secrets' },
    ...(o.personal ? [] : [{ id: 'danger' as const, label: 'Danger zone' }])
  ]
}
export const APP_SECTIONS: SectionDef<AppSection>[] = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'AI providers' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'cloud', label: 'Cloud sync' },
  { id: 'phone', label: 'Phone' },
  { id: 'storage', label: 'Storage' },
  { id: 'experimental', label: 'Experimental' },
  { id: 'about', label: 'About' }
]
const COMPANY_IDS: ReadonlySet<string> = new Set<CompanySection>(['company', 'team', 'connections', 'repos', 'keys', 'danger'])

/** The section a (possibly old) name opens. */
export function normalizeSection(s: SettingsSection): CompanySection | AppSection {
  return s === 'agents' ? 'providers' : s === 'data' ? 'storage' : s
}
export function isCompanySection(s: SettingsSection): s is CompanySection {
  return COMPANY_IDS.has(s)
}

/**
 * Where Settings opens without a section: inside a company, on its General (name, task prefix: QA round 4, Diego
 * looked for the prefix first); in All companies, on App › General.
 */
export function defaultSettingsSection(inCompany: boolean): CompanySection | AppSection {
  return inCompany ? 'company' : 'general'
}

/** All companies › "Pick a company": the company section the founder asked for (⌘K Keys & secrets opens Keys there). */
export function pickTarget(raw: SettingsSection | undefined): CompanySection {
  const s = raw ? normalizeSection(raw) : null
  return s && isCompanySection(s) ? s : 'company'
}

/**
 * What the founder may open: a company section only inside a company (All companies shows a picker instead, so one
 * client's keys never list next to another's); a section the company doesn't have (Repositories without code) falls
 * back to General.
 */
export function resolveSection(raw: SettingsSection | undefined, o: { inCompany: boolean; personal: boolean; code: boolean }): CompanySection | AppSection | 'pick' {
  const s = normalizeSection(raw ?? defaultSettingsSection(o.inCompany))
  if (!isCompanySection(s)) return s
  if (!o.inCompany) return 'pick'
  return companySections(o).some((x) => x.id === s) ? s : 'company'
}

/** The task prefix rule main enforces (main/company/prefix.ts), said before saving. null = fine. */
export function taskPrefixProblem(raw: string, companyId: string, companies: readonly { id: string; name: string; taskPrefix?: string; system?: string | null }[]): string | null {
  const p = raw.trim().toUpperCase()
  if (!p) return null
  if (!/^[A-Z][A-Z0-9]{1,4}$/.test(p)) return 'Use 2 to 5 letters or digits, starting with a letter.'
  const me = companies.find((c) => c.id === companyId)
  if (p === 'PRN' && me?.system !== 'personal') return 'PRN is Personal’s prefix. Choose another one.'
  const owner = companies.find((c) => c.id !== companyId && c.taskPrefix === p)
  return owner ? `${owner.name} already uses ${p}. Choose another prefix.` : null
}

/** The example in an empty prefix field: this company's own initials (Ledgerly App → LA), never another's. */
export function prefixHint(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const p = words.length > 1 ? words.slice(0, 3).map((w) => w[0]).join('') : (words[0] ?? 'CO').slice(0, 3)
  return /^[A-Z]/.test(p) && p.length >= 2 ? p : 'CO'
}

