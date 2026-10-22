import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AdapterId, AgentProfile, CheckNode, NodeType, NotifyNode, ProviderInfo, Repo, RoomNode, ValidationError, WaitNode, Workflow, WorkflowDraft, WorkflowInput, WorkflowNode, WorkflowOrigin } from '@shared/types'
import type { AuthorDraft } from '@shared/authoring'
import type { MemoryMode } from '@shared/memory'
import { AgentSelect, missingHint } from '../components/AgentSelect'
import { GraphView } from '../components/GraphView'
import { Icon } from '../components/Icon'
import { TemplateTextArea } from '../components/TemplateTextArea'
import { Button, Disclosure, ErrorState, IconButton, Loading, Popover, Segmented, Stepper, Toolbar } from '../components/ui'
import { draftGraph } from '../lib/graph'
import { MEMORY_MODE_LABEL, allowedMemoryModes, applyMemoryToAll, transportNote, workflowMemoryMode } from '../lib/memory'
import { confirmNative, errorMessage, hive, nativeMenu } from '../lib/hive'
import {
  NODE_GLYPH,
  NODE_LABEL,
  createNode,
  defaultProfileFor,
  depsOf,
  draftKey,
  duplicateNode,
  localValidate,
  moveNode,
  newDraft,
  newScriptDraft,
  removeNode,
  renameNode,
  slugify,
  templateSuggestions,
  updateNode,
  wouldCycle,
  implicitDeps
} from '../lib/workflow'
import { attempt, focusSession, goBack, navigate, openRunInputs, providerLabel, refreshProfiles, scopeCompanyId, setLeaveGuard, toast, useStore } from '../state/store'
import { approveEdited, openApproval } from '../state/authoring'
import { originDetail, originLine } from '../lib/authoring'
import { intervalLabel } from '../lib/graph'
import { channelLabel, notifyChoice, notifySlackOf, userName, type NotifyChoice } from '../lib/slack'
import { isSetUp, useSlack } from '../state/slack'
import { ChannelSelect } from '../components/slack/bits'
import { SlackTriggerChip } from '../components/slack/TriggerEditor'

/** What the editor edits: the saved fields of a workflow (origin is provenance, not content). */
function toDraft(w: WorkflowDraft): WorkflowDraft {
  const d: WorkflowDraft = { name: w.name, description: w.description, inputs: w.inputs, nodes: w.nodes }
  if (w.worktree) d.worktree = w.worktree
  if (w.slackTools) d.slackTools = true
  if (w.slackAgentPermissions) d.slackAgentPermissions = w.slackAgentPermissions
  return d
}

export function WorkflowEditor({ workflowId, nonce, approvalDraftId, script }: { workflowId: string | null; nonce: number; approvalDraftId?: string; script?: boolean }): React.JSX.Element {
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)
  const repos = useStore((s) => s.repos)
  const defaultAdapter = useStore((s) => s.settings?.defaultAdapter ?? 'claude')
  const [id, setId] = useState<string | null>(workflowId)
  const [draft, setDraft] = useState<WorkflowDraft | null>(null)
  const [savedKey, setSavedKey] = useState<string>('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [problems, setProblems] = useState<ValidationError[]>([])
  const [saving, setSaving] = useState(false)
  const [outlined, setOutlined] = useState<string | null>(null)
  const [focusedCard, setFocusedCard] = useState<string | null>(null)
  const [origin, setOrigin] = useState<WorkflowOrigin | null>(null)
  /** "Approve & save" mode (AUTHORING.md §2.2): editing an agent's proposed workflow; Save approves it. */
  const [approval, setApproval] = useState<AuthorDraft | null>(null)
  const [allowRun, setAllowRun] = useState(false)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  const agentProfiles = profiles.filter((p) => p.adapter !== 'shell')
  const defProfile = defaultProfileFor(agentProfiles, defaultAdapter)?.id ?? null
  const secondProfile = (agentProfiles.find((p) => p.adapter === 'codex' && providers.find((x) => x.id === 'codex')?.available) ?? null)?.id ?? defProfile

  useEffect(() => {
    setId(workflowId)
    setLoadError(null)
    setOrigin(null)
    setApproval(null)
    if (approvalDraftId) {
      setDraft(null)
      hive.author.get({ id: approvalDraftId }).then(
        (x) => {
          if (!x.draft) return setLoadError('This approval has no workflow to edit.')
          const d = toDraft(x.draft)
          setApproval(x)
          setAllowRun(false)
          if (x.kind === 'update') setId(x.workflowId)
          setDraft(d)
          setSavedKey(draftKey(d))
        },
        (e) => setLoadError(errorMessage(e))
      )
    } else if (workflowId) {
      setDraft(null)
      hive.workflows.get({ id: workflowId }).then(
        (w: Workflow) => {
          const d = toDraft(w)
          setDraft(d)
          setSavedKey(draftKey(d))
          setOrigin(w.origin ?? null)
        },
        (e) => setLoadError(errorMessage(e))
      )
    } else {
      const d = script ? newScriptDraft() : newDraft(defProfile)
      setDraft(d)
      // an untouched new draft is not "edited" — only a real change marks it dirty
      setSavedKey(draftKey(d))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, nonce, approvalDraftId])

  const edited = !!draft && draftKey(draft) !== savedKey
  useEffect(() => {
    void hive.ui.setEdited({ edited }).catch(() => undefined)
  }, [edited])
  useEffect(() => () => void hive.ui.setEdited({ edited: false }).catch(() => undefined), [])

  const editedRef = useRef(edited)
  editedRef.current = edited
  const nameRef = useRef(draft?.name)
  nameRef.current = draft?.name
  useEffect(() => {
    setLeaveGuard(async () => {
      if (!editedRef.current) return true
      return confirmNative({
        message: `Discard unsaved changes to “${nameRef.current ?? 'workflow'}”?`,
        detail: 'Save with ⌘S to keep them.',
        confirmLabel: 'Discard Changes',
        destructive: true
      }).catch(() => false)
    })
    return () => setLeaveGuard(null)
  }, [])

  // live validation (300 ms): main is authoritative; local mirror when main can't answer
  useEffect(() => {
    if (!draft) return
    const t = setTimeout(() => {
      hive.workflows.validate(draft).then(
        (errs) => setProblems(errs),
        () => setProblems(localValidate(draft))
      )
    }, 300)
    return () => clearTimeout(t)
  }, [draft])

  const save = useCallback(async (): Promise<string | null> => {
    if (!draft) return null
    if (approval) {
      // Approve & save: the edited version is what gets saved (and scheduled / run, per the card)
      setSaving(true)
      const r = await approveEdited(approval.id, draft, allowRun)
      setSaving(false)
      if (r.errors?.length) {
        setProblems(r.errors)
        toast(r.errors[0]!.message, 'error')
        return null
      }
      if (!r.ok) return null
      setSavedKey(draftKey(draft))
      setApproval(null)
      void navigate({ name: 'workflows' })
      return null
    }
    setSaving(true)
    try {
      // COMPANY.md §3: a new workflow belongs to the focused company (no companyId = Personal)
      const companyId = scopeCompanyId()
      const w = id ? await hive.workflows.update({ id, draft }) : await hive.workflows.create(companyId ? { ...draft, companyId } : draft)
      setId(w.id)
      const d = toDraft(w)
      setDraft(d)
      setSavedKey(draftKey(d))
      setOrigin(w.origin ?? null)
      toast('Saved')
      return w.id
    } catch (e) {
      const errs = (e as { errors?: ValidationError[] }).errors
      if (errs?.length) {
        setProblems(errs)
        toast(errs[0]!.message, 'error')
      } else toast(`Save failed: ${errorMessage(e)}`, 'error')
      return null
    } finally {
      setSaving(false)
    }
  }, [draft, id, approval, allowRun])

  const run = async (): Promise<void> => {
    const wid = edited || !id ? await save() : id
    if (wid) openRunInputs(wid)
  }
  const schedule = async (): Promise<void> => {
    const wid = edited || !id ? await save() : id
    if (wid) void navigate({ name: 'schedules', seed: { workflowId: wid }, nonce: Date.now() })
  }
  /** SLACK.md §12.5: "Add Slack trigger" on a workflow opens the trigger editor seeded with it. */
  const slackTrigger = async (): Promise<void> => {
    const wid = edited || !id ? await save() : id
    if (wid) void navigate({ name: 'schedules', tab: 'slack', seed: { workflowId: wid }, nonce: Date.now() })
  }

  const addNode = (type: NodeType): void => {
    if (!draft) return
    const n = createNode(draft, type, defProfile, secondProfile)
    setDraft({ ...draft, nodes: [...draft.nodes, n] })
    requestAnimationFrame(() => cardRefs.current.get(n.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.code === 'KeyS' && !e.altKey) {
        e.preventDefault()
        void save()
      } else if (e.key === 'Enter' && !document.querySelector('.sheet-layer') && !approval) {
        e.preventDefault()
        void run()
      } else if (e.altKey && ['KeyA', 'KeyR', 'KeyC', 'KeyS'].includes(e.code)) {
        e.preventDefault()
        addNode(({ KeyA: 'agent', KeyR: 'room', KeyC: 'check', KeyS: 'shell' } as const)[e.code as 'KeyA']!)
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && focusedCard && draft) {
        e.preventDefault()
        setDraft(moveNode(draft, focusedCard, e.key === 'ArrowUp' ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const graph = useMemo(() => (draft ? draftGraph(draft, profiles) : null), [draft, profiles])
  const problemsByNode = useMemo(() => {
    const m = new Map<string, ValidationError[]>()
    for (const p of problems) {
      if (!m.has(p.path)) m.set(p.path, [])
      m.get(p.path)!.push(p)
    }
    return m
  }, [problems])

  const scrollTo = (nodeId: string): void => {
    const el = cardRefs.current.get(nodeId)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setOutlined(nodeId)
      setTimeout(() => setOutlined((o) => (o === nodeId ? null : o)), 1600)
    }
  }

  if (loadError) {
    return (
      <div className="view">
        <Toolbar left={<Back />} title="Workflow" />
        <ErrorState error={loadError} />
      </div>
    )
  }
  if (!draft) {
    return (
      <div className="view">
        <Toolbar left={<Back />} title="Workflow" />
        <Loading />
      </div>
    )
  }

  const set = (d: WorkflowDraft): void => setDraft(d)
  return (
    <div className="view">
      <Toolbar
        left={<Back />}
        title={
          <input className="toolbar__name no-drag" value={draft.name} onChange={(e) => set({ ...draft, name: e.target.value })} spellCheck={false} aria-label="Workflow name" />
        }
        sub={
          <>
            {edited && <span className="edited-dot">● edited</span>}
            {origin && !approval && <OriginBadge origin={origin} />}
            {id && !approval && <SlackTriggerChip workflowId={id} />}
          </>
        }
      >
        {approval ? (
          <>
            <label className="approval__allow approval__allow--toolbar no-drag" title="Only this exact version. Any later change asks again.">
              <input type="checkbox" checked={allowRun} onChange={(e) => setAllowRun(e.target.checked)} />
              <span>Allow this agent to run it</span>
            </label>
            <Button onClick={() => void openApproval(approval.id)}>Back to card</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving} kbd="⌘S" title="Approve your edited version">
              {saving ? 'Approving…' : 'Approve & save'}
            </Button>
          </>
        ) : (
          <>
        <Button icon="clock" onClick={() => void schedule()}>
          Schedule
        </Button>
        <Button icon="slack" onClick={() => void slackTrigger()} title="Run this workflow when something happens in Slack">
          Slack trigger
        </Button>
        {id && (
          <IconButton
            icon="upload"
            label="Export .hive.json…"
            onClick={() =>
              void (async () => {
                if (edited && !(await save())) return
                const r = await attempt(() => hive.workflows.export({ id }), 'Export')
                if (r) toast(`Exported ${r.path.split('/').pop()}`)
              })()
            }
          />
        )}
        <Button onClick={() => void save()} disabled={saving || (!edited && !!id)} kbd="⌘S" title={problems.length ? problems.map((p) => p.message).join('\n') : undefined}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="primary" icon="play" onClick={() => void run()} kbd="⌘↵">
          Run
        </Button>
          </>
        )}
      </Toolbar>
      {approval && (
        <div className="banner banner--accent banner--bar">
          Proposed by {providerLabel(approval.adapter)} in {approval.ownerLabel}. Change anything, then <b>Approve &amp; save</b> saves your version
          {approval.flags.scheduleSentence ? ` and schedules it (${approval.flags.scheduleSentence})` : ''}. Nothing is saved until then.
        </div>
      )}
      <div className="editor">
        <div className="editor__main scroll">
          <div className="editor__meta">
            <label className="editor__meta-label">Description</label>
            <input className="input" value={draft.description} placeholder="What this workflow does" onChange={(e) => set({ ...draft, description: e.target.value })} />
            <label className="editor__meta-label">Inputs</label>
            <InputsEditor inputs={draft.inputs} onChange={(inputs) => set({ ...draft, inputs })} />
            <label className="editor__meta-label">Slack connection</label>
            <div>
              <label><input type="checkbox" checked={!!draft.slackTools} onChange={(e) => set({ ...draft, slackTools: e.target.checked, slackAgentPermissions: 'restricted' })} /> Use company Slack tools</label>
              {draft.slackTools && <>
                <select className="input" aria-label="Slack workflow agent permissions" value={draft.slackAgentPermissions ?? 'restricted'} onChange={(e) => set({ ...draft, slackAgentPermissions: e.target.value as 'restricted' | 'profile' })}>
                  <option value="restricted">Restricted · Claude only</option>
                  <option value="profile">Use agent profile permissions · Claude and Codex</option>
                </select>
                <p className="field-note">Profile permissions let agents write files and run commands while reading Slack. Replies still follow Slack approval rules. Slack-triggered runs keep their trigger’s access settings.</p>
              </>}
            </div>
            <WorkflowMemory nodes={draft.nodes} onChange={(nodes) => set({ ...draft, nodes })} />
            <WorktreeEditor draft={draft} repos={repos} onChange={set} problems={problemsByNode.get('worktree') ?? []} />
          </div>
          {draft.nodes.length === 0 && (
            <div className="empty empty--compact">
              <div className="empty__text">Add the first step.</div>
              <Button variant="primary" onClick={() => addNode('agent')}>
                + Agent
              </Button>
            </div>
          )}
          {draft.nodes.map((n, i) => (
            <NodeCard
              key={n.id}
              index={i}
              node={n}
              draft={draft}
              setDraft={set}
              profiles={profiles}
              providers={providers}
              repos={repos}
              problems={problemsByNode.get(n.id) ?? []}
              outlined={outlined === n.id}
              cardRef={(el) => (el ? cardRefs.current.set(n.id, el) : cardRefs.current.delete(n.id))}
              onFocus={() => setFocusedCard(n.id)}
            />
          ))}
          <div className="editor__add">
            <Button icon="plus" onClick={() => addNode('agent')} title="⌘⌥A">
              Agent
            </Button>
            <Button icon="plus" onClick={() => addNode('room')} title="⌘⌥R">
              Room
            </Button>
            <Button icon="plus" onClick={() => addNode('check')} title="⌘⌥C" disabled={!draft.nodes.some((n) => n.type === 'agent')}>
              Check
            </Button>
            <Button icon="plus" onClick={() => addNode('shell')} title="⌘⌥S">
              Shell
            </Button>
            <Button icon="plus" onClick={() => addNode('wait')} title="Re-run a command until it succeeds or matches">
              Wait
            </Button>
            <Button icon="plus" onClick={() => addNode('notify')} title="Mac notification, optionally a Slack message">
              Notify
            </Button>
          </div>
        </div>
        <div className="editor__preview">
          <div className="editor__preview-label">Preview</div>
          {graph && graph.nodes.length > 0 ? (
            <GraphView nodes={graph.nodes} edges={graph.edges} fitKey={`${draft.nodes.length}:${draft.nodes.map((n) => depsOf(n).join(',')).join('|')}`} onSelect={(ref) => ref.kind === 'wfnode' && scrollTo(ref.nodeId)} interactive />
          ) : (
            <div className="empty empty--compact">
              <div className="empty__text">Steps appear here.</div>
            </div>
          )}
        </div>
      </div>
      {problems.length > 0 && (
        <div className="problems">
          <span className="text-failed">
            ✕ {problems.length} problem{problems.length > 1 ? 's' : ''}
          </span>
          <span className="problems__first" onClick={() => scrollTo(problems[0]!.path)}>
            {problems[0]!.message}
          </span>
          <span className="flex1" />
          {problems.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const pid = await nativeMenu(problems.map((p, i) => ({ id: String(i), label: p.message })))
                if (pid) scrollTo(problems[Number(pid)]!.path)
              }}
            >
              Show all
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function Back(): React.JSX.Element {
  return (
    <button type="button" className="back-btn no-drag" onClick={() => goBack({ name: 'workflows' })}>
      <Icon name="chevronLeft" size={14} /> Workflows
    </button>
  )
}

// ---------- inputs ----------
function InputsEditor({ inputs, onChange }: { inputs: WorkflowInput[]; onChange: (v: WorkflowInput[]) => void }): React.JSX.Element {
  const [editing, setEditing] = useState<{ index: number; rect: DOMRect } | null>(null)
  const cur = editing ? inputs[editing.index] : null
  const patch = (p: Partial<WorkflowInput>): void => {
    if (!editing) return
    onChange(inputs.map((x, i) => (i === editing.index ? { ...x, ...p } : x)))
  }
  return (
    <div className="chips">
      {inputs.map((inp, i) => (
        <span key={i} className="chip chip--btn mono" onClick={(e) => setEditing({ index: i, rect: e.currentTarget.getBoundingClientRect() })} title={`{{inputs.${inp.name}}} · ${inp.type ?? 'text'}`}>
          {inp.name}
          {inp.type === 'repo' && <Icon name="folder" size={11} />}
          <button
            type="button"
            className="chip__x"
            aria-label={`Remove ${inp.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onChange(inputs.filter((_, j) => j !== i))
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        className="chip chip--add"
        onClick={(e) => {
          const taken = new Set(inputs.map((x) => x.name))
          let n = 1
          while (taken.has(`input${n}`)) n++
          const rect = e.currentTarget.getBoundingClientRect()
          onChange([...inputs, { name: `input${n}`, label: `Input ${n}`, type: 'text' }])
          setEditing({ index: inputs.length, rect })
        }}
      >
        + Input
      </button>
      {editing && cur && (
        <Popover anchor={editing.rect} onClose={() => setEditing(null)} width={280}>
          <div className="popover__form">
            <label>Name</label>
            <input className="input mono" autoFocus value={cur.name} onChange={(e) => patch({ name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })} />
            <label>Label</label>
            <input className="input" value={cur.label} onChange={(e) => patch({ label: e.target.value })} />
            <label>Type</label>
            <Segmented
              size="sm"
              items={[
                { value: 'text', label: 'Text' },
                { value: 'multiline', label: 'Long text' },
                { value: 'repo', label: 'Repository' },
                { value: 'boolean', label: 'Checkbox' }
              ]}
              value={cur.type ?? 'text'}
              onChange={(v) => patch(v === 'boolean' ? { type: 'boolean', default: cur.default === 'true' ? 'true' : 'false' } : { type: v as WorkflowInput['type'] })}
            />
            {cur.type === 'boolean' && (
              <>
                <label>Default</label>
                <label className="run-check">
                  <input type="checkbox" checked={cur.default === 'true'} onChange={(e) => patch({ default: e.target.checked ? 'true' : 'false' })} />
                  <span className="text-secondary mono">{cur.default === 'true' ? 'true' : 'false'}</span>
                </label>
              </>
            )}
            {cur.type !== 'repo' && cur.type !== 'boolean' && (
              <>
                <label>Default</label>
                <input className="input" value={cur.default ?? ''} onChange={(e) => patch({ default: e.target.value || undefined })} />
              </>
            )}
            <div className="text-tertiary mono">{`{{inputs.${cur.name}}}`}</div>
          </div>
        </Popover>
      )}
    </div>
  )
}

// ---------- node card ----------
interface CardProps {
  index: number
  node: WorkflowNode
  draft: WorkflowDraft
  setDraft: (d: WorkflowDraft) => void
  profiles: AgentProfile[]
  providers: ProviderInfo[]
  repos: Repo[]
  problems: ValidationError[]
  outlined: boolean
  cardRef: (el: HTMLDivElement | null) => void
  onFocus: () => void
}

function NodeCard({ index, node: n, draft, setDraft, profiles, providers, repos, problems, outlined, cardRef, onFocus }: CardProps): React.JSX.Element {
  const [idText, setIdText] = useState(n.id)
  const [collapsed, setCollapsed] = useState(false)
  const [afterPick, setAfterPick] = useState<DOMRect | null>(null)
  useEffect(() => setIdText(n.id), [n.id])
  const patch = (p: Partial<WorkflowNode>): void => setDraft(updateNode(draft, n.id, p))
  const suggestions = useMemo(() => templateSuggestions(draft, n.id), [draft, n.id])
  const agentProfiles = profiles.filter((p) => p.adapter !== 'shell')

  const commitId = (): void => {
    const next = slugify(idText)
    if (next === n.id) return setIdText(n.id)
    if (draft.nodes.some((x) => x.id === next)) {
      toast(`Step id “${next}” is taken`, 'error')
      return setIdText(n.id)
    }
    setDraft(renameNode(draft, n.id, next))
  }

  const menu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'dup', label: 'Duplicate' },
      { id: 'up', label: 'Move Up', accelerator: 'Cmd+Alt+Up', enabled: index > 0 },
      { id: 'down', label: 'Move Down', accelerator: 'Cmd+Alt+Down', enabled: index < draft.nodes.length - 1 },
      { id: 'collapse', label: collapsed ? 'Expand' : 'Collapse' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete Step' }
    ])
    if (id === 'dup') setDraft(duplicateNode(draft, n.id))
    if (id === 'up') setDraft(moveNode(draft, n.id, -1))
    if (id === 'down') setDraft(moveNode(draft, n.id, 1))
    if (id === 'collapse') setCollapsed(!collapsed)
    if (id === 'delete') setDraft(removeNode(draft, n.id))
  }

  const summary =
    n.type === 'agent'
      ? n.prompt
      : n.type === 'room'
        ? n.topic
        : n.type === 'check'
          ? n.command
            ? `$ ${n.command}`
            : n.criteria
          : n.type === 'notify'
            ? n.message
            : n.type === 'wait'
              ? `$ ${n.command} · every ${intervalLabel(n.intervalSec)}`
              : n.command

  return (
    <div
      ref={cardRef}
      className={`card ${outlined || problems.length ? 'card--problem' : ''} ${outlined ? 'card--flash' : ''}`}
      onFocusCapture={onFocus}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea, select')) return
        e.preventDefault()
        void menu()
      }}
    >
      <div className="card__head">
        <button type="button" className="card__twisty" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        </button>
        <span className="card__index">{index + 1}</span>
        <span className="card__glyph">{NODE_GLYPH[n.type]}</span>
        <span className="card__type">{NODE_LABEL[n.type]} ·</span>
        <input
          className="card__id mono"
          value={idText}
          onChange={(e) => setIdText(e.target.value)}
          onBlur={commitId}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          spellCheck={false}
          aria-label="Step id"
        />
        {n.isolate === 'worktree' && (
          <span className="card__branch" title="Runs in the run’s git worktree">
            ⎇ worktree
          </span>
        )}
        {collapsed && <span className="card__summary">{summary}</span>}
        <span className="flex1" />
        <IconButton icon="more" label="Step actions" onClick={() => void menu()} />
      </div>
      {!collapsed && (
        <div className="card__body">
          {n.type === 'agent' && (
            <>
              <Row label="Agent">
                <AgentSelect value={n.profileId} profiles={agentProfiles} providers={providers} onChange={(v) => patch({ profileId: v })} />
                <Hint text={missingHint(n.profileId, profiles, providers)} />
              </Row>
              <PermissionRow profileId={n.profileId} profiles={profiles} />
              <FolderRow node={n} draft={draft} repos={repos} onChange={(cwd) => patch({ cwd })} />
              <AfterRow node={n} draft={draft} setDraft={setDraft} anchor={afterPick} setAnchor={setAfterPick} />
              <Row label="Prompt" top>
                <TemplateTextArea value={n.prompt} onChange={(prompt) => patch({ prompt })} suggestions={suggestions} placeholder="What should the agent do? Type {{ for inputs and earlier outputs." />
              </Row>
            </>
          )}
          {n.type === 'shell' && (
            <>
              <Row label="Language">
                <Segmented
                  size="sm"
                  value={n.lang ?? 'sh'}
                  onChange={(lang) => patch({ lang: lang === 'sh' ? null : lang })}
                  items={[
                    { value: 'sh', label: 'Shell' },
                    { value: 'python', label: 'Python' },
                    { value: 'node', label: 'Node' }
                  ]}
                />
              </Row>
              <Row label={n.lang && n.lang !== 'sh' ? 'Script' : 'Command'} top={!!n.lang && n.lang !== 'sh'}>
                {n.lang && n.lang !== 'sh' ? (
                  <TemplateTextArea value={n.command} onChange={(command) => patch({ command })} suggestions={suggestions} placeholder={n.lang === 'python' ? 'import os\nprint(os.environ["HIVE_INPUT_QUERY"])' : 'console.log(process.env.HIVE_INPUT_QUERY)'} minRows={8} />
                ) : (
                  <TemplateTextArea value={n.command} onChange={(command) => patch({ command })} suggestions={suggestions} placeholder="npm test" singleLine minRows={1} />
                )}
              </Row>
              <Row label="">
                <span className="card__hint card__hint--muted">Inputs are env vars ($HIVE_INPUT_NAME), and so are your Keys. Files saved in $ARTIFACTS_DIR show up in Artifacts. Output = stdout.</span>
              </Row>
              <FolderRow node={n} draft={draft} repos={repos} onChange={(cwd) => patch({ cwd })} />
              <AfterRow node={n} draft={draft} setDraft={setDraft} anchor={afterPick} setAnchor={setAfterPick} />
            </>
          )}
          {n.type === 'check' && (
            <>
              <CheckBody n={n} draft={draft} patch={patch} profiles={profiles} providers={providers} suggestions={suggestions} repos={repos} />
              <AfterRow node={n} draft={draft} setDraft={setDraft} anchor={afterPick} setAnchor={setAfterPick} />
            </>
          )}
          {n.type === 'wait' && (
            <>
              <WaitBody n={n} patch={patch} suggestions={suggestions} />
              <FolderRow node={n} draft={draft} repos={repos} onChange={(cwd) => patch({ cwd })} />
              <AfterRow node={n} draft={draft} setDraft={setDraft} anchor={afterPick} setAnchor={setAfterPick} />
            </>
          )}
          {n.type === 'notify' && (
            <>
              <NotifyBody n={n} patch={patch} suggestions={suggestions} />
              <AfterRow node={n} draft={draft} setDraft={setDraft} anchor={afterPick} setAnchor={setAfterPick} />
            </>
          )}
          {n.type !== 'notify' && (
            <IsolateRow
              node={n}
              draft={draft}
              onChange={(isolate) => {
                const next = updateNode(draft, n.id, { isolate })
                // first isolated step: its folder becomes the workflow's worktree repo
                setDraft(isolate && !draft.worktree?.repo && n.cwd ? { ...next, worktree: { repo: n.cwd, base: null } } : next)
              }}
            />
          )}
          {n.type === 'room' && <RoomBody n={n} draft={draft} setDraft={setDraft} patch={patch} profiles={agentProfiles} providers={providers} suggestions={suggestions} repos={repos} anchor={afterPick} setAnchor={setAfterPick} />}
          <MemoryRow node={n} draft={draft} profiles={profiles} providers={providers} repos={repos} onChange={(memory) => patch({ memory })} />
          <Disclosure label="More">
            <Row label="Label">
              <input className="input" value={n.label} onChange={(e) => patch({ label: e.target.value })} />
            </Row>
            {n.type !== 'wait' && (
              <Row label="Timeout">
                <Stepper value={n.timeoutMin} min={1} max={600} onChange={(timeoutMin) => patch({ timeoutMin })} /> <span className="text-tertiary">minutes</span>
              </Row>
            )}
          </Disclosure>
          {problems.map((p, i) => (
            <div key={i} className="card__problem">
              ✕ {p.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ label, children, top }: { label: string; children: React.ReactNode; top?: boolean }): React.JSX.Element {
  return (
    <div className={`card__row ${top ? 'card__row--top' : ''}`}>
      <span className="card__label">{label}</span>
      <div className="card__ctl">{children}</div>
    </div>
  )
}
/** Permissions live on the agent profile; shown here as a plain choice instead of a "· bypass" suffix. */
function PermissionRow({ profileId, profiles }: { profileId: string | null; profiles: AgentProfile[] }): React.JSX.Element | null {
  const p = profiles.find((x) => x.id === profileId)
  if (!p || p.adapter === 'shell') return null
  const users = `Applies to every step that uses “${p.name}”.`
  return (
    <Row label="Permissions">
      <Segmented
        size="sm"
        items={[
          { value: 'bypass', label: 'Runs without asking' },
          { value: 'default', label: 'Stops if it needs permission' }
        ]}
        value={p.permissionMode}
        onChange={(permissionMode) => void attempt(() => hive.profiles.update({ id: p.id, permissionMode }), 'Change permissions').then((r) => r && refreshProfiles())}
      />
      <div className="field-note">{users}</div>
    </Row>
  )
}

/** One click for the whole workflow: every step that can use memory gets this mode (reviewer checks cap at Read). */
function WorkflowMemory({ nodes, onChange }: { nodes: WorkflowNode[]; onChange: (nodes: WorkflowNode[]) => void }): React.JSX.Element | null {
  const mode = workflowMemoryMode(nodes)
  if (mode === null) return null
  return (
    <>
      <label className="editor__meta-label">Memory</label>
      <div>
        <Segmented<MemoryMode>
          size="sm"
          items={(['off', 'read', 'read-write'] as const).map((m) => ({ value: m, label: MEMORY_MODE_LABEL[m] }))}
          value={mode === 'mixed' ? ('' as MemoryMode) : mode}
          onChange={(m) => onChange(applyMemoryToAll(nodes, m))}
        />
        <div className="field-note">
          {mode === 'mixed'
            ? 'Steps differ. Pick one to set every step; each step can still change its own.'
            : mode === 'read-write'
              ? 'Every step reads shared memory and can record what it learns (reviewer checks read only).'
              : mode === 'read'
                ? 'Every step starts with what agents know about its repository and can search it.'
                : 'No step uses shared memory.'}
        </div>
      </div>
    </>
  )
}

/** Memory: Off | Read | Read & write (MEMORY.md §10.6). Hidden where memory can't apply (shell, command checks). */
function MemoryRow({ node, draft, profiles, providers, repos, onChange }: { node: WorkflowNode; draft: WorkflowDraft; profiles: AgentProfile[]; providers: ProviderInfo[]; repos: Repo[]; onChange: (m: MemoryMode | undefined) => void }): React.JSX.Element | null {
  const allowed = allowedMemoryModes(node)
  if (allowed.length < 2) return null
  const value: MemoryMode = node.memory ?? 'off'
  const profileIds = node.type === 'room' ? node.participants.map((p) => p.profileId) : node.type === 'agent' || node.type === 'check' ? [node.profileId] : []
  const adapters = profileIds.map((id) => profiles.find((p) => p.id === id)?.adapter).filter((a): a is AdapterId => !!a && a !== 'shell')
  const injected = value !== 'off' ? transportNote(adapters, providers) : null
  const cursorOnly = adapters.length > 0 && adapters.every((a) => providers.find((p) => p.id === a)?.memory === 'inject')
  // the folder decides which project memory a step reads and writes; a check without a folder uses its target's
  const cwd = node.type === 'check' && !node.cwd ? (draft.nodes.find((x) => x.id === node.target)?.cwd ?? null) : node.cwd
  const repoInput = cwd ? /^\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/.exec(cwd)?.[1] : undefined
  const target = !cwd ? null : repos.find((r) => r.id === cwd)?.name ?? (repoInput ? `the repository picked for {{inputs.${repoInput}}}` : 'the folder’s repository')
  const hint =
    value === 'off'
      ? 'Off: this step neither sees nor writes shared memory.'
      : !target
        ? 'No repository folder: reads global memory only, never writes.'
        : value === 'read'
          ? `Gets a brief of what agents know about ${target}${injected ? '' : ', plus memory_search'}.`
          : cursorOnly
            ? `Reads ${target} memory (injected brief). Writes aren’t available for this agent.`
            : `Reads and writes ${target} project memory. Everything it writes shows up on the Memory page.`
  return (
    <Row label="Memory">
      <Segmented<MemoryMode>
        size="sm"
        items={allowed.map((m) => ({ value: m, label: MEMORY_MODE_LABEL[m] }))}
        value={allowed.includes(value) ? value : 'off'}
        onChange={(m) => onChange(m === 'off' ? undefined : m)}
      />
      {injected && value !== 'off' && <span className="mchip mchip--mini" title={injected}>injected</span>}
      <div className="field-note">{hint}</div>
    </Row>
  )
}

function Hint({ text }: { text: string | null }): React.JSX.Element | null {
  return text ? <div className="card__hint">⚠ {text}</div> : null
}

function FolderRow({ node, draft, repos, onChange }: { node: WorkflowNode; draft: WorkflowDraft; repos: Repo[]; onChange: (v: string | null) => void }): React.JSX.Element {
  const repoInputs = draft.inputs.filter((i) => i.type === 'repo')
  const v = node.cwd ?? ''
  const known = v === '' || repoInputs.some((i) => `{{inputs.${i.name}}}` === v) || repos.some((r) => r.id === v)
  return (
    <Row label="Folder">
      <select className="input" value={v} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{node.type === 'check' ? 'Same as the checked step' : 'Scratch folder'}</option>
        {repoInputs.length > 0 && (
          <optgroup label="Inputs">
            {repoInputs.map((i) => (
              <option key={i.name} value={`{{inputs.${i.name}}}`}>{`{{inputs.${i.name}}}`}</option>
            ))}
          </optgroup>
        )}
        {repos.length > 0 && (
          <optgroup label="Repositories">
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </optgroup>
        )}
        {!known && <option value={v}>{v}</option>}
      </select>
    </Row>
  )
}

function AfterRow({ node, draft, setDraft, anchor, setAnchor }: { node: WorkflowNode; draft: WorkflowDraft; setDraft: (d: WorkflowDraft) => void; anchor: DOMRect | null; setAnchor: (r: DOMRect | null) => void }): React.JSX.Element {
  const others = draft.nodes.filter((x) => x.id !== node.id)
  const toggle = (dep: string): void => {
    const after = node.after.includes(dep) ? node.after.filter((a) => a !== dep) : [...node.after, dep]
    setDraft(updateNode(draft, node.id, { after }))
  }
  const implicit = implicitDeps(node)
  return (
    <Row label="After">
      <div className="chips">
        {node.after.length === 0 && implicit.length === 0 && <span className="text-tertiary">(none — starts right away)</span>}
        {implicit.map((x) => (
          <span key={`i:${x.id}`} className="chip mono chip--implicit" title={`Runs after ${x.id} because it ${x.why}`}>
            {x.id}
            <span className="text-tertiary"> · {x.why}</span>
          </span>
        ))}
        {node.after.map((a) => (
          <span key={a} className="chip mono">
            {a}
            <button type="button" className="chip__x" onClick={() => toggle(a)} aria-label={`Remove ${a}`}>
              ×
            </button>
          </span>
        ))}
        {others.length > 0 && (
          <button type="button" className="chip chip--add" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} aria-label="Add dependency">
            +
          </button>
        )}
      </div>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="popover__list">
            {others.map((o) => {
              const on = node.after.includes(o.id)
              const cyc = !on && wouldCycle(draft.nodes, node.id, o.id)
              return (
                <button key={o.id} type="button" className="popover__item" disabled={cyc} title={cyc ? `${o.id} already runs after ${node.id}` : undefined} onClick={() => toggle(o.id)}>
                  <span className="popover__check">{on ? '✓' : ''}</span>
                  <span className="mono">{o.id}</span>
                  {cyc && <span className="text-tertiary">would loop</span>}
                </button>
              )
            })}
          </div>
        </Popover>
      )}
    </Row>
  )
}

function CheckBody({ n, draft, patch, profiles, providers, suggestions, repos }: { n: CheckNode; draft: WorkflowDraft; patch: (p: Partial<WorkflowNode>) => void; profiles: AgentProfile[]; providers: ProviderInfo[]; suggestions: string[]; repos: Repo[] }): React.JSX.Element {
  const mode = n.command !== null ? 'command' : 'agent'
  const targets = draft.nodes.filter((x) => x.type === 'agent')
  const agentProfiles = profiles.filter((p) => p.adapter !== 'shell')
  return (
    <>
      <Row label="Reviewer">
        <Segmented
          size="sm"
          items={[
            { value: 'agent', label: 'Agent' },
            { value: 'command', label: 'Command' }
          ]}
          value={mode}
          onChange={(m) => (m === 'command' ? patch({ command: n.command ?? 'npm test', profileId: null, memory: undefined } as Partial<CheckNode>) : patch({ command: null, profileId: n.profileId ?? agentProfiles[0]?.id ?? null } as Partial<CheckNode>))}
        />
      </Row>
      {mode === 'agent' ? (
        <Row label="Agent">
          <AgentSelect value={n.profileId} profiles={agentProfiles} providers={providers} onChange={(v) => patch({ profileId: v } as Partial<CheckNode>)} />
          <Hint text={missingHint(n.profileId, profiles, providers)} />
        </Row>
      ) : null}
      {mode === 'agent' && <PermissionRow profileId={n.profileId} profiles={profiles} />}
      {mode === 'agent' ? null : (
        <Row label="Command">
          <TemplateTextArea value={n.command ?? ''} onChange={(command) => patch({ command } as Partial<CheckNode>)} suggestions={suggestions} placeholder="npm test" singleLine minRows={1} />
          <div className="card__hint card__hint--muted">Exit 0 = PASS. On fail, the last 8 KB of output goes back to the agent.</div>
        </Row>
      )}
      <Row label="Checks">
        <select className="input input--auto" value={n.target} onChange={(e) => patch({ target: e.target.value } as Partial<CheckNode>)}>
          {!n.target && <option value="">Choose a step…</option>}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id}
            </option>
          ))}
        </select>
        <span className="card__inline-label">Retries</span>
        <Stepper value={n.maxRetries} min={0} max={5} onChange={(maxRetries) => patch({ maxRetries } as Partial<CheckNode>)} />
      </Row>
      {mode === 'agent' && (
        <Row label="Criteria" top>
          <TemplateTextArea value={n.criteria} onChange={(criteria) => patch({ criteria } as Partial<CheckNode>)} suggestions={suggestions} placeholder="Tests pass, no TODO left, matches the task…" minRows={2} />
        </Row>
      )}
      <FolderRow node={n} draft={draft} repos={repos} onChange={(cwd) => patch({ cwd })} />
    </>
  )
}

function RoomBody({
  n,
  draft,
  setDraft,
  patch,
  profiles,
  providers,
  suggestions,
  repos,
  anchor,
  setAnchor
}: {
  n: RoomNode
  draft: WorkflowDraft
  setDraft: (d: WorkflowDraft) => void
  patch: (p: Partial<WorkflowNode>) => void
  profiles: AgentProfile[]
  providers: ProviderInfo[]
  suggestions: string[]
  repos: Repo[]
  anchor: DOMRect | null
  setAnchor: (r: DOMRect | null) => void
}): React.JSX.Element {
  const setP = (participants: RoomNode['participants']): void => patch({ participants } as Partial<RoomNode>)
  return (
    <>
      <Row label="Participants" top>
        <div className="participants">
          {n.participants.map((p, i) => (
            <div key={i} className="participants__row">
              <input className="input participants__label" value={p.label} placeholder="Label" onChange={(e) => setP(n.participants.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <AgentSelect value={p.profileId} profiles={profiles} providers={providers} onChange={(v) => setP(n.participants.map((x, j) => (j === i ? { ...x, profileId: v } : x)))} />
              <IconButton icon="close" label="Remove participant" disabled={n.participants.length <= 2} onClick={() => setP(n.participants.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button size="sm" icon="plus" onClick={() => setP([...n.participants, { profileId: profiles[0]?.id ?? '', label: `Agent ${n.participants.length + 1}` }])}>
            Participant
          </Button>
        </div>
      </Row>
      <Row label="Topic" top>
        <TemplateTextArea value={n.topic} onChange={(topic) => patch({ topic } as Partial<RoomNode>)} suggestions={suggestions} placeholder="What should they discuss?" />
      </Row>
      <Row label="Rounds">
        <Stepper value={n.rounds} min={1} max={10} onChange={(rounds) => patch({ rounds } as Partial<RoomNode>)} />
        <span className="card__inline-label">Result</span>
        <Segmented
          size="sm"
          items={[
            { value: 'last', label: 'Last reply' },
            { value: 'summary', label: `Summary by ${n.participants[0]?.label || 'first'}` }
          ]}
          value={n.final}
          onChange={(final) => patch({ final } as Partial<RoomNode>)}
        />
      </Row>
      <FolderRow node={n} draft={draft} repos={repos} onChange={(cwd) => patch({ cwd })} />
      <AfterRow node={n} draft={draft} setDraft={setDraft} anchor={anchor} setAnchor={setAnchor} />
    </>
  )
}

// ---------- authoring additions (AUTHORING.md §2.5, §4, §6, §7) ----------

/** "Created by Claude in example-project · Claude" with a jump to the session that asked. */
function OriginBadge({ origin }: { origin: WorkflowOrigin }): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const sess = origin.sessionId ? sessions.find((x) => x.id === origin.sessionId) : undefined
  const detail = originDetail(origin, providerLabel)
  const text = originLine(origin, providerLabel)
  return (
    <span className="origin-badge no-drag" title={[text, detail, `Approved ${new Date(origin.approvedAt).toLocaleString()}`].filter(Boolean).join('\n')}>
      <span className="origin-badge__glyph">✦</span>
      {sess ? (
        <button type="button" className="link-btn" onClick={() => focusSession(sess.id)}>
          {text}
        </button>
      ) : (
        text
      )}
      {detail && <span className="text-tertiary"> · {detail}</span>}
    </span>
  )
}

/** Workflow-level worktree (§6): which repo each run branches from. Steps opt in with "Run in worktree". */
function WorktreeEditor({ draft, repos, onChange, problems }: { draft: WorkflowDraft; repos: Repo[]; onChange: (d: WorkflowDraft) => void; problems: ValidationError[] }): React.JSX.Element | null {
  const isolated = draft.nodes.filter((n) => n.isolate === 'worktree').length
  if (!draft.worktree && !isolated) return null
  const repoInputs = draft.inputs.filter((i) => i.type === 'repo')
  const v = draft.worktree?.repo ?? ''
  const set = (repo: string): void => onChange({ ...draft, worktree: repo ? { repo, base: draft.worktree?.base ?? null } : null })
  return (
    <>
      <label className="editor__meta-label">Worktree</label>
      <div>
        <div className="editor__worktree">
          <select className="input input--auto" value={v} onChange={(e) => set(e.target.value)} aria-label="Worktree repository">
            <option value="">No worktree</option>
            {repoInputs.length > 0 && (
              <optgroup label="Inputs">
                {repoInputs.map((i) => (
                  <option key={i.name} value={`{{inputs.${i.name}}}`}>{`{{inputs.${i.name}}}`}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Repositories">
              {repos
                .filter((r) => r.isGit)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </optgroup>
          </select>
          {draft.worktree && (
            <input
              className="input input--sm editor__base mono"
              value={draft.worktree.base ?? ''}
              placeholder="default branch"
              spellCheck={false}
              onChange={(e) => onChange({ ...draft, worktree: { repo: draft.worktree!.repo, base: e.target.value.trim() || null } })}
              aria-label="Base branch"
              title="Branch the worktree starts from. Empty = the repository’s default branch."
            />
          )}
        </div>
        <div className="field-note">
          {draft.worktree
            ? `Each run gets its own branch hive/<workflow>-<run> in a separate folder; your checkout is never touched. ${isolated} step${isolated === 1 ? '' : 's'} run${isolated === 1 ? 's' : ''} there. Pushes to the default branch are blocked.`
            : 'Some steps want a worktree: pick the repository to branch from.'}
        </div>
        {problems.map((p, i) => (
          <div key={i} className="card__problem">
            ✕ {p.message}
          </div>
        ))}
      </div>
    </>
  )
}

/** Per-step "Run in worktree" (isolate: 'worktree'). Turning it on without a workflow worktree picks a repo for you. */
function IsolateRow({ node, draft, onChange }: { node: WorkflowNode; draft: WorkflowDraft; onChange: (v: 'worktree' | null) => void }): React.JSX.Element {
  const on = node.isolate === 'worktree'
  return (
    <Row label="Worktree">
      <Segmented
        size="sm"
        items={[
          { value: 'no', label: 'Folder' },
          { value: 'yes', label: 'Run in worktree' }
        ]}
        value={on ? 'yes' : 'no'}
        onChange={(v) => onChange(v === 'yes' ? 'worktree' : null)}
      />
      {on && !draft.worktree?.repo && <div className="card__hint">⚠ Pick the worktree repository at the top of the workflow.</div>}
      {on && draft.worktree?.repo && <div className="field-note">Runs in this run’s branch; $HIVE_WORKTREE and {'{{WORKTREE_DIR}}'} point there.</div>}
    </Row>
  )
}

function WaitBody({ n, patch, suggestions }: { n: WaitNode; patch: (p: Partial<WorkflowNode>) => void; suggestions: string[] }): React.JSX.Element {
  const p = (x: Partial<WaitNode>): void => patch(x as Partial<WorkflowNode>)
  return (
    <>
      <Row label="Command">
        <TemplateTextArea value={n.command} onChange={(command) => p({ command })} suggestions={suggestions} placeholder={'gh pr view 12 --json reviews -q \'.reviews | length\''} singleLine minRows={1} />
      </Row>
      <Row label="Until">
        <Segmented
          size="sm"
          items={[
            { value: 'exit0', label: 'It exits 0' },
            { value: 'match', label: 'Output matches' }
          ]}
          value={n.until}
          onChange={(until) => p({ until, pattern: until === 'match' ? (n.pattern ?? '') : n.pattern })}
        />
        {n.until === 'match' && (
          <input
            className="input input--sm mono wait__pattern"
            value={n.pattern ?? ''}
            placeholder="^[1-9][0-9]*$"
            spellCheck={false}
            maxLength={500}
            onChange={(e) => p({ pattern: e.target.value })}
            aria-label="Regular expression"
            title="JavaScript regular expression, tested against the command’s output (multiline)"
          />
        )}
      </Row>
      <Row label="Every">
        <Stepper value={n.intervalSec} min={5} max={3600} onChange={(intervalSec) => p({ intervalSec })} label="Seconds between tries" /> <span className="text-tertiary">seconds</span>
        <span className="card__inline-label">Give up after</span>
        <Stepper value={n.timeoutMin} min={1} max={1440} onChange={(timeoutMin) => p({ timeoutMin })} label="Minutes" /> <span className="text-tertiary">min, then</span>
        <Segmented
          size="sm"
          items={[
            { value: 'fail', label: 'Fail' },
            { value: 'continue', label: 'Continue' }
          ]}
          value={n.onTimeout}
          onChange={(onTimeout) => p({ onTimeout })}
        />
      </Row>
      <div className="field-note card__note">Output is the last try’s stdout. A last line HIVE_STOP: &lt;reason&gt; ends the run as “nothing to do”.</div>
    </>
  )
}

function NotifyBody({ n, patch, suggestions }: { n: NotifyNode; patch: (p: Partial<WorkflowNode>) => void; suggestions: string[] }): React.JSX.Element {
  const alertUser = useStore((s) => s.settings?.slackAlertUserId ?? null)
  const slackStatus = useSlack((s) => s.status)
  const users = useSlack((s) => s.users)
  const channels = useSlack((s) => s.channels)
  const p = (x: Partial<NotifyNode>): void => patch(x as Partial<WorkflowNode>)
  const target = notifySlackOf(n)
  const choice = notifyChoice(target)
  const connected = isSetUp(slackStatus)
  const chan = target?.kind === 'channel' ? channels.find((c) => c.id === target.channel) : undefined
  return (
    <>
      <Row label="Title">
        <TemplateTextArea value={n.title} onChange={(title) => p({ title })} suggestions={suggestions} placeholder="PR roundup" singleLine minRows={1} />
      </Row>
      <Row label="Message" top>
        <TemplateTextArea value={n.message} onChange={(message) => p({ message })} suggestions={suggestions} placeholder="{{roundup.output}}" minRows={2} />
      </Row>
      <Row label="Send to Slack">
        <Segmented<NotifyChoice>
          size="sm"
          items={[
            { value: 'off', label: 'Off' },
            { value: 'me', label: 'Me (DM)' },
            { value: 'channel', label: 'Channel' }
          ]}
          value={choice}
          onChange={(v) => p({ slack: v === 'off' ? null : v === 'me' ? { kind: 'me' } : { kind: 'channel', channel: target?.kind === 'channel' ? target.channel : '' } })}
        />
        {choice === 'channel' && <ChannelSelect value={target?.kind === 'channel' && target.channel ? target.channel : null} onChange={(channel) => p({ slack: { kind: 'channel', channel } })} />}
      </Row>
      <div className="field-note card__note">
        A Mac notification is always posted.{' '}
        {!target ? null : !connected ? (
          <>
            Slack isn’t connected yet, so it sends the Mac notification only.{' '}
            <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
              Connect Slack
            </button>
            .
          </>
        ) : target.kind === 'me' ? (
          alertUser ? (
            <>DMs {userName(users[alertUser], alertUser)} on Slack.</>
          ) : (
            <>
              No alert person yet: it sends the Mac notification only.{' '}
              <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'notifications', focus: 'slackAlerts' })}>
                Pick yourself in Settings
              </button>
              .
            </>
          )
        ) : !target.channel ? (
          <span className="text-failed">Pick a channel.</span>
        ) : chan && !chan.isMember ? (
          <span className="text-warning">@{slackStatus?.workspace?.botName ?? 'hive'} isn’t in {channelLabel(chan)}: join it on the Slack page first.</span>
        ) : (
          <>Posts in {chan ? channelLabel(chan) : target.channel}.</>
        )}
      </div>
      {n.migratedFrom === 'imessage' && (
        <div className="banner banner--accent notify-migrated">
          This node used to text you on iMessage. It now sends a Slack DM once Slack is connected and you pick yourself in Settings › Notifications.
          <button type="button" className="link-btn" onClick={() => p({ migratedFrom: null })}>
            Got it
          </button>
        </div>
      )}
    </>
  )
}
