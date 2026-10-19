/**
 * Live agent tree rows: a root (session or step) and its subagents at any depth (LIVE.md §6, §11).
 * AgentTree renders the children of one agent; AgentRow renders a hub root with its disclosure.
 */
import { useState } from 'react'
import type { AgentNode, Ask } from '@shared/live'
import type { Id } from '@shared/types'
import { activityLine, agentLabel, agentVisual, answerText, answerTrace, attributionNote, costOrTokens, isLive, rootTitle, rowActivity, type AgentIndex } from '../../lib/live'
import { providerLabel, useStore } from '../../state/store'
import { focusAgent } from '../../state/live'
import { Icon } from '../Icon'
import { ProviderDot, useTick } from '../ui'
import { AgentMemoryChip } from '../memory/MemoryChips'
import { treeMemReads } from '../../lib/live'
import { AgentGlyph, Elapsed, NeedsBadge } from './AgentBits'
import { LimitActions, StalledBadge, agentLimitTarget } from './LimitBits'
import { isRateLimited, limitLine } from '../../lib/live'

/** Children of `parentId`, recursively. Selecting a row calls onSelect (run view, drawer) or jumps to it (hub). */
export function AgentTree({
  idx,
  parentId,
  depth = 1,
  askAgents,
  selectedId,
  onSelect,
  defaultOpen = true,
  inlineNotes = true,
  stacked = false
}: {
  idx: AgentIndex
  parentId: Id
  depth?: number
  askAgents: ReadonlySet<Id>
  selectedId?: Id | null
  onSelect?: (a: AgentNode) => void
  defaultOpen?: boolean
  /** Show the degradation note ("activity matched by timing") inline. Narrow lists keep it in the tooltip only. */
  inlineNotes?: boolean
  /** Two-line rows (narrow columns such as the Run view): label on top, activity and note below, nothing cut short. */
  stacked?: boolean
}): React.JSX.Element | null {
  const kids = idx.children.get(parentId)
  if (!kids?.length) return null
  return (
    <div className="atree" role="group">
      {kids.map((a) => (
        <AgentTreeRow key={a.id} idx={idx} agent={a} depth={depth} askAgents={askAgents} selectedId={selectedId} onSelect={onSelect} defaultOpen={defaultOpen} inlineNotes={inlineNotes} stacked={stacked} />
      ))}
    </div>
  )
}

function AgentTreeRow({ idx, agent: a, depth, askAgents, selectedId, onSelect, defaultOpen, inlineNotes, stacked }: { idx: AgentIndex; agent: AgentNode; depth: number; askAgents: ReadonlySet<Id>; selectedId?: Id | null; onSelect?: (a: AgentNode) => void; defaultOpen: boolean; inlineNotes: boolean; stacked: boolean }): React.JSX.Element {
  const hasKids = !!idx.children.get(a.id)?.length
  const [open, setOpen] = useState(defaultOpen || isLive(a))
  const note = attributionNote(a)
  const act = rowActivity(a)
  const visual = askAgents.has(a.id) ? 'needs' : agentVisual(a)
  return (
    <>
      <div
        className={`atree__row ${stacked ? 'atree__row--stacked' : ''} ${selectedId === a.id ? 'is-selected' : ''} ${isLive(a) ? '' : 'is-ended'}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        role="treeitem"
        aria-expanded={hasKids ? open : undefined}
        aria-selected={selectedId === a.id}
        onClick={(e) => {
          e.stopPropagation()
          if (onSelect) onSelect(a)
          else void focusAgent(a.id)
        }}
        title={[agentLabel(a), a.agentType && a.agentType !== a.title ? a.agentType : null, activityLine(a), note].filter(Boolean).join('\n')}
      >
        <button
          type="button"
          className="atree__twisty"
          tabIndex={-1}
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          {hasKids && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />}
        </button>
        <AgentGlyph visual={visual} />
        {stacked ? (
          <span className="atree__body">
            <span className="atree__label">{agentLabel(a)}</span>
            {(act || note) && (
              <span className="atree__sub">
                {act && <span className="atree__activity">{act}</span>}
                {note && <span className="atree__note">{note}</span>}
              </span>
            )}
          </span>
        ) : (
          <>
            <span className="atree__label">{agentLabel(a)}</span>
            {act && <span className="atree__activity">{act}</span>}
            {note && inlineNotes && <span className="atree__note">{note}</span>}
          </>
        )}
        <span className="atree__meta">
          <Elapsed agent={a} />
        </span>
      </div>
      {hasKids && open && <AgentTree idx={idx} parentId={a.id} depth={depth + 1} askAgents={askAgents} selectedId={selectedId} onSelect={onSelect} defaultOpen={defaultOpen} inlineNotes={inlineNotes} stacked={stacked} />}
    </>
  )
}

/** Hub row for a root (LIVE.md §6 "Row"): status, provider, title, repo, live activity, elapsed, cost, subagents, memory. */
export function AgentRow({
  idx,
  root,
  asks,
  seen,
  dim = false,
  children,
  compact = false
}: {
  idx: AgentIndex
  root: AgentNode
  asks: Ask[]
  seen: boolean
  dim?: boolean
  children?: React.ReactNode
  compact?: boolean
}): React.JSX.Element {
  useTick(30_000)
  const repos = useStore((s) => s.repos)
  const allAsks = useStore((s) => s.asks)
  const answered = asks.length ? null : answerTrace(root, Object.values(allAsks))
  const answeredLine = answered ? answerText(answered) : null
  const askAgents = new Set(asks.map((a) => a.agentId))
  const subs = idx.children.get(root.id)?.length ?? 0
  const allSubs = countDesc(idx, root.id)
  const [open, setOpen] = useState(() => asks.some((a) => a.agentId !== root.id) || (isLive(root) && subs > 0 && subs <= 3))
  const repo = root.repoId ? repos.find((r) => r.id === root.repoId) : null
  const visual = asks.length ? 'needs' : agentVisual(root, seen)
  const money = costOrTokens(root)
  const limited = isRateLimited(root)
  const limitTarget = limited ? agentLimitTarget(root) : null
  return (
    <div className={`arow ${dim ? 'is-dim' : ''} ${compact ? 'arow--compact' : ''} ${visual === 'needs' ? 'arow--needs' : ''}`}>
      <div className="arow__main" role="button" tabIndex={0} onClick={() => void focusAgent(root.id)} onKeyDown={(e) => e.key === 'Enter' && void focusAgent(root.id)} title={root.kind === 'session' ? 'Open this session' : 'Open this run'}>
        <button
          type="button"
          className="arow__twisty"
          tabIndex={-1}
          aria-label={open ? 'Hide subagents' : 'Show subagents'}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          {allSubs > 0 && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
        </button>
        <AgentGlyph visual={visual} />
        <ProviderDot adapter={root.provider} />
        <div className="arow__text">
          <div className="arow__title">
            <span className="arow__name" title={root.title}>
              {rootTitle(root)}
            </span>
            {repo && <span className="arow__repo">{repo.name}</span>}
            {!repo && root.kind === 'session' && <span className="arow__repo">Chat</span>}
          </div>
          <div className="arow__activity" title={answeredLine ? `${answeredLine}\n${activityLine(root, seen)}` : activityLine(root, seen)}>
            <span className="text-tertiary">{providerLabel(root.provider)} · </span>
            {limited ? <span className="limit-line">{limitLine(root)}</span> : answeredLine ? <span className="arow__answered">↩ {answeredLine}</span> : activityLine(root, seen)}
          </div>
        </div>
        <span className="arow__meta">
          {allSubs > 0 && <span className="arow__chip" title={`${allSubs} subagent${allSubs === 1 ? '' : 's'}`}>{allSubs} subagent{allSubs === 1 ? '' : 's'}</span>}
          <AgentMemoryChip owner={{ runId: root.runId, stepId: root.stepId, sessionId: root.sessionId }} reads={treeMemReads(idx, root.id)} repoId={root.repoId} mini />
          <StalledBadge agent={root} />
          <NeedsBadge count={asks.length} />
          {money && <span className="arow__money">{money}</span>}
          <Elapsed agent={root} />
        </span>
      </div>
      {limitTarget && <LimitActions target={limitTarget} compact showLine={false} />}
      {open && allSubs > 0 && (
        <div className="arow__tree">
          <AgentTree idx={idx} parentId={root.id} askAgents={askAgents} />
        </div>
      )}
      {children}
    </div>
  )
}

function countDesc(idx: AgentIndex, id: Id): number {
  let n = 0
  for (const c of idx.children.get(id) ?? []) n += 1 + countDesc(idx, c.id)
  return n
}
