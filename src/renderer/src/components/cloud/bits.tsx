/**
 * Small Cloud pane pieces (docs/CLOUD.md §13.1, VOICE.md §5): the cloud line mark (white stroke, 16 px grid), status
 * tesserae (square pixel tiles: the only colour), the QR code of a login link (white squares on --rm-ink, Copy as the
 * fallback) and the provider line marks.
 */
import type { ReactElement } from 'react'
import { PERSONAS, lookFor } from '@shared/personas'
import { Bust } from '../roman'
import { encodeQr, qrPath } from '../../lib/cloudQr'
import { agentParts, type Tessera } from '../../lib/cloud'
import { useCloudPlacement } from '../../state/cloud'

export const CLOUD_PATH = 'M4.5 12.5h7.2a2.8 2.8 0 0 0 .4-5.6 4 4 0 0 0-7.7-.8A3.2 3.2 0 0 0 4.5 12.5z'

/** The cloud line mark: next to companies and schedules that run in the cloud. */
export function CloudMark({ size = 14, title, className }: { size?: number; title?: string; className?: string }): ReactElement {
  return (
    <svg className={['cl-mark', className].filter(Boolean).join(' ')} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path d={CLOUD_PATH} />
    </svg>
  )
}

export function Tess({ kind, title }: { kind: Tessera; title?: string }): ReactElement {
  return <span className={`cl-tes cl-tes--${kind}`} title={title} aria-hidden={title ? undefined : true} />
}

/** Provider marks: line art, no logos. */
const PROVIDER_PATHS: Record<string, string> = {
  claude: 'M7 15l5-8 5 8M9 12.5h6',
  codex: 'M8 9l-2 3 2 3M16 9l2 3-2 3M13.5 8l-3 8',
  gemini: 'M12 5c0 4 3 7 7 7-4 0-7 3-7 7 0-4-3-7-7-7 4 0 7-3 7-7z'
}
export function ProviderMark({ adapter }: { adapter: string }): ReactElement {
  return (
    <svg className="cl-plogo rm-la" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" strokeOpacity={0.9} />
      <path d={PROVIDER_PATHS[adapter] ?? ''} strokeOpacity={0.5} />
    </svg>
  )
}

/** QR of a login link, or null when it does not fit (the caller shows Copy only). */
export function QrCode({ text, size = 132 }: { text: string; size?: number }): ReactElement | null {
  let path: string
  let dim: number
  try {
    const q = encodeQr(text)
    path = qrPath(q)
    dim = q.size + 8
  } catch {
    return null
  }
  return (
    <svg className="cl-qr" width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" role="img" aria-label="QR code of a one-time sign-in link">
      <rect width={dim} height={dim} className="cl-qr__ground" />
      <path d={path} className="cl-qr__dark" />
    </svg>
  )
}

/** The persona bust for an ask ("Marcus · Copywriter"), or a plain ring when the name is not a persona. */
export function AskBust({ agentName, size = 36 }: { agentName: string | null; size?: number }): ReactElement {
  const { name } = agentParts(agentName)
  const def = PERSONAS.find((p) => p.name === name.replace(/ [IVX]+$/, ''))
  if (!def) return <span className="cl-ring" style={{ width: size, height: size }} aria-hidden="true" />
  return <Bust look={lookFor(def, name)} size={size} ring />
}

/** Sidebar and Schedules: the cloud line next to a company or schedule placed in the cloud; nothing otherwise. */
export function CloudPlacedMark({ companyId, scheduleId }: { companyId?: string; scheduleId?: string }): ReactElement | null {
  const { companies, schedules } = useCloudPlacement()
  const on = (companyId && companies.includes(companyId)) || (scheduleId && schedules.includes(scheduleId))
  return on ? <CloudMark size={13} title={scheduleId ? 'Fires in the cloud' : 'Runs in the cloud'} /> : null
}
