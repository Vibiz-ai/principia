/**
 * Focused-mode portfolio bits (COMPANY.md §8.4): the company switcher in the sidebar's title area, and the slim
 * "Other companies" strip above Settings. Together with the rail, every company stays visible while focused.
 */
import { useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import type { NativeMenuItem } from '@shared/ipc'
import { Icon } from '../components/Icon'
import { companyLabel, useCompanyBadges, type CompanyBadge } from '../lib/company'
import { nativeMenu } from '../lib/hive'
import { enterCompany, getState, loadJson, openNewCompany, saveJson, useStore } from '../state/store'
import { CompanyAvatar, CompanyBadgeMark } from './CompanyRail'

function badgeSuffix(b: CompanyBadge | undefined): string {
  if (!b) return ''
  if (b.needsYou) return `  ⚑ ${b.needsYou}`
  if (b.working) return '  ●'
  return ''
}

/** The native switcher menu: companies with badges, All companies, New company…. Also the fallback when the rail is hidden. */
export async function companySwitcherMenu(byCompany: Record<string, CompanyBadge>): Promise<void> {
  const s = getState()
  const items: NativeMenuItem[] = [
    ...s.companies.map<NativeMenuItem>((c, i) => ({ id: `co:${c.id}`, type: 'checkbox', label: `${companyLabel(c, true)}${badgeSuffix(byCompany[c.id])}`, checked: s.activeCompanyId === c.id, accelerator: i < 9 ? `Ctrl+${i + 1}` : undefined })),
    { type: 'separator' },
    { id: 'all', type: 'checkbox', label: 'All companies', checked: s.activeCompanyId === 'all', accelerator: 'Ctrl+0' },
    { type: 'separator' },
    { id: 'new', label: 'New company…' }
  ]
  const id = await nativeMenu(items)
  if (!id) return
  if (id === 'all') return void enterCompany('all')
  if (id === 'new') return openNewCompany()
  if (id.startsWith('co:')) void enterCompany(id.slice(3))
}

export function CompanySwitcher({ company }: { company: CompanyPassport }): React.JSX.Element {
  const { byCompany } = useCompanyBadges()
  return (
    <button type="button" className="co-switcher no-drag" title="Switch company (⇧⌘O)" aria-haspopup="menu" onClick={() => void companySwitcherMenu(byCompany)}>
      <CompanyAvatar company={company} size={20} />
      <span className="co-switcher__name">{companyLabel(company, true)}</span>
      <Icon name="chevronDown" size={12} />
    </button>
  )
}

export function OtherCompanies({ activeId }: { activeId: string }): React.JSX.Element | null {
  const companies = useStore((s) => s.companies)
  const { byCompany } = useCompanyBadges()
  const [open, setOpen] = useState<boolean>(() => loadJson('hive.otherCompaniesOpen', true))
  const others = companies.filter((c) => c.id !== activeId)
  if (!others.length) return null
  const needs = others.reduce((n, c) => n + (byCompany[c.id]?.needsYou ?? 0), 0)
  const toggle = (): void => {
    setOpen(!open)
    saveJson('hive.otherCompaniesOpen', !open)
  }
  return (
    <div className="co-others" aria-label="Other companies">
      <button type="button" className="co-others__head" aria-expanded={open} onClick={toggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        <span>Other companies</span>
        {!open && needs > 0 && <span className="side-row__badge side-row__badge--needs">⚑ {needs}</span>}
      </button>
      {open &&
        others.map((c) => (
          <div
            key={c.id}
            className="side-row co-others__row"
            role="button"
            tabIndex={0}
            title={`Enter ${companyLabel(c, true)}`}
            onClick={() => void enterCompany(c.id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void enterCompany(c.id))}
          >
            <CompanyAvatar company={c} size={16} />
            <span className="side-row__label">{companyLabel(c, true)}</span>
            <CompanyBadgeMark badge={byCompany[c.id]} />
          </div>
        ))}
    </div>
  )
}
