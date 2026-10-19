/** Who wrote a memory, from which run/step/session, and when (MEMORY.md §10.4). Links go to the run. */
import type { MemoryProvenance } from '@shared/memory'
import { adapterName } from '../../lib/memory'
import { focusSession, getState, navigate, toast } from '../../state/store'
import { ProviderDot, RelativeTime } from '../ui'

export function ProvenanceChips({
  provenance: p,
  at,
  unattributed,
  editedByUser,
  compact
}: {
  provenance: MemoryProvenance | null
  at: string
  unattributed?: boolean
  editedByUser?: boolean
  compact?: boolean
}): React.JSX.Element {
  const openSession = (id: string): void => {
    if (getState().sessions.some((s) => s.id === id)) focusSession(id)
    else toast('That session is gone')
  }
  return (
    <span className={`mprov ${compact ? 'mprov--compact' : ''}`}>
      {unattributed ? (
        <span className="mprov__item text-warning" title="Written by an agent whose grant no longer resolves. Check it before trusting it.">
          ⚠ unknown agent
        </span>
      ) : p ? (
        <>
          <span className="mprov__item" title={[p.profileName, p.model, p.transport === 'inject' ? 'brief only' : null].filter(Boolean).join(' · ')}>
            <ProviderDot adapter={p.adapter} /> {p.profileName && p.profileName !== adapterName(p.adapter) ? p.profileName : adapterName(p.adapter)}
          </span>
          {!compact && p.model && <span className="mprov__item mono">{p.model}</span>}
          {p.runId && (
            <button type="button" className="mprov__item mprov__link" title="Open the run that wrote this" onClick={() => void navigate({ name: 'run', runId: p.runId!, stepId: p.stepId ?? undefined })}>
              {p.runTitle ?? 'run'}
            </button>
          )}
          {(p.nodeLabel || p.nodeId) && <span className="mprov__item">{p.nodeLabel || p.nodeId}</span>}
          {p.sessionId && !p.runId && (
            <button type="button" className="mprov__item mprov__link" onClick={() => openSession(p.sessionId!)}>
              session
            </button>
          )}
        </>
      ) : (
        <span className="mprov__item">You</span>
      )}
      <span className="mprov__item text-tertiary">
        <RelativeTime iso={at} />
      </span>
      {editedByUser && p && <span className="mprov__item text-tertiary">edited by you</span>}
    </span>
  )
}
