/** Read-only mini graph of a proposed workflow (AUTHORING.md §2.2): same layout as the editor, diff colors on updates. */
import { useMemo } from 'react'
import type { AgentProfile, WorkflowDraft } from '@shared/types'
import { GraphView } from '../GraphView'
import { draftDiffGraph } from '../../lib/graph'

export function DraftGraph({
  draft,
  base,
  diff,
  profiles,
  height = 180,
  onSelect
}: {
  draft: WorkflowDraft
  base: WorkflowDraft | null
  diff: { added: string[]; removed: string[]; changed: string[] } | null
  profiles: AgentProfile[]
  height?: number
  onSelect?: (nodeId: string) => void
}): React.JSX.Element {
  const g = useMemo(() => draftDiffGraph(draft, base, diff, profiles), [draft, base, diff, profiles])
  const fitKey = useMemo(() => `${g.nodes.length}:${g.edges.length}:${g.width}x${g.height}`, [g])
  return (
    <div className="draft-graph" style={{ height }}>
      <GraphView nodes={g.nodes} edges={g.edges} fitKey={fitKey} interactive={false} onSelect={onSelect ? (ref) => ref.kind === 'wfnode' && onSelect(ref.nodeId) : undefined} />
      {diff && (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) && (
        <div className="draft-graph__legend">
          {diff.added.length > 0 && <span className="draft-graph__key draft-graph__key--added">+{diff.added.length} added</span>}
          {diff.changed.length > 0 && <span className="draft-graph__key draft-graph__key--changed">~{diff.changed.length} changed</span>}
          {diff.removed.length > 0 && <span className="draft-graph__key draft-graph__key--removed">−{diff.removed.length} removed</span>}
        </div>
      )}
    </div>
  )
}
