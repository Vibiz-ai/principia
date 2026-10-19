import type { AdapterId, AgentProfile, ProviderInfo } from '@shared/types'
import { providerLabel } from '../state/store'

/** One dropdown of profiles grouped by adapter (SPEC A15). Unavailable adapters are disabled. */
export function AgentSelect({
  value,
  onChange,
  profiles,
  providers,
  allowShell = false,
  className
}: {
  value: string | null
  onChange: (id: string) => void
  profiles: AgentProfile[]
  providers: ProviderInfo[]
  allowShell?: boolean
  className?: string
}): React.JSX.Element {
  const adapters = (['claude', 'codex', 'cursor', 'gemini', ...(allowShell ? (['shell'] as AdapterId[]) : [])] as AdapterId[]).filter((a) => profiles.some((p) => p.adapter === a))
  const known = profiles.some((p) => p.id === value)
  return (
    <select className={`input ${className ?? ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {!known && (
        <option value={value ?? ''} disabled>
          {value ? 'Unknown agent' : 'Choose an agent…'}
        </option>
      )}
      {adapters.map((a) => {
        const prov = providers.find((p) => p.id === a)
        const missing = prov ? !prov.available : false
        return (
          <optgroup key={a} label={`${providerLabel(a)}${missing ? ' — not installed' : ''}`}>
            {profiles
              .filter((p) => p.adapter === a)
              .map((p) => (
                <option key={p.id} value={p.id} disabled={missing && p.id !== value}>
                  {[p.name, p.model].filter(Boolean).join(' · ')}
                </option>
              ))}
          </optgroup>
        )
      })}
    </select>
  )
}

export function missingHint(profileId: string | null, profiles: AgentProfile[], providers: ProviderInfo[]): string | null {
  const p = profiles.find((x) => x.id === profileId)
  if (!p) return null
  const prov = providers.find((x) => x.id === p.adapter)
  if (!prov || prov.available) return null
  return `${prov.label} not installed — ${prov.installHint}`
}
