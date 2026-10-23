import { useEffect, useMemo, useState } from 'react'
import type { Run, Schedule, Workflow } from '@shared/types'
import { Button, EmptyState, ErrorState, IconButton, Loading, Pill, StatusGlyph, Toolbar, RelativeTime } from '../components/ui'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { runVisual } from '../lib/graph'
import { isScript, shapeSummary } from '../lib/workflow'
import { useCoalesced } from '../lib/useThrottled'
import { attempt, companyName, enterCompany, navigate, openRunInputs, providerLabel, toast, type ViewState } from '../state/store'
import { CompanyChip, pickCompany, useScope } from '../components/CompanyChip'
import { companyLabel, companyOf } from '../lib/companyModel'
import { inScope } from '../lib/scope'
import { isNothingToDo, originLine } from '../lib/authoring'

type SortKey = 'name' | 'updated' | 'lastRun'

/**
 * Workflows (COMPANY.md §3, §8.3-8.4): the focused company's workflows, or every company's with a chip in All mode.
 * New / Import land in the focused company (All mode asks which one); "Duplicate to company…" copies across.
 */
export function WorkflowsView(): React.JSX.Element {
  const { scope, chips, multi, companies, nonce } = useScope()
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updated', dir: -1 })

  const filter = scope ? { companyId: scope } : undefined
  const load = (): void => {
    hive.workflows.list(filter).then(
      (w) => {
        setWorkflows(w)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
    hive.runs.list({ limit: 300, ...filter }).then(setRuns, () => undefined)
    hive.schedules.list(filter).then(setSchedules, () => undefined)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [nonce])
  const refetch = useCoalesced(load, 400)
  useHiveEvent('data:changed', ({ domain }) => (domain === 'workflows' || domain === 'schedules') && refetch())
  useHiveEvent('run:updated', (r) => r.workflowId && inScope(r, scope) && setRuns((l) => [r, ...l.filter((x) => x.id !== r.id)]))

  const lastRun = useMemo(() => {
    const m = new Map<string, Run>()
    for (const r of runs) if (r.workflowId && (!m.has(r.workflowId) || m.get(r.workflowId)!.createdAt < r.createdAt)) m.set(r.workflowId, r)
    return m
  }, [runs])
  const schedCount = (id: string): number => schedules.filter((s) => s.target.kind === 'workflow' && s.target.workflowId === id).length

  const sorted = useMemo(() => {
    const l = [...(workflows ?? [])]
    l.sort((a, b) => {
      let c = 0
      if (sort.key === 'name') c = a.name.localeCompare(b.name)
      if (sort.key === 'updated') c = a.updatedAt.localeCompare(b.updatedAt)
      if (sort.key === 'lastRun') c = (lastRun.get(a.id)?.createdAt ?? '').localeCompare(lastRun.get(b.id)?.createdAt ?? '')
      return c * sort.dir
    })
    return l
  }, [workflows, sort, lastRun])

  const edit = (id: string): void => void navigate({ name: 'editor', workflowId: id, nonce: Date.now() })
  /** The company new workflows go to: the focused one, or (All mode) the one the user picks. null = canceled. */
  const targetCompany = async (verb: string): Promise<string | undefined | null> => {
    if (scope || !multi) return scope
    return pickCompany(companies, { title: `${verb} in…` })
  }
  /** New Workflow / New Script: All mode enters the picked company first, so the editor saves into it. */
  const create = async (script: boolean): Promise<void> => {
    const view: ViewState = { name: 'editor', workflowId: null, nonce: Date.now(), ...(script ? { script: true } : {}) }
    if (scope || !multi) return void navigate(view)
    const id = await targetCompany(script ? 'New script' : 'New workflow')
    if (id) void enterCompany(id, { view })
  }
  const duplicateTo = async (w: Workflow, companyId: string): Promise<void> => {
    const d = await attempt(() => hive.workflows.duplicate({ id: w.id, companyId }), 'Duplicate')
    if (!d) return
    load()
    if (inScope(d, scope)) setSel(d.id)
    toast(companyOf(d) === companyOf(w) ? `Duplicated ${w.name}` : `Copied ${w.name} to ${companyName(companyOf(d))}`)
  }
  const remove = async (w: Workflow): Promise<void> => {
    const ok = await confirmNative({ message: `Delete “${w.name}”?`, detail: schedCount(w.id) ? 'Remove its schedules first.' : 'Past runs are kept.', confirmLabel: 'Delete Workflow', destructive: true }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.workflows.remove({ id: w.id }), 'Delete')
    load()
  }
  const menu = async (w: Workflow): Promise<void> => {
    const id = await nativeMenu([
      { id: 'run', label: 'Run…' },
      { id: 'edit', label: 'Edit' },
      { id: 'dup', label: 'Duplicate' },
      ...(multi
        ? [{ label: 'Duplicate to Company', submenu: companies.map((c) => ({ id: `dupTo:${c.id}`, label: companyLabel(c, true), enabled: c.id !== companyOf(w) })) }]
        : []),
      { id: 'schedule', label: 'Schedule…' },
      { id: 'export', label: 'Export…' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete' }
    ])
    if (id === 'run') openRunInputs(w.id)
    if (id === 'edit') edit(w.id)
    if (id === 'dup') void duplicateTo(w, companyOf(w))
    if (id?.startsWith('dupTo:')) void duplicateTo(w, id.slice(6))
    if (id === 'schedule') void navigate({ name: 'schedules', seed: { workflowId: w.id }, nonce: Date.now() })
    if (id === 'export') {
      const r = await attempt(() => hive.workflows.export({ id: w.id }), 'Export')
      if (r) toast(`Exported to ${r.path.split('/').pop()}`)
    }
    if (id === 'delete') void remove(w)
  }
  const importWf = async (): Promise<void> => {
    const companyId = await targetCompany('Import')
    if (companyId === null) return
    const w = await attempt(() => hive.workflows.import(companyId ? { companyId } : undefined), 'Import')
    if (w) {
      load()
      edit(w.id)
    }
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (!sorted.length) return
    const i = sorted.findIndex((w) => w.id === sel)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const j = Math.min(sorted.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
      setSel(sorted[j]!.id)
    } else if (e.key === 'Enter' && sel) {
      e.preventDefault()
      if (e.metaKey) openRunInputs(sel)
      else edit(sel)
    } else if (e.key === 'Backspace' && e.metaKey && sel) {
      const w = sorted.find((x) => x.id === sel)
      if (w) void remove(w)
    }
  }
  const header = (key: SortKey, label: string): React.JSX.Element => (
    <span className="th th--sortable" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === 'name' ? 1 : -1 }))}>
      {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
    </span>
  )

  return (
    <div className="view">
      <Toolbar title="Workflows">
        <Button onClick={() => void navigate({ name: 'marketplace' })}>Marketplace</Button>
        <Button icon="plus" onClick={() => void create(true)} title="A deterministic script (Python, Node or shell): no agents, no tokens. Runs on demand, on a schedule or from Slack, with your Keys as env vars.">
          New Script
        </Button>
        <Button icon="download" onClick={() => void importWf()}>
          Import…
        </Button>
        <Button variant="primary" icon="plus" onClick={() => void create(false)} kbd="⌘⇧N">
          New Workflow
        </Button>
      </Toolbar>
      {error && !workflows ? (
        <ErrorState error={error} onRetry={load} />
      ) : !workflows ? (
        <Loading />
      ) : workflows.length === 0 ? (
        <EmptyState
          icon="workflows"
          text={
            <>
              {scope && multi ? 'No workflows in this company yet. ' : ''}Save chains of agents that check each other.
              <div className="text-tertiary">Or describe one to Claude in a session (“every weekday at 9, review open PRs and text me”) and approve its card.</div>
            </>
          }
        >
          <Button variant="primary" icon="plus" onClick={() => void create(false)}>
            New Workflow
          </Button>
          <Button icon="download" onClick={() => void importWf()}>
            Import .hive.json…
          </Button>
        </EmptyState>
      ) : (
        <div className="table scroll" tabIndex={0} onKeyDown={onKey}>
          <div className="tr tr--head wf-cols">
            {header('name', 'Name')}
            <span className="th" title="Steps in order. ↺N = the check re-runs its step up to N times until it passes.">Steps</span>
            {header('lastRun', 'Last run')}
            <span className="th">Sched</span>
            {header('updated', 'Edited')}
            <span />
          </div>
          {sorted.map((w) => {
            const lr = lastRun.get(w.id)
            const sc = schedCount(w.id)
            return (
              <div
                key={w.id}
                className={`tr wf-cols ${sel === w.id ? 'is-selected' : ''}`}
                onClick={(e) => {
                  setSel(w.id)
                  if (!e.metaKey && !e.shiftKey) edit(w.id)
                }}
                title="Click or ↵ to open · ⌘↵ to run · right-click for more"
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSel(w.id)
                  void menu(w)
                }}
              >
                <span className="td td--main" title={[w.description, w.origin ? originLine(w.origin, providerLabel) : ''].filter(Boolean).join('\n')}>
                  {chips && <CompanyChip companyId={w.companyId} className="wf-company" />}
                  {w.name}
                  {isScript(w) && <Pill tone="scheduled" title="Script: deterministic steps only, no agents">Script</Pill>}
                  {w.origin && <span className="wf-origin">✦ {originLine(w.origin, providerLabel)}</span>}
                </span>
                <span className="td text-secondary td--ellipsis" title={`${shapeSummary(w)}\n\n→ runs after · ↺N = re-runs the checked step up to N times until the check passes\ncommand check = a shell command decides (exit 0 = pass) · room = agents discuss in rounds`}>
                  {shapeSummary(w)}
                </span>
                <span className="td">
                  {lr ? (
                    <span className="inline-gap" onClick={(e) => (e.stopPropagation(), void navigate({ name: 'run', runId: lr.id }))} title="Open run">
                      {isNothingToDo(lr) ? <span className="glyph glyph--quiet" title="Passed · nothing to do">–</span> : <StatusGlyph status={runVisual(lr.status)} />} <RelativeTime iso={lr.endedAt ?? lr.createdAt} />
                    </span>
                  ) : (
                    <span className="text-tertiary">never</span>
                  )}
                </span>
                <span className="td">{sc > 0 ? <span className="text-scheduled">◷ {sc}</span> : ''}</span>
                <span className="td text-tertiary">
                  <RelativeTime iso={w.updatedAt} />
                </span>
                <span className="td td--actions">
                  <IconButton icon="play" label="Run… (⌘↵)" onClick={(e) => (e.stopPropagation(), openRunInputs(w.id))} />
                  <IconButton icon="more" label="More" onClick={(e) => (e.stopPropagation(), void menu(w))} />
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
