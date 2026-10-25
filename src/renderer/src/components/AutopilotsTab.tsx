/**
 * Five doors step 5 (design §2.3, §5 rows 7, 9, 10): Automations → Autopilots, the first tab. One place for the
 * company's Autopilot switch (assigned work starts by itself for agents that act on their own) and the autopilot
 * recipes (each creates ordinary schedules, listed under Schedules). In All companies it asks which company:
 * autopilots belong to one company, never to all of them.
 */
import { useState } from 'react'
import type { AutopilotId } from '@shared/autopilot'
import type { Id } from '@shared/types'
import { EmptyState } from './ui'
import { AutopilotTiles, runChecklistAction, SocialsSheet } from './home/SetupChecklist'
import { AutopilotSheet } from './home/AutopilotSheet'
import { useCompanySetup } from './home/useCompanySetup'
import { AutopilotSwitch } from '../views/BoardView'
import { RailMark } from '../shell/CompanyRail'
import { isPersonal } from '../lib/company'
import { departmentsOn, enterCompany, useStore } from '../state/store'
import { useScope } from './CompanyChip'
import '../styles/automations.css'

export function AutopilotsTab(): React.JSX.Element {
  const { scope } = useScope()
  const companies = useStore((s) => s.companies)
  const deptOn = useStore((s) => departmentsOn(s))
  const real = companies.filter((c) => !isPersonal(c) && !c.archivedAt)
  if (!deptOn) return <EmptyState icon="refresh" text="Autopilots run your departments’ agents. Turn on departments in Settings › Experimental to use them." />
  if (!scope || isPersonal({ id: scope, system: companies.find((c) => c.id === scope)?.system ?? null }))
    return (
      <div className="auto-tab">
        <p className="auto-tab__lede">Autopilots belong to one company. Pick the company to see or change its autopilots.</p>
        <div className="auto-tab__pick">
          {real.map((c) => (
            <button key={c.id} type="button" className="auto-tab__co" onClick={() => void enterCompany(c.id, { view: { name: 'schedules', tab: 'autopilots', nonce: Date.now() } })}>
              <RailMark company={c} size={24} />
              <span className="auto-tab__co-name">{c.name}</span>
              <span className="auto-tab__co-state">{c.pausedAt ? '‖ Paused' : c.autopilot ? 'Autopilot on' : 'Autopilot off'}</span>
            </button>
          ))}
        </div>
      </div>
    )
  return <CompanyAutopilots companyId={scope} />
}

function CompanyAutopilots({ companyId }: { companyId: Id }): React.JSX.Element {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const setup = useCompanySetup(companyId)
  const [open, setOpen] = useState<AutopilotId | null>(null)
  const [socials, setSocials] = useState(false)
  const handlers = { socials: () => setSocials(true), autopilot: (id: AutopilotId) => setOpen(id) }
  if (!company) return <EmptyState icon="refresh" text="This company is gone." />
  return (
    <div className="auto-tab">
      <section className="auto-tab__switch">
        <div>
          <div className="auto-tab__title">Autopilot for {company.name}</div>
          <p className="auto-tab__lede">{company.pausedAt ? `${company.name} is paused, so nothing starts. Resume it to turn Autopilot on.` : 'On: agents that act on their own start the work assigned to them. Off: they wait for you to press Start.'}</p>
        </div>
        <AutopilotSwitch key={company.id} company={company} />
      </section>
      <AutopilotTiles companyId={companyId} setup={setup} onOpen={(id) => setOpen(id)} />
      <p className="auto-tab__foot">
        Each autopilot creates ordinary schedules you can edit in <button type="button" className="link-btn" onClick={() => void enterCompany(companyId, { view: { name: 'schedules', tab: 'schedules', nonce: Date.now() } })}>Schedules</button>. They use your Claude plan; Principia charges nothing extra.
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
