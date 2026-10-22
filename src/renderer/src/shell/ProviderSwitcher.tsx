import { SWITCHER_ADAPTERS } from '@shared/types'
import { Segmented } from '../components/ui'
import { providerLabel, setProvider, useStore } from '../state/store'
import { isMultiCompany } from '../lib/companyModel'

/** Claude | Codex | Cursor | Gemini — adapter for new sessions. Missing CLIs are disabled with the install hint. */
export function ProviderSwitcher(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const current = useStore((s) => s.settings?.defaultAdapter ?? 'claude')
  // COMPANY.md §8.2: with 2+ companies ⌃1-9 select companies; the provider chord keeps working with Shift
  const chord = useStore((s) => (isMultiCompany(s.companies) ? '⌃⇧' : '⌃'))
  const items = SWITCHER_ADAPTERS.map((id, i) => {
    const p = providers.find((x) => x.id === id)
    const available = p?.available ?? false
    return {
      value: id,
      disabled: !available,
      title: available ? `${p?.label ?? id}${p?.version ? ` ${p.version}` : ''} — ${chord}${i + 1}` : `${p?.label ?? providerLabel(id)} isn't installed. ${p?.installHint ?? ''}`,
      label: (
        <>
          <span className="provider-dot" style={{ background: `var(--provider-${id})` }} />
          {providerLabel(id)}
        </>
      )
    }
  })
  return <Segmented className="no-drag provider-switcher" items={items} value={current} onChange={setProvider} />
}
