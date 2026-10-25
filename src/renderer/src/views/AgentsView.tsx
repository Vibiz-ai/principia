/**
 * Agents hub (LIVE.md §6, F3): every running, waiting and recent agent across all repos in one place.
 * Groups: Needs you · Working (+ dimmed Open sessions) · Done recently. Click a row to focus or open it; answer
 * asks and reply to idle sessions inline. COMPANY.md §8.3-8.4: focused mode shows the active company's agents only;
 * All mode shows every company's, each row tagged with its company. DEPARTMENTS.md §9: a board task's run row shows
 * "PRN-42 · Marketing/Copywriter" (TaskRunChip), which opens the card.
 */
import { useMemo, useState } from 'react'
import type { AgentNode } from '@shared/live'
import type { Id } from '@shared/types'
import { hubGroups, isSeen, isUnseenIdle } from '../lib/live'
import { AgentRow } from '../components/agents/AgentTree'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { ApprovalCard } from '../components/author/ApprovalCard'
import { usePendingDrafts } from '../state/authoring'
import { Button, EmptyState, Kbd, Loading, SectionHeader, Toolbar, useTick } from '../components/ui'
import { focusAgent, goNextNeedsYou, useSeenSet } from '../state/live'
import { CompanyTagged, useAgentCompany, useScope, useScopedLive } from '../components/CompanyChip'
import { inScope } from '../lib/scope'
import { loadJson, openPalette, saveJson, useStore } from '../state/store'
import { TaskRunChip } from '../components/board/TaskRunChip'

/** Five doors: mounted as Chats → Live (ChatsView passes its title, tabs and New chat). */
export function AgentsView({ title = 'Agents', sub, actions }: { title?: string; sub?: React.ReactNode; actions?: React.ReactNode } = {}): React.JSX.Element {
  useTick()
  const { scope, chips } = useScope()
  const { idx, asks: allAsks } = useScopedLive(scope)
  const companyOfAgent = useAgentCompany()
  const sessions = useStore((s) => s.sessions)
  // approval asks are shown as cards from the drafts slice (Approvals), not as ask rows
  const asks = useMemo(() => allAsks.filter((a) => a.kind !== 'approval'), [allAsks])
  const allDrafts = usePendingDrafts()
  // a draft belongs to its authoring session's company (Personal when it has none)
  const drafts = useMemo(() => (scope ? allDrafts.filter((d) => inScope(d.sessionId ? sessions.find((s) => s.id === d.sessionId) : null, scope)) : allDrafts), [allDrafts, sessions, scope])
  const approvalFocus = useStore((s) => s.approvalFocus)
  const seen = useSeenSet()
  const repos = useStore((s) => s.repos)
  const available = useStore((s) => s.liveAvailable)
  const focus = useStore((s) => s.agentFocus)
  const [savedRepo, setRepoId] = useState<Id | null>(() => loadJson<Id | null>('hive.agentsRepo', null))
  const pickRepo = (id: Id | null): void => {
    setRepoId(id)
    saveJson('hive.agentsRepo', id)
  }

  const roots = idx.roots
  const repoChips = useMemo(() => {
    const used = new Set(roots.map((r) => r.repoId).filter(Boolean) as Id[])
    return repos.filter((r) => used.has(r.id))
  }, [roots, repos])
  // a remembered repo of another company (or one with no agents left) filters nothing
  const repoId = savedRepo && repoChips.some((r) => r.id === savedRepo) ? savedRepo : null
  const groups = useMemo(() => hubGroups(roots, asks, seen, { repoId }), [roots, asks, seen, repoId])
  const tag = (root: AgentNode, row: React.ReactNode): React.ReactNode => (
    <CompanyTagged key={root.id} companyId={companyOfAgent(idx.byId.get(root.id) ?? root)} chips={chips}>
      {row}
    </CompanyTagged>
  )
  const shownDrafts = repoId ? drafts.filter((d) => !d.sessionId || roots.some((r) => r.sessionId === d.sessionId && r.repoId === repoId)) : drafts
  const empty = !shownDrafts.length && !groups.needs.length && !groups.working.length && !groups.open.length && !groups.done.length
  const focusedDraft = approvalFocus && shownDrafts.some((d) => d.id === approvalFocus.draftId) ? approvalFocus.draftId : null
  const hotAsk = focusedDraft ? null : focus?.askId && asks.some((a) => a.id === focus.askId) ? focus.askId : (groups.needs[0]?.asks[0]?.id ?? null)
  const hotDraft = focusedDraft ?? (hotAsk ? null : (shownDrafts[0]?.id ?? null))

  return (
    <div className="view">
      <Toolbar title={title} sub={sub}>
        {groups.needs.length > 0 && (
          <Button onClick={goNextNeedsYou} kbd="⌘J" title="Jump to the oldest thing waiting for you">
            Next
          </Button>
        )}
        {actions}
      </Toolbar>
      <div className="scroll view__body">
        <div className="hub">
          {repoChips.length > 1 && (
            <div className="hub__filters" role="radiogroup" aria-label="Repository filter">
              <button type="button" role="radio" aria-checked={!repoId} className={`hchip ${!repoId ? 'is-on' : ''}`} onClick={() => pickRepo(null)}>
                All repos
              </button>
              {repoChips.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={repoId === r.id} className={`hchip ${repoId === r.id ? 'is-on' : ''}`} onClick={() => pickRepo(repoId === r.id ? null : r.id)}>
                  {r.name}
                </button>
              ))}
            </div>
          )}
          {available === null ? (
            <Loading />
          ) : empty ? (
            <EmptyState icon="agents" text={repoId ? 'No agents in this repository in the last 24 hours.' : title === 'Chats' ? 'Nothing is live right now. Chats and agent work show up here while they run; every conversation is under All.' : scope ? 'No agents running in this company. Its sessions, workflow steps and their subagents show up here while they work.' : 'No agents running. Sessions, workflow steps and their subagents show up here while they work.'}>
              {repoId ? (
                <Button onClick={() => pickRepo(null)}>Show all repos</Button>
              ) : (
                <>
                  <Button variant="primary" onClick={() => openPalette('newSession')} kbd="⌘N">
                    New Session
                  </Button>
                  <Button onClick={() => openPalette('runWorkflow')}>Run a Workflow</Button>
                </>
              )}
            </EmptyState>
          ) : (
            <>
              {shownDrafts.length > 0 && (
                <>
                  <SectionHeader title="Approvals" count={<span className="text-needs">{shownDrafts.length}</span>} />
                  <div className="hub__approvals">
                    {shownDrafts.map((d) => (
                      <CompanyTagged key={d.id} companyId={sessions.find((x) => x.id === d.sessionId)?.companyId} chips={chips}>
                        <ApprovalCard draft={d} hotkeys={d.id === hotDraft} />
                      </CompanyTagged>
                    ))}
                  </div>
                </>
              )}
              {groups.needs.length > 0 && (
                <>
                  <SectionHeader title="Needs you" count={<span className="text-needs">{groups.needs.reduce((n, g) => n + (g.asks.length || 1), 0)}</span>}>
                    <span className="text-tertiary hub__keys">
                      <Kbd>⌘J</Kbd> next
                    </span>
                  </SectionHeader>
                  <div className="group-list hub__list">
                    {groups.needs.map(({ root, asks: ra }) => tag(root,
                      <AgentRow key={root.id} idx={idx} root={root} asks={ra} seen={isSeen(root, seen)}>
                        <TaskRunChip runId={root.runId} sessionId={root.sessionId} />
                        {ra.length > 0 && (
                          <div className="arow__asks">
                            {ra.map((a) => (
                              <AskCard key={a.id} ask={a} hotkeys={a.id === hotAsk} onOpen={() => void focusAgent(a.agentId, a.id)} />
                            ))}
                          </div>
                        )}
                        {ra.length === 0 && isUnseenIdle(root, seen) && <ReplyBox agent={root} onOpen={() => void focusAgent(root.id)} />}
                      </AgentRow>
                    ))}
                  </div>
                </>
              )}
              {(groups.working.length > 0 || groups.open.length > 0) && (
                <>
                  <SectionHeader title="Working" count={groups.working.length || undefined} />
                  <div className="group-list hub__list">
                    {groups.working.map((r) => tag(r, <AgentRow key={r.id} idx={idx} root={r} asks={[]} seen={false}><TaskRunChip runId={r.runId} sessionId={r.sessionId} /></AgentRow>))}
                    {groups.working.length === 0 && <div className="hub__none text-tertiary">Nothing working right now.</div>}
                  </div>
                  {groups.open.length > 0 && (
                    <>
                      <div className="hub__sub">Open sessions</div>
                      <div className="group-list hub__list">
                        {groups.open.map((r) => tag(r,
                          <AgentRow key={r.id} idx={idx} root={r} asks={[]} seen dim>
                            <TaskRunChip runId={r.runId} sessionId={r.sessionId} />
                            {r.status === 'needs_you' && r.needs === 'idle' && <ReplyBox agent={r} onOpen={() => void focusAgent(r.id)} />}
                          </AgentRow>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
              {groups.done.length > 0 && (
                <>
                  <SectionHeader title="Done recently" count={groups.done.length} />
                  <div className="group-list hub__list">
                    {groups.done.map((r) => tag(r, <AgentRow key={r.id} idx={idx} root={r} asks={[]} seen compact><TaskRunChip runId={r.runId} sessionId={r.sessionId} /></AgentRow>))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
