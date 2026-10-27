/**
 * CONNECTIONS.md §4.3 S19: Knowledge's outside sources. Every service whose connection can feed what agents know
 * (meeting notes, company docs) as the shared slot, so a Notion or Granola connection made anywhere shows here, and one
 * made here is the company's everywhere. Agents look things up through the connection's tools when they need them;
 * nothing is copied into the Knowledge folder.
 */
import { SERVICE_REGISTRY } from '@shared/services'
import { ConnectionSlot } from '../connections/ConnectionSlot'

const SOURCES = SERVICE_REGISTRY.filter((s) => !s.soon && s.capabilities.some((c) => c.purpose === 'knowledge'))

export function KnowledgeSources({ companyId, n = '05', compact = false }: { companyId: string; n?: string; compact?: boolean }): React.JSX.Element | null {
  if (!SOURCES.length) return null
  // the Knowledge view's side panel: one chip per source, its state and Connect in one click
  if (compact)
    return (
      <div className="cx-forms">
        <div className="pside__empty">Notes and docs agents look up through the connection. Nothing is copied here.</div>
        <div className="cx-chips">
          {SOURCES.map((s) => (
            <ConnectionSlot key={s.id} companyId={companyId} service={s.id} purpose="knowledge" variant="chip" />
          ))}
        </div>
      </div>
    )
  return (
    <section className="passport-section" aria-label="Sources">
      <div className="passport-section-title">
        {n && <span>{n}</span>}
        <h2>Sources</h2>
      </div>
      <p className="passport-section-description">Meeting notes and docs your agents look up when a task needs them, through the connection. Connected once for the company, here or in Settings › Connections. Nothing is copied into Knowledge.</p>
      <div className="cx-forms">
        {SOURCES.map((s) => (
          <ConnectionSlot key={s.id} companyId={companyId} service={s.id} purpose="knowledge" label={s.capabilities.find((c) => c.purpose === 'knowledge')?.label} />
        ))}
      </div>
    </section>
  )
}
