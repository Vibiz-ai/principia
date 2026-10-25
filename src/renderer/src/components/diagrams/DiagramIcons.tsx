/**
 * DIAGRAMS.md §5: white line icons, one per node kind (24 px grid, 1.5 stroke, currentColor), plus the three panel
 * buttons. Inline SVG, like components/Icon.tsx; kept here so the shared icon set stays small.
 */
import type { DiagramNodeKind, DiagramTaskStatus } from '@shared/diagram'

const KIND: Record<DiagramNodeKind, string> = {
  client: 'M3.5 5h17v11h-17zM8.5 19.5h7M12 16v3.5',
  service: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5',
  database: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  queue: 'M4 6.5h16M4 6.5l2-3h12l2 3M4 6.5v3.5h16V6.5M4 13h16v3.5H4zM4 19.5h16',
  storage: 'M3.5 7.5 6 4h12l2.5 3.5M3.5 7.5h17v12h-17zM9 11.5h6',
  external: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3',
  person: 'M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6',
  function: 'M14.5 3.5c-2 0-3 1-3.4 3L9.6 17c-.4 2-1.4 3.5-3.6 3.5M7.5 10h8',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15.5h6',
  decision: 'M12 3 21 12 12 21 3 12zM10 10a2 2 0 1 1 2.5 1.9c-.4.2-.5.5-.5.9v.5M12 15.5h.01',
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5M8.5 8.5h7M8.5 11.5h5',
  task: 'M5 4h14v16H5zM8.5 12l2.3 2.3L15.5 9.5',
  milestone: 'M6 21V3.5M6 4h11l-2.5 4L17 12H6',
  metric: 'M4 20h16M6.5 16.5V12M11 16.5V7M15.5 16.5v-6M20 16.5V4.5',
  group: 'M3.5 6.5V4h2.5M18 4h2.5v2.5M20.5 17.5V20H18M6 20H3.5v-2.5M9 4h6M9 20h6M3.5 9.5v5M20.5 9.5v5'
}

/** Task nodes show their status instead of the plain kind icon. */
const STATUS: Record<DiagramTaskStatus, string> = {
  todo: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z',
  in_progress: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17',
  in_review: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM7 12s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3zM12 12h.01',
  blocked: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM6 18 18 6',
  done: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8 12.3l2.7 2.7L16 9.5'
}

const TOOL = {
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 9h6v6H9z',
  expand: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
  copy: 'M8 8h11v12H8zM5 16H4V4h12v1',
  close: 'M6 6l12 12M18 6 6 18',
  warning: 'M12 3.5 21.5 20h-19zM12 10v4.5M12 17.5h.01'
} as const
export type DiagramTool = keyof typeof TOOL

function Svg({ d, size }: { d: string; size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export function KindIcon({ kind, status, size = 22 }: { kind: DiagramNodeKind; status?: DiagramTaskStatus; size?: number }): React.JSX.Element {
  return <Svg d={kind === 'task' && status ? STATUS[status] : KIND[kind]} size={size} />
}

export function ToolIcon({ name, size = 14 }: { name: DiagramTool; size?: number }): React.JSX.Element {
  return <Svg d={TOOL[name]} size={size} />
}

export const STATUS_LABEL: Record<DiagramTaskStatus, string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done' }
export const KIND_LABEL: Record<DiagramNodeKind, string> = {
  client: 'Client',
  service: 'Service',
  database: 'Database',
  queue: 'Queue',
  storage: 'Storage',
  external: 'External',
  person: 'Person',
  function: 'Function',
  file: 'File',
  decision: 'Decision',
  note: 'Note',
  task: 'Task',
  milestone: 'Milestone',
  metric: 'Metric',
  group: 'Group'
}
