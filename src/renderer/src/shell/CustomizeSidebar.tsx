/**
 * Five doors step 5 (design §2.3, §3; Linear's Customize sidebar): every More item set to Always show, Show when
 * active or Hidden, with ↑/↓ to order what is pinned. The five doors always show. Saved per company in
 * settings.sidebarNav (the same prefs the More pins write), so a change shows in the sidebar at once.
 */
import type { NavVisibility } from '@shared/types'
import { Icon } from '../components/Icon'
import { IconButton, Segmented, Sheet } from '../components/ui'
import { customizeRows, movePin, PRIMARY, prefsFor, resetVisibility, setVisibility, type MoreKey } from '../lib/nav'
import { activeCompany, companyName, multiCompany, updateSidebarPrefs, useStore } from '../state/store'
import { plansEnabled } from '@shared/plans'
import { departmentsOn } from '../state/store'

export const CUSTOMIZE_EVENT = 'hive:customizeSidebar'
export function openCustomizeSidebar(): void {
  window.dispatchEvent(new CustomEvent(CUSTOMIZE_EVENT))
}

const VIS: { value: NavVisibility; label: string }[] = [
  { value: 'always', label: 'Always show' },
  { value: 'active', label: 'When active' },
  { value: 'hidden', label: 'Hidden' }
]

export function CustomizeSidebarSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const navPrefs = useStore((s) => s.settings?.sidebarNav)
  const active = useStore((s) => activeCompany(s))
  const multi = useStore((s) => multiCompany(s))
  const plansOn = useStore((s) => plansEnabled(s.settings?.experimental) && departmentsOn(s))
  const prefs = prefsFor(navPrefs, active, multi)
  const available = (k: MoreKey): boolean => (k === 'plans' ? plansOn : true)
  const rows = customizeRows(prefs, available)
  const pinned = rows.filter((r) => r.visibility === 'always').map((r) => r.key)
  const where = !multi ? 'your sidebar' : active === 'all' ? 'All companies' : companyName(active)
  return (
    <Sheet title="Customize sidebar" onCancel={onClose} cancelLabel="Done" width={560} footerLeft={<button type="button" className="link-btn" onClick={() => updateSidebarPrefs(resetVisibility)}>Reset to defaults</button>}>
      <p className="cust__lede">Choose what sits in the sidebar for {where}. Hidden items stay one click away under More, and everything is in ⌘K.</p>
      <div className="cust__group">
        <div className="cust__head">Always in the sidebar</div>
        <div className="cust__doors">
          {PRIMARY.map((d) => (
            <span key={d.key} className="cust__door">
              <Icon name={d.icon} size={13} /> {d.label}
            </span>
          ))}
        </div>
      </div>
      <div className="cust__group" role="list" aria-label="More items">
        <div className="cust__head">More items</div>
        {rows.map((r) => {
          const i = pinned.indexOf(r.key)
          return (
            <div key={r.key} className="cust__row" role="listitem">
              <Icon name={r.icon} />
              <span className="cust__text">
                <span className="cust__label">{r.label}</span>
                <span className="cust__desc">{r.key === 'forum' ? 'When active: shows while a thread needs you' : r.desc}</span>
              </span>
              {i >= 0 && (
                <span className="cust__order">
                  <IconButton icon="chevronDown" className="cust__up" label={`Move ${r.label} up`} disabled={i === 0} onClick={() => updateSidebarPrefs((p) => movePin(p, r.key, -1))} />
                  <IconButton icon="chevronDown" label={`Move ${r.label} down`} disabled={i === pinned.length - 1} onClick={() => updateSidebarPrefs((p) => movePin(p, r.key, 1))} />
                </span>
              )}
              <Segmented<NavVisibility> size="sm" items={VIS} value={r.visibility} onChange={(v) => updateSidebarPrefs((p) => setVisibility(p, r.key, v))} />
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}
