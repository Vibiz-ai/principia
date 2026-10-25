/**
 * Five doors §2.5: the sidebar header is "you are here". It names the company you are in and its live state, and opens
 * the company menu (native, like every other menu here): Company settings, Pause/Resume agents, Autopilot, Switch to,
 * New company. It replaces the CompanySwitcher dropdown and the OTHER COMPANIES footer; the rail stays the switcher.
 */
import { DEPARTMENT_PRESETS, type CompanyPassport, type DepartmentPresetKey } from '@shared/company'
import { companyMenuItems } from '../lib/companyMenu'
import { Icon } from '../components/Icon'
import { companyLabel, isCompanyPaused, isPersonal } from '../lib/company'
import { useWorking } from '../state/live'
import { nativeMenu } from '../lib/hive'
import {
  createDepartmentPresets,
  departmentsOn,
  enterCompany,
  getState,
  navigate,
  openNewCompany,
  setCompanyPaused,
  setCompanyAutopilot,
  useStore
} from '../state/store'
import { CompanyAvatar } from './CompanyRail'

export type HeaderState = { kind: 'paused' } | { kind: 'running'; working: number }

/** A4: paused when the company is (company:pause); otherwise running, with the one live source's working count. */
export function headerState(company: Pick<CompanyPassport, 'pausedAt'> | null, working: number): HeaderState {
  if (isCompanyPaused(company)) return { kind: 'paused' }
  return { kind: 'running', working }
}
export function headerLine(st: HeaderState): string {
  if (st.kind === 'paused') return 'Paused'
  return st.working > 0 ? `Running · ${st.working} working` : 'Running'
}

async function companyMenu(company: CompanyPassport | null, paused: boolean): Promise<void> {
  const s = getState()
  const have = new Set(s.departments.filter((d) => d.companyId === company?.id && !d.archivedAt).map((d) => d.key))
  const items = companyMenuItems({
    company,
    companies: s.companies,
    departments: departmentsOn(s),
    seats: company ? s.companyAgents.filter((a) => a.companyId === company.id && !a.archivedAt).length : 0,
    paused,
    missingPresets: DEPARTMENT_PRESETS.filter((p) => !have.has(p.key))
  })
  const id = await nativeMenu(items)
  if (!id) return
  if (id.startsWith('dep:') && company) return void createDepartmentPresets(company.id, [id.slice(4) as DepartmentPresetKey])
  if (id === 'settings' && company) return void navigate({ name: 'settings', section: 'company', companyId: company.id, nonce: Date.now() })
  if ((id === 'pause' || id === 'resume') && company) return void setCompanyPaused(company.id, id === 'pause')
  if (id === 'autopilot' && company) return void setCompanyAutopilot(company.id, !company.autopilot)
  if (id === 'all') return void enterCompany('all')
  if (id === 'new') return openNewCompany()
  if (id.startsWith('co:')) void enterCompany(id.slice(3))
}

/** `company` null = All companies. `flat`: Personal only (no rail), the header names Personal and offers New company. */
export function CompanyHeader({ company, flat = false }: { company: CompanyPassport | null; flat?: boolean }): React.JSX.Element {
  const count = useStore((s) => s.companies.filter((c) => !isPersonal(c)).length)
  const withPersonal = useStore((s) => s.companies.some(isPersonal))
  const working = useWorking(company ? company.id : 'all').count
  const st = company ? headerState(company, working) : { kind: 'running' as const, working }
  const name = company ? companyLabel(company, true) : 'All companies'
  const line = flat ? 'Add a company to give agents a business' : company ? headerLine(st) : `${count} compan${count === 1 ? 'y' : 'ies'}${withPersonal ? ' + Personal' : ''}${st.kind === 'running' && st.working ? ` · ${st.working} working` : ''}`
  return (
    <button
      type="button"
      className={`co-head no-drag ${st.kind === 'paused' ? 'is-paused' : st.working > 0 ? 'is-working' : ''}`}
      aria-haspopup="menu"
      title={`${name}: company menu`}
      onClick={() => void companyMenu(company, st.kind === 'paused')}
    >
      {company ? (
        <CompanyAvatar company={company} size={26} className="co-head__avatar" />
      ) : (
        <span className="co-head__avatar co-head__avatar--all" aria-hidden>
          <Icon name="grid" size={14} />
        </span>
      )}
      <span className="co-head__text">
        <span className="co-head__name">{name}</span>
        <span className="co-head__state">
          {!flat && company && <span className={`co-head__glyph ${st.kind === 'paused' ? 'co-head__glyph--paused' : ''}`} aria-hidden>{st.kind === 'paused' ? '‖' : '●'}</span>}
          {line}
        </span>
      </span>
      <Icon name="chevronDown" size={12} className="co-head__chev" />
    </button>
  )
}
