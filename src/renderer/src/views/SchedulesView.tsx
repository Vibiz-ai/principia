import { useEffect, useMemo, useState } from 'react'
import type { AdapterId, Run, RunTarget, Schedule, ScheduleEvent, SchedulePreview, Workflow } from '@shared/types'
import { SWITCHER_ADAPTERS } from '@shared/types'
import { AutoTextarea, Button, EmptyState, ErrorState, Field, Loading, RelativeTime, Segmented, Sheet, StatusGlyph, Stepper, Switch, TimeField, Toolbar } from '../components/ui'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { runVisual } from '../lib/graph'
import { PRESET_LABELS, defaultForm, formToWhen, whenToForm, type PresetKind, type WhenForm } from '../lib/schedule'
import { absolute, absoluteWithDay, duration } from '../lib/time'
import { useCoalesced } from '../lib/useThrottled'
import { firstLine } from '../lib/format'
import { SlackTriggersTab } from '../components/slack/TriggerEditor'
import { attempt, companyName, enterCompany, lastInputs, multiCompany, navigate, pauseAllSchedulesAsked, providerLabel, setCompanyPaused, toast, updateSettings, useStore, type ScheduleSeed } from '../state/store'
import { CompanyChip, pickCompany, useScope } from '../components/CompanyChip'
import { companyOf, reposOf } from '../lib/companyModel'
import { inScope } from '../lib/scope'
import { AutomationTabs } from '../components/AutomationTabs'
import { AutopilotsTab } from '../components/AutopilotsTab'
import { CloudPlacedMark } from '../components/cloud/bits'
import { useCloudPlacement } from '../state/cloud'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import type { Id } from '@shared/types'

const ADAPTER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', shell: 'A script' }

export function SchedulesView({ selectedId, seed, nonce, tab }: { selectedId?: string; seed?: ScheduleSeed; nonce?: number; tab?: 'autopilots' | 'schedules' | 'slack' }): React.JSX.Element {
  // a deep link to a schedule (or a seed) opens Schedules; Automations itself opens on Autopilots
  const [cur, setCur] = useState<'autopilots' | 'schedules' | 'slack'>(tab ?? 'schedules')
  useEffect(() => setCur(tab ?? 'schedules'), [tab, nonce])
  if (cur === 'autopilots')
    return (
      <div className="view">
        <Toolbar title="Automations" sub={<ScheduleTabs value={cur} onChange={setCur} />} />
        <div className="scroll view__body">
          <AutopilotsTab />
        </div>
      </div>
    )
  if (cur === 'slack')
    return (
      <div className="view">
        <Toolbar title="Automations" sub={<ScheduleTabs value={cur} onChange={setCur} />} />
        <ScopedSlackTriggers seedWorkflowId={tab === 'slack' ? seed?.workflowId : undefined} nonce={nonce} />
      </div>
    )
  return <SchedulesList selectedId={selectedId} seed={tab === 'slack' ? undefined : seed} nonce={nonce} tabs={<ScheduleTabs value={cur} onChange={setCur} />} />
}

/**
 * COMPANY.md §3: Slack triggers belong to the company that owns the workspace (main refuses a trigger whose workflow
 * is elsewhere). A focused company that doesn't own it is pointed there instead of seeing another company's triggers.
 */
function ScopedSlackTriggers({ seedWorkflowId, nonce }: { seedWorkflowId?: string; nonce?: number }): React.JSX.Element {
  const { scope, multi } = useScope()
  // undefined = loading; null = no workspace, or a main without slack:company (nothing to gate on)
  const [owner, setOwner] = useState<Id | null | undefined>(undefined)
  const load = (): void => void hive.slack.company().then((h) => setOwner(h?.companyId ?? null), () => setOwner(null))
  useEffect(load, [])
  useHiveEvent('data:changed', ({ domain }) => domain === 'company' && load())
  if (multi && scope && owner === undefined) return <Loading />
  if (multi && scope && owner && owner !== scope)
    return (
      <EmptyState icon="slack" text={`The connected Slack workspace belongs to ${companyName(owner)}, so its triggers live there.`}>
        <Button variant="primary" onClick={() => void enterCompany(owner, { view: { name: 'schedules', tab: 'slack' } })}>
          Open in {companyName(owner)}
        </Button>
      </EmptyState>
    )
  return <SlackTriggersTab seedWorkflowId={seedWorkflowId} nonce={nonce} />
}

/** SLACK.md §12.5 + five doors: Automations → Schedules | Workflows | Slack triggers. */
function ScheduleTabs({ value, onChange }: { value: 'autopilots' | 'schedules' | 'slack'; onChange: (v: 'autopilots' | 'schedules' | 'slack') => void }): React.JSX.Element {
  return <AutomationTabs value={value} onChange={(v) => v !== 'workflows' && onChange(v)} />
}

/** COMPANY.md §3, §8.3-8.4: the focused company's schedules, or every company's with a chip in All mode. */
function SchedulesList({ selectedId, seed, nonce, tabs }: { selectedId?: string; seed?: ScheduleSeed; nonce?: number; tabs: React.ReactNode }): React.JSX.Element {
  const { scope, chips, nonce: scopeNonce } = useScope()
  const status = useStore((s) => s.status)
  const repos = useStore((s) => s.repos)
  const profiles = useStore((s) => s.profiles)
  const companies = useStore((s) => s.companies)
  // A4: a paused company starts nothing, so its Run Now is greyed out (the banner says why) instead of inviting an error
  const heldBy = (s: Schedule): string | null => {
    const c = companies.find((x) => x.id === s.companyId)
    return c?.pausedAt ? c.name : null
  }
  const [list, setList] = useState<Schedule[] | null>(null)
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(selectedId ?? null)
  const [sheet, setSheet] = useState<ScheduleSeed | null>(seed ?? null)

  useEffect(() => setSel(selectedId ?? null), [selectedId])
  useEffect(() => setSheet(seed ?? null), [seed, nonce])

  const filter = scope ? { companyId: scope } : undefined
  const load = (): void => {
    hive.schedules.list(filter).then(
      (l) => {
        setList(l)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
    hive.workflows.list(filter).then(setWorkflows, () => undefined)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [scopeNonce])
  const refetch = useCoalesced(load, 300)
  useHiveEvent('schedule:updated', (s) => inScope(s, scope) && setList((l) => (l ? (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]) : l)))
  useHiveEvent('data:changed', ({ domain }) => (domain === 'schedules' || domain === 'workflows') && refetch())

  const paused = !!status?.schedulesPaused
  const targetLabel = (t: RunTarget): string => {
    if (t.kind === 'workflow') return `⇶ ${workflows.find((w) => w.id === t.workflowId)?.name ?? 'workflow'}`
    const p = profiles.find((x) => x.id === t.profileId)
    const r = repos.find((x) => x.id === t.repoId)
    // plain words: who runs it, and in which repository when it has one ("◆ Claude", "◆ Claude · ledgerly-app")
    const who = p?.adapter ? (ADAPTER_NAME[p.adapter] ?? p.adapter) : 'An agent'
    return r ? `◆ ${who} · ${r.name}` : `◆ ${who}`
  }

  // CLOUD.md §8: a schedule placed in the cloud starts there (main answers null: no local run)
  const cloudSchedules = useCloudPlacement().schedules
  const runNow = async (s: Schedule): Promise<void> => {
    const inCloud = cloudSchedules.includes(s.id)
    const r = await attempt(() => hive.schedules.runNow({ id: s.id }), 'Run Now')
    if (r) toast(`Started ${s.name}`)
    else if (r === null && inCloud) toast(`Started ${s.name} in the cloud`)
  }
  const setEnabled = async (s: Schedule, enabled: boolean): Promise<void> => {
    setList((l) => l?.map((x) => (x.id === s.id ? { ...x, enabled } : x)) ?? l)
    const res = await attempt(() => hive.schedules.setEnabled({ id: s.id, enabled }), enabled ? 'Enable' : 'Disable')
    if (res) setList((l) => l?.map((x) => (x.id === s.id ? res : x)) ?? l)
    else load()
  }
  const remove = async (s: Schedule): Promise<void> => {
    const ok = await confirmNative({ message: `Delete schedule “${s.name}”?`, detail: 'Its past runs are kept.', confirmLabel: 'Delete Schedule', destructive: true }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.schedules.remove({ id: s.id }), 'Delete')
    if (sel === s.id) setSel(null)
    load()
  }
  const menu = async (s: Schedule): Promise<void> => {
    const held = heldBy(s)
    const id = await nativeMenu([
      { id: 'run', label: held ? `Run Now (${held} is paused)` : 'Run Now', enabled: !held },
      { id: 'edit', label: 'Edit…' },
      { id: 'toggle', label: s.enabled ? 'Disable' : 'Enable' },
      ...(s.target.kind === 'workflow' ? [{ id: 'wf', label: 'Open Workflow' }] : []),
      { type: 'separator' },
      { id: 'delete', label: 'Delete' }
    ])
    if (id === 'run') void runNow(s)
    if (id === 'edit') setSheet({ editId: s.id })
    if (id === 'toggle') void setEnabled(s, !s.enabled)
    if (id === 'wf' && s.target.kind === 'workflow') void navigate({ name: 'editor', workflowId: s.target.workflowId, nonce: Date.now() })
    if (id === 'delete') void remove(s)
  }

  const selected = list?.find((s) => s.id === sel) ?? null
  const multi = multiCompany()
  const focusedCo = useStore((st) => (scope ? (st.companies.find((c) => c.id === scope) ?? null) : null))
  return (
    <div className="view">
      <Toolbar title="Automations" sub={tabs}>
        {/* PM review: inside a company the pause is that company's (agents, schedules, autopilot); every company only from All */}
        {multi && focusedCo && !paused ? (
          <Button icon={focusedCo.pausedAt ? 'play' : 'pause'} variant={focusedCo.pausedAt ? 'secondary' : 'ghost'} onClick={() => void setCompanyPaused(focusedCo.id, !focusedCo.pausedAt)} title={focusedCo.pausedAt ? undefined : 'This company only. Other companies keep running.'}>
            {focusedCo.pausedAt ? `Resume ${focusedCo.name}` : `Pause ${focusedCo.name}`}
          </Button>
        ) : (
          <Button icon="pause" variant={paused ? 'secondary' : 'ghost'} className={paused ? 'btn--caution' : ''} onClick={() => void pauseAllSchedulesAsked(!paused)} title={multi ? 'Every company’s schedules (asks first)' : undefined}>
            {paused ? (multi ? 'Resume All Companies…' : 'Resume All') : multi ? 'Pause All Companies…' : 'Pause All'}
          </Button>
        )}
        <Button variant="primary" icon="plus" onClick={() => setSheet({})}>
          New Schedule
        </Button>
      </Toolbar>
      {paused && <div className="banner banner--warning banner--bar">Schedules are paused in every company. Nothing fires until you resume.</div>}
      {!paused && focusedCo?.pausedAt && <div className="banner banner--warning banner--bar">‖ {focusedCo.name} is paused. Its schedules hold until you resume it; other companies keep running.</div>}
      {error && !list ? (
        <ErrorState error={error} onRetry={load} />
      ) : !list ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState icon="schedules" text={`${scope ? 'No schedules in this company yet. ' : ''}Run a workflow or prompt on a timer. Schedules fire while Principia is running — turn on Launch at Login.`}>
          <Button variant="primary" icon="plus" onClick={() => setSheet({})}>
            New Schedule
          </Button>
        </EmptyState>
      ) : (
        <div className={`split-h ${selected ? 'has-inspector' : ''}`}>
          <div className="table scroll split-h__main">
            <div className="tr tr--head sch-cols">
              <span className="th">On</span>
              <span className="th">Name</span>
              <span className="th">Who runs it</span>
              <span className="th">When</span>
              <span className="th">Next</span>
              <span className="th">Last</span>
              <span />
            </div>
            {list.map((s) => (
              <div
                key={s.id}
                className={`tr sch-cols ${sel === s.id ? 'is-selected' : ''} ${s.enabled ? '' : 'is-dim'}`}
                onClick={() => setSel(s.id)}
                onDoubleClick={() => setSheet({ editId: s.id })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSel(s.id)
                  void menu(s)
                }}
              >
                <span className="td" onClick={(e) => e.stopPropagation()}>
                  <Switch checked={s.enabled} onChange={(v) => void setEnabled(s, v)} label={`Enable ${s.name}`} />
                </span>
                <span className="td td--main">
                  {chips && <CompanyChip companyId={s.companyId} className="wf-company" />}
                  {s.name}
                  <CloudPlacedMark scheduleId={s.id} />
                </span>
                <span className="td text-secondary td--ellipsis">{targetLabel(s.target)}</span>
                <span className="td text-secondary td--ellipsis" title={s.sentence}>
                  {s.sentence}
                </span>
                <span className="td">{s.enabled && !paused && s.nextFireAt ? <RelativeTime iso={s.nextFireAt} /> : <span className="text-tertiary">—</span>}</span>
                <span className="td">{s.lastRunStatus ? <StatusGlyph status={runVisual(s.lastRunStatus)} /> : <span className="text-tertiary">—</span>}</span>
                <span className="td td--actions">
                  <Button size="sm" disabled={!!heldBy(s)} title={heldBy(s) ? `${heldBy(s)} is paused. Resume it to run this.` : cloudSchedules.includes(s.id) ? 'Runs in the cloud' : undefined} onClick={(e) => (e.stopPropagation(), void runNow(s))}>
                    Run Now
                  </Button>
                </span>
              </div>
            ))}
          </div>
          {selected && <History schedule={selected} held={heldBy(selected)} onRunNow={() => void runNow(selected)} />}
        </div>
      )}
      {sheet && (
        <ScheduleSheet
          seed={sheet}
          existing={sheet.editId ? (list?.find((s) => s.id === sheet.editId) ?? null) : null}
          workflows={workflows}
          onClose={() => setSheet(null)}
          onSaved={(s) => {
            setSheet(null)
            setSel(s.id)
            load()
          }}
        />
      )}
    </div>
  )
}

function History({ schedule, held, onRunNow }: { schedule: Schedule; held: string | null; onRunNow: () => void }): React.JSX.Element {
  const [events, setEvents] = useState<ScheduleEvent[] | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const load = (): void => {
    hive.schedules.events({ scheduleId: schedule.id, limit: 50 }).then(setEvents, () => setEvents([]))
    hive.runs.list({ scheduleId: schedule.id, limit: 50 }).then(setRuns, () => undefined)
  }
  useEffect(load, [schedule.id])
  useHiveEvent('schedule:fired', (p) => p.event.scheduleId === schedule.id && load())
  useHiveEvent('run:updated', (r) => r.scheduleId === schedule.id && setRuns((l) => [r, ...l.filter((x) => x.id !== r.id)]))

  type Row = { at: string; key: string; node: React.ReactNode }
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const runIds = new Set(runs.map((r) => r.id))
    for (const r of runs) {
      out.push({
        at: r.createdAt,
        key: r.id,
        node: (
          <>
            <StatusGlyph status={runVisual(r.status)} /> <span className="hist__what">{r.status}</span>
            <span className="text-tertiary">
              {duration(r.startedAt, r.endedAt)}
              {r.trigger === 'catchup' ? ' · caught up' : r.trigger === 'manual' ? ' · run now' : ''}
            </span>
            <span className="flex1" />
            <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'run', runId: r.id })}>
              Open Run
            </Button>
          </>
        )
      })
    }
    for (const e of events ?? []) {
      if (e.kind === 'fired' && e.runId && runIds.has(e.runId)) continue
      const label =
        e.kind === 'skipped_overlap'
          ? '⤼ skipped — previous run still going'
          : e.kind === 'missed'
            ? `⚠ missed${e.message ? ` — ${e.message}` : ''}`
            : e.kind === 'caught_up'
              ? '↺ caught up (Mac was asleep or Principia was closed)'
              : e.kind === 'error'
                ? `✕ ${e.message ?? 'error'}`
                : `◷ fired${e.message ? ` — ${e.message}` : ''}`
      out.push({ at: e.createdAt, key: e.id, node: <span className={e.kind === 'missed' ? 'text-warning' : e.kind === 'error' ? 'text-failed' : 'text-secondary'}>{label}</span> })
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1))
  }, [events, runs])

  return (
    <div className="history scroll">
      <div className="history__head">
        <div className="history__title">History</div>
        <div className="history__sub" title={schedule.sentence}>
          {schedule.name} · {schedule.sentence.replace(/\s*\([^)]*\)\s*$/, '')}
        </div>
      </div>
      {events === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState compact text={<>Hasn’t fired yet.{schedule.nextFireAt ? ` Next: ${absoluteWithDay(schedule.nextFireAt)}.` : ''}</>}>
          <Button size="sm" disabled={!!held} title={held ? `${held} is paused. Resume it to run this.` : undefined} onClick={onRunNow}>
            Run Now
          </Button>
        </EmptyState>
      ) : (
        rows.map((r) => (
          <div key={r.key} className="hist">
            <span className="hist__at mono">{absolute(r.at)}</span>
            {r.node}
          </div>
        ))
      )}
    </div>
  )
}

function ScheduleSheet({
  seed,
  existing,
  workflows: allWorkflows,
  onClose,
  onSaved
}: {
  seed: ScheduleSeed
  existing: Schedule | null
  workflows: Workflow[]
  onClose: () => void
  onSaved: (s: Schedule) => void
}): React.JSX.Element {
  // The schedule's company (§3: stamped from its workflow; the guard refuses cross-company targets): the existing
  // schedule's, the seeded workflow's, else the focused company. All mode can change it; that re-filters the lists.
  const { scope, multi, companies } = useScope()
  const [companyId, setCompanyId] = useState<Id>(() => {
    if (existing) return companyOf(existing)
    const seeded = seed.workflowId ? allWorkflows.find((w) => w.id === seed.workflowId) : undefined
    return seeded ? companyOf(seeded) : (scope ?? PERSONAL_COMPANY_ID)
  })
  const allRepos = useStore((s) => s.repos)
  const repos = useMemo(() => (multi ? reposOf(allRepos, companyId) : allRepos), [allRepos, companyId, multi])
  const workflows = useMemo(() => (multi ? allWorkflows.filter((w) => companyOf(w) === companyId) : allWorkflows), [allWorkflows, companyId, multi])
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const ex = existing?.target
  const [kind, setKind] = useState<'workflow' | 'prompt'>(ex?.kind ?? (seed.workflowId || workflows.length ? 'workflow' : 'prompt'))
  const [workflowId, setWorkflowId] = useState<string>(ex?.kind === 'workflow' ? ex.workflowId : (seed.workflowId ?? workflows[0]?.id ?? ''))
  const [inputs, setInputs] = useState<Record<string, string>>(ex?.kind === 'workflow' ? ex.inputs : (seed.inputs ?? {}))
  const exProfile = ex?.kind === 'prompt' ? profiles.find((p) => p.id === ex.profileId) : undefined
  const [adapter, setAdapter] = useState<AdapterId>(exProfile?.adapter ?? settings?.defaultAdapter ?? 'claude')
  const [repoId, setRepoId] = useState<string>(ex?.kind === 'prompt' ? (ex.repoId ?? '') : repos.some((r) => r.id === settings?.lastRepoId) ? settings!.lastRepoId! : '')
  const [prompt, setPrompt] = useState(ex?.kind === 'prompt' ? ex.prompt : '')
  const [form, setForm] = useState<WhenForm>(existing ? whenToForm(existing.when, existing.preset) : defaultForm())
  const [name, setName] = useState(existing?.name ?? '')
  const [nameTouched, setNameTouched] = useState(!!existing)
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [busy, setBusy] = useState(false)

  const wf = workflows.find((w) => w.id === workflowId)
  useEffect(() => {
    if (!wf || ex?.kind === 'workflow') return
    const prev = lastInputs(wf.id)
    const v: Record<string, string> = {}
    const lastRepo = repos.some((r) => r.id === settings?.lastRepoId) ? settings!.lastRepoId! : undefined
    for (const i of wf.inputs) v[i.name] = seed.inputs?.[i.name] ?? prev[i.name] ?? i.default ?? (i.type === 'repo' ? (lastRepo ?? repos[0]?.id ?? '') : '')
    setInputs(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId])
  useEffect(() => {
    if (nameTouched) return
    setName(kind === 'workflow' ? (wf?.name ?? '') : firstLine(prompt, 40))
  }, [kind, wf?.name, prompt, nameTouched])

  const parsed = formToWhen(form)
  useEffect(() => {
    if (!parsed.ok) return setPreview(null)
    const t = setTimeout(() => {
      hive.schedules.preview({ when: parsed.when }).then(setPreview, (e) => setPreview({ ok: false, sentence: '', next: [], error: errorMessage(e) }))
    }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(parsed)])

  const profileFor = (a: AdapterId): string | undefined => profiles.find((p) => p.adapter === a)?.id
  const target: RunTarget | null =
    kind === 'workflow' ? (workflowId ? { kind: 'workflow', workflowId, inputs } : null) : profileFor(adapter) && prompt.trim() ? { kind: 'prompt', profileId: exProfile?.adapter === adapter ? exProfile.id : profileFor(adapter)!, repoId: repoId || null, prompt } : null
  const whenError = !parsed.ok ? parsed.error : preview && !preview.ok ? preview.error : null
  const missingInputs = kind === 'workflow' && wf ? wf.inputs.filter((i) => !inputs[i.name]?.trim()) : []
  const blocked = !target || !!whenError || !name.trim() || missingInputs.length > 0 || busy
  const blockReason = !target ? (kind === 'workflow' ? 'Choose a workflow' : 'Write a prompt') : whenError ? whenError : !name.trim() ? 'Name it' : missingInputs.length ? `Fill in ${missingInputs.map((i) => i.label).join(', ')}` : undefined

  const save = async (): Promise<void> => {
    if (blocked || !target || !parsed.ok) return
    setBusy(true)
    try {
      const input = { name: name.trim(), target, when: parsed.when, preset: parsed.preset, enabled: existing?.enabled ?? true }
      const s = existing ? await hive.schedules.update({ id: existing.id, input }) : await hive.schedules.create(multi ? { ...input, companyId } : input)
      toast(existing ? 'Schedule saved' : `Scheduled ${s.name}`)
      onSaved(s)
    } catch (e) {
      const errs = (e as { errors?: { message: string }[] }).errors
      toast(errs?.length ? errs.map((x) => x.message).join(' · ') : errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const presetItems = (Object.keys(PRESET_LABELS) as PresetKind[]).map((k) => ({ value: k, label: PRESET_LABELS[k] }))
  return (
    <Sheet
      title={existing ? 'Edit Schedule' : 'New Schedule'}
      onCancel={onClose}
      onPrimary={() => void save()}
      primaryLabel={busy ? 'Saving…' : 'Save'}
      primaryDisabled={blocked}
      primaryTitle={blockReason}
      footerLeft={
        settings && !settings.launchAtLogin ? (
          <span className="text-secondary sheet__note">
            Schedules only fire while Principia is running.{' '}
            <button type="button" className="link-btn" onClick={() => void updateSettings({ launchAtLogin: true })}>
              Turn on Launch at Login
            </button>
          </span>
        ) : undefined
      }
    >
      {multi && (
        <Field label="Company">
          <span className="inline-gap">
            <CompanyChip companyId={companyId} always />
            {!existing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const id = await pickCompany(companies, { exclude: companyId })
                  if (!id) return
                  setCompanyId(id)
                  setWorkflowId(allWorkflows.find((w) => companyOf(w) === id)?.id ?? '')
                  setRepoId('')
                }}
              >
                Change…
              </Button>
            )}
          </span>
        </Field>
      )}
      <Field label="Run">
        <Segmented
          size="sm"
          items={[
            { value: 'workflow', label: 'Workflow', disabled: workflows.length === 0, title: workflows.length ? undefined : 'No workflows yet' },
            { value: 'prompt', label: 'Single prompt' }
          ]}
          value={kind}
          onChange={setKind}
        />
      </Field>
      {kind === 'workflow' ? (
        <>
          <Field label="">
            <select className="input" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
              {!workflowId && <option value="">Choose a workflow…</option>}
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          {wf?.inputs.map((i) => (
            <Field key={i.name} label={<span className="text-secondary">{i.label || i.name}</span>} align={i.type === 'multiline' ? 'start' : 'center'}>
              {i.type === 'repo' ? (
                <select className="input" value={inputs[i.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })}>
                  <option value="">Choose a repository…</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : i.type === 'multiline' ? (
                <AutoTextarea minRows={3} value={inputs[i.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} />
              ) : (
                <input className="input" value={inputs[i.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} />
              )}
            </Field>
          ))}
        </>
      ) : (
        <>
          <Field label="Agent">
            <Segmented
              size="sm"
              items={SWITCHER_ADAPTERS.map((a) => {
                const p = providers.find((x) => x.id === a)
                return { value: a, label: providerLabel(a), disabled: !p?.available || !profileFor(a), title: p?.available ? undefined : `${p?.label ?? a} isn't installed. ${p?.installHint ?? ''}` }
              })}
              value={adapter}
              onChange={setAdapter}
            />
          </Field>
          <Field label="Repo">
            <select className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="">Scratch folder (no repo)</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prompt" align="start">
            <AutoTextarea className="mono" minRows={3} value={prompt} placeholder="Summarize open PRs and write a report…" onChange={(e) => setPrompt(e.target.value)} />
          </Field>
        </>
      )}
      <div className="sheet__sep" />
      <Field label="When" align="start">
        <div className="when">
          <select className="input input--auto" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PresetKind })}>
            {presetItems.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {(form.kind === 'weekdays' || form.kind === 'daily') && <TimeField label="Time" value={form.time} onChange={(time) => setForm({ ...form, time })} />}
          {form.kind === 'hourly' && (
            <span className="inline-gap">
              at minute <Stepper label="Minute" value={form.minute} min={0} max={59} onChange={(minute) => setForm({ ...form, minute })} />
            </span>
          )}
          {form.kind === 'everyNMinutes' && (
            <span className="inline-gap">
              every <Stepper label="Minutes" value={form.n} min={5} max={59} onChange={(n) => setForm({ ...form, n })} /> minutes
            </span>
          )}
          {form.kind === 'once' && <input className="input" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />}
          {form.kind === 'cron' && <input className="input mono" value={form.cron} placeholder="0 9 * * 1-5" onChange={(e) => setForm({ ...form, cron: e.target.value })} spellCheck={false} />}
        </div>
        {whenError ? (
          <div className="field__error">{whenError}</div>
        ) : preview?.ok ? (
          <div className="when__preview">
            <div>“{preview.sentence}”</div>
            <div className="text-tertiary">Next: {preview.next.map((n) => absoluteWithDay(n)).join(' · ')}</div>
          </div>
        ) : (
          <div className="field__hint">&nbsp;</div>
        )}
      </Field>
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setNameTouched(true)
          }}
        />
      </Field>
    </Sheet>
  )
}
