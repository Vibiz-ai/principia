/**
 * Five doors step 5 (design §2.3, §5 rows 7, 9, 10): Automations → Autopilot, the first tab. One place for what runs
 * by itself in a company (AUTOPILOT.md, Words): the playbooks On autopilot, Auto-start (assigned work starts by itself
 * for agents set to work on their own) and the schedule packs (each creates ordinary schedules, listed under
 * Schedules). In All companies it asks which company: Autopilot belongs to one company, never to all of them.
 */
import { useState } from 'react'
import type { AutopilotId } from '@shared/autopilot'
import type { Id } from '@shared/types'
import { AUTO_START, AUTOPILOT_WHAT } from '@shared/autopilotState'
import { EmptyState } from './ui'
import { AutopilotTiles, runChecklistAction, SocialsSheet } from './home/SetupChecklist'
import { AutopilotSheet } from './home/AutopilotSheet'
import { useCompanySetup } from './home/useCompanySetup'
import { AutopilotSwitch } from '../views/BoardView'
import { RailMark } from '../shell/CompanyRail'
import { PlaybookList } from './autopilot/PlaybookList'
import { AutopilotMark } from './autopilot/AutopilotChip'
import { isPersonal } from '../lib/company'
import { departmentsOn, enterCompany, useStore } from '../state/store'
import { useScope } from './CompanyChip'
import '../styles/automations.css'

export function AutopilotsTab({ focus, nonce }: { focus?: string; nonce?: number } = {}): React.JSX.Element {
  const { scope } = useScope()
  const companies = useStore((s) => s.companies)
  const deptOn = useStore((s) => departmentsOn(s))
  const real = companies.filter((c) => !isPersonal(c) && !c.archivedAt)
  if (!deptOn) return <EmptyState icon="refresh" text="Autopilot runs your departments’ agents. Turn on departments in Settings › Experimental to use it." />
  if (!scope || isPersonal({ id: scope, system: companies.find((c) => c.id === scope)?.system ?? null }))
    return (
      <div className="auto-tab">
        <p className="auto-tab__lede">Autopilot belongs to one company. Pick the company to see what runs by itself there.</p>
        <div className="auto-tab__pick">
          {real.map((c) => (
            <button key={c.id} type="button" className="auto-tab__co" onClick={() => void enterCompany(c.id, { view: { name: 'schedules', tab: 'autopilots', nonce: Date.now() } })}>
              <RailMark company={c} size={24} />
              <span className="auto-tab__co-name">{c.name}</span>
              <span className="auto-tab__co-state">{c.pausedAt ? '‖ Paused' : <AutopilotMark company={c} label />}</span>
            </button>
          ))}
        </div>
      </div>
    )
  return <CompanyAutopilots companyId={scope} focus={focus} nonce={nonce} />
}

function CompanyAutopilots({ companyId, focus, nonce }: { companyId: Id; focus?: string; nonce?: number }): React.JSX.Element {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const setup = useCompanySetup(companyId)
  const [open, setOpen] = useState<AutopilotId | null>(null)
  const [socials, setSocials] = useState(false)
  const handlers = { socials: () => setSocials(true), autopilot: (id: AutopilotId) => setOpen(id) }
  if (!company) return <EmptyState icon="refresh" text="This company is gone." />
  return (
    <div className="auto-tab">
      {/* AUTOPILOT.md §7: what runs on autopilot first, then the company switch under its own plain name */}
      <PlaybookList companyId={companyId} companyName={company.name} focus={focus} nonce={nonce} />
      <div className="ap-section-title">Assigned work</div>
      <section className="auto-tab__switch">
        <div>
          <div className="auto-tab__title">{AUTO_START}</div>
          <p className="auto-tab__lede">{company.pausedAt ? `${company.name} is paused, so nothing starts. Resume it to turn this on.` : `${AUTOPILOT_WHAT} Off: they wait for you to press Start. The playbooks above run on their own schedules either way.`}</p>
        </div>
        <AutopilotSwitch key={company.id} company={company} />
      </section>
      <div className="ap-section-title">Schedule packs</div>
      <AutopilotTiles companyId={companyId} setup={setup} onOpen={(id) => setOpen(id)} />
      <p className="auto-tab__foot">
        Each schedule pack creates ordinary schedules you can edit in <button type="button" className="link-btn" onClick={() => void enterCompany(companyId, { view: { name: 'schedules', tab: 'schedules', nonce: Date.now() } })}>Schedules</button>. They use your Claude plan; Principia charges nothing extra.
      </p>
      {open && setup.ctx && (
        <AutopilotSheet
          id={open}
          setup={setup}
          onClose={() => setOpen(null)}
          onFix={(a) => {
            setOpen(null)
            void runChecklistAction(a, companyId, setup, handlers)
          }}
        />
      )}
      {socials && <SocialsSheet companyId={companyId} socials={setup.socials} onClose={() => setSocials(false)} />}
    </div>
  )
}
