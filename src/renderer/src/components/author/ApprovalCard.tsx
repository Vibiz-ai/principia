/**
 * Approval card (AUTHORING.md §2.2, PO2): what an agent asked Principia to save, schedule or run, and one button that does
 * exactly that. Shown pinned above the asking session's terminal, in the Agents hub, and from notification clicks.
 * Commands are always shown in full; nothing runs or persists until the user clicks.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AuthorDraft, AuthorDraftDetail } from '@shared/authoring'
import type { ValidationError } from '@shared/types'
import { DraftGraph } from './DraftGraph'
import { Button, Kbd, RelativeTime } from '../ui'
import { Icon } from '../Icon'
import { ProviderDot } from '../ui'
import { computeDiff, flagChips, kindVerb, metaChanges, nodeLines, primaryLabel, scheduleHint, wantsSlackMe, willRunNow, type NodeLine } from '../../lib/authoring'
import { absoluteWithDay } from '../../lib/time'
import { errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { decideDraft, editDraftInEditor, outcomeText } from '../../state/authoring'
import { focusSession, navigate, providerLabel, toast, updateSettings, useStore } from '../../state/store'
import { isSetUp, useSlack } from '../../state/slack'
import { replyModeRow, triggerSentence, userName } from '../../lib/slack'
import { useNamer } from '../slack/TriggerEditor'
import { UserPicker } from '../slack/bits'

function inTerminal(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.('.xterm')
}

export function ApprovalCard({
  draft: d,
  hotkeys = false,
  compact = false,
  showOwner = true
}: {
  draft: AuthorDraft
  /** ⌘↩ approves, ⌘⌫ rejects (one card at a time). */
  hotkeys?: boolean
  /** Pane mode: graph + node list start collapsed and scroll inside the card. */
  compact?: boolean
  /** Hub: show which session asked, with a jump link. */
  showOwner?: boolean
}): React.JSX.Element {
  const profiles = useStore((s) => s.profiles)
  const repos = useStore((s) => s.repos)
  const sessions = useStore((s) => s.sessions)
  const alertUser = useStore((s) => s.settings?.slackAlertUserId ?? null)
  const slackStatus = useSlack((s) => s.status)
  const namer = useNamer()
  const focus = useStore((s) => s.approvalFocus)
  const [detail, setDetail] = useState<AuthorDraftDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [allowRun, setAllowRun] = useState(false)
  const [open, setOpen] = useState(!compact)
  const [errors, setErrors] = useState<ValidationError[]>([])
  const [autoAck, setAutoAck] = useState(false)
  const [unsafeAck, setUnsafeAck] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pending = d.status === 'pending'

  const load = (): void => {
    hive.author.get({ id: d.id }).then(
      (x) => {
        setDetail(x)
        setLoadError(null)
      },
      (e) => setLoadError(errorMessage(e))
    )
  }
  // detail is fetched once per draft version; author:updated carries the summary only
  useEffect(load, [d.id, d.status])
  useHiveEvent('data:changed', ({ domain }) => domain === 'workflows' && d.kind === 'update' && pending && load())

  // a notification click for this draft brings it into view and opens the details
  useEffect(() => {
    if (focus?.draftId !== d.id) return
    setOpen(true)
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  const flags = detail?.flags ?? d.flags
  const label = primaryLabel({ kind: d.kind, flags, schedule: detail?.schedule ?? null, scheduleRequest: detail?.scheduleRequest ?? null, runNow: detail?.runNow ?? null })
  const chips = useMemo(() => flagChips(flags, repos, (iso) => absoluteWithDay(iso)), [flags, repos])
  const diff = detail ? (detail.diff ?? computeDiff(detail.base, detail.draft)) : null
  const meta = useMemo(() => metaChanges(detail?.base ?? null, detail?.draft ?? null), [detail?.base, detail?.draft])
  const inputs = d.kind === 'run' ? (detail?.run?.inputs ?? flags.inputs) : (detail?.runNow?.inputs ?? (willRunNow({ kind: d.kind, flags, runNow: detail?.runNow ?? null }) ? flags.inputs : null))
  const lines = useMemo(() => (detail?.draft ? nodeLines(detail.draft, profiles, repos, inputs) : []), [detail?.draft, profiles, repos, inputs])
  const needsAlertUser = (flags.slackAlertUserMissing ?? wantsSlackMe(detail?.draft ?? null)) && !alertUser
  // SLACK.md §9.5: the trigger's reply mode is its own row, never a chip; auto needs an explicit tick
  const trig = detail?.slackTrigger ?? null
  const trigFlag = flags.slackTrigger ?? (trig ? { sentence: triggerSentence(trig, namer), replyMode: trig.reply.mode, autoChannels: trig.reply.autoChannels } : null)
  const isAuto = trigFlag?.replyMode === 'auto'
  // SLACK.md SA2: full agent permissions on a Slack trigger are red and need their own tick
  const isUnsafe = !!(trigFlag?.fullPermissions ?? trig?.access?.fullPermissions)
  const trigKeys = trigFlag?.secretNames ?? trig?.access?.secretNames ?? []
  // Slack reads beyond the triggering conversation (default none; never DMs)
  const trigReads = trigFlag?.readChannels ?? (trig?.access?.readChannels ?? []).map((id) => namer.channel(id))
  const needsTick = (isAuto && !autoAck) || (isUnsafe && !unsafeAck)
  const trigRow = trigFlag ? replyModeRow(trigFlag.replyMode, trigFlag.autoChannels, trig?.limits?.maxRunsPerThreadPerHour ?? 4, namer) : null
  const approveLabel = isAuto ? 'Approve with auto-reply' : label
  const sched = detail?.scheduleRequest ?? null
  const canEdit = (d.kind === 'create' || d.kind === 'update') && !!detail?.draft
  const owner = d.sessionId ? sessions.find((s) => s.id === d.sessionId) : undefined

  const approve = async (): Promise<void> => {
    if (!pending || busy || needsTick) return
    setBusy(true)
    setErrors([])
    const r = await decideDraft({ id: d.id, decision: 'approve', allowRun: canEdit ? allowRun : undefined })
    setBusy(false)
    if (r.errors) setErrors(r.errors)
  }
  const reject = async (): Promise<void> => {
    if (!pending || busy) return
    setBusy(true)
    await decideDraft({ id: d.id, decision: 'reject', note: note.trim() || undefined })
    setBusy(false)
  }
  const pickAlertUser = async (id: string, name: string): Promise<void> => {
    await updateSettings({ slackAlertUserId: id })
    toast(`Alerts go to ${name} on Slack`)
  }

  useEffect(() => {
    if (!hotkeys || !pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.altKey || e.ctrlKey || inTerminal(e.target)) return
      if (document.querySelector('.sheet-layer')) return
      if (e.key === 'Enter') {
        e.preventDefault()
        void approve()
      } else if (e.key === 'Backspace' && !(e.target instanceof HTMLInputElement && e.target.value) && !(e.target instanceof HTMLTextAreaElement && e.target.value)) {
        e.preventDefault()
        if (!noteOpen) setNoteOpen(true)
        else void reject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotkeys, pending, busy, note, noteOpen, allowRun, autoAck, isAuto, unsafeAck, isUnsafe])

  return (
    <div ref={ref} className={`approval ${compact ? 'approval--compact' : ''} ${pending ? '' : 'is-closed'}`} role="group" aria-label={`${kindVerb(d.kind)}: ${d.workflowName}`}>
      <div className="approval__head">
        <span className="approval__badge">{kindVerb(d.kind)}</span>
        <span className="approval__name" title={d.workflowName}>
          {d.workflowName}
        </span>
        <span className="flex1" />
        <span className="approval__who text-tertiary">
          <ProviderDot adapter={d.adapter} /> {providerLabel(d.adapter)}
          {showOwner && (
            <>
              {' · '}
              {owner ? (
                <button type="button" className="link-btn" onClick={() => focusSession(owner.id)} title="Open the session that asked">
                  {d.ownerLabel}
                </button>
              ) : (
                d.ownerLabel
              )}
            </>
          )}
          {' · '}
          <RelativeTime iso={d.createdAt} />
        </span>
      </div>

      {d.summary && <div className="approval__summary selectable">{d.summary}</div>}

      {chips.length > 0 && (
        <div className="approval__flags">
          {chips.map((c) => (
            <span key={c.key} className={`aflag aflag--${c.tone}`} title={c.title}>
              {c.text}
            </span>
          ))}
        </div>
      )}

      {sched && sched.next.length > 0 && (
        <div className="approval__line text-secondary">
          <Icon name="clock" size={12} /> Next runs: {sched.next.slice(0, 3).map((n) => absoluteWithDay(n)).join(' · ')}
        </div>
      )}

      {inputs && Object.keys(inputs).length > 0 && (
        <div className="approval__inputs kv">
          {Object.entries(inputs).map(([k, v]) => (
            <span key={k} className="kv__pair">
              <span className="text-tertiary">{k}</span>
              <span className={`selectable kv__val ${(flags.shellInputs ?? []).includes(k) ? 'mono' : ''}`} title={v}>
                {repos.find((r) => r.id === v)?.name ?? v}
              </span>
            </span>
          ))}
        </div>
      )}
      {d.kind === 'run' && detail?.run?.reason && <div className="approval__line text-secondary selectable">Why: {detail.run.reason}</div>}

      {meta.length > 0 && <div className="approval__line text-secondary">{meta.join(' · ')}</div>}

      {detail?.draft && (
        <>
          <button type="button" className="disclosure__btn approval__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> {open ? 'Hide steps' : `Show ${lines.length} step${lines.length === 1 ? '' : 's'}`}
            {!open && flags.shellCommands > 0 && <span className="text-tertiary"> · {flags.shellCommands} command{flags.shellCommands === 1 ? '' : 's'}</span>}
          </button>
          {open && (
            <div className="approval__details">
              <DraftGraph draft={detail.draft} base={detail.base} diff={d.kind === 'update' ? diff : null} profiles={profiles} height={compact ? 150 : 190} />
              <div className="approval__nodes">
                {lines.map((l) => (
                  <NodeLineRow key={l.id} line={l} diff={d.kind === 'update' && diff ? (diff.added.includes(l.id) ? 'added' : diff.changed.includes(l.id) ? 'changed' : null) : null} />
                ))}
                {d.kind === 'update' && diff && diff.removed.length > 0 && <div className="approval__removed text-tertiary">Removed: {diff.removed.join(', ')}</div>}
              </div>
            </div>
          )}
        </>
      )}
      {!detail && loadError && pending && <div className="approval__line text-tertiary">Couldn’t load the details: {loadError}</div>}

      {d.warnings.length > 0 && (
        <ul className="approval__warnings">
          {d.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <ul className="approval__errors">
          {errors.map((e, i) => (
            <li key={i}>✕ {e.message}</li>
          ))}
        </ul>
      )}

      {trigFlag && trigRow && (
        <div className={`approval__slack ${isUnsafe ? 'approval__slack--unsafe' : trigRow.tone === 'amber' ? 'approval__slack--auto' : ''}`} data-slack-trigger="" data-reply-mode={trigFlag.replyMode} data-unsafe-access={isUnsafe ? '' : undefined}>
          <div className="approval__slack-head">
            <span className="approval__slack-tag">Slack trigger</span>
            <span className="selectable">{trigFlag.sentence}</span>
          </div>
          <div className="approval__slack-mode" data-slack-reply-row="">{trigRow.text}</div>
          {trig && (trig.match.keywords.length > 0 || trig.match.regex || trig.match.fromUsers.length > 0) && (
            <div className="text-tertiary">
              Filters: {[trig.match.keywords.length ? `keywords ${trig.match.keywords.map((k) => `“${k}”`).join(', ')}` : null, trig.match.regex ? `regex /${trig.match.regex}/` : null, trig.match.fromUsers.length ? `from ${trig.match.fromUsers.map(namer.user).join(', ')}` : null].filter(Boolean).join(' · ')}
            </div>
          )}
          {trig && (
            <div className="text-tertiary">
              Waits {trig.limits?.debounceSec ?? (trig.match.on.includes('message') ? 15 : 3)} s for more messages · up to {trig.limits?.maxRunsPerThreadPerHour ?? 4} runs per thread per hour
            </div>
          )}
          {isUnsafe ? (
            <div className="approval__slack-unsafe" data-slack-access="unsafe">
              UNSAFE: full agent permissions. Anyone who can post in these channels can steer agents that run shell commands, edit files and use the web on this Mac.
            </div>
          ) : (
            <div className="text-tertiary" data-slack-access="restricted">
              Agents run restricted: Claude only, read files in their folder and use Slack tools; no shell, file edits or web.
            </div>
          )}
          <div className="text-tertiary" data-slack-keys="">
            {trigKeys.length ? `Keys: ${trigKeys.join(', ')}` : 'No keys from the vault'}
          </div>
          <div className="text-tertiary" data-slack-reads="">
            {trigReads.length
              ? `Slack reads: the conversation that started the run, plus ${trigReads.join(', ')}`
              : 'Slack reads: only the conversation that started the run'}
            {' · replies only in that thread'}
          </div>
          {pending && isUnsafe && (
            <label className="approval__allow approval__allow--auto">
              <input type="checkbox" checked={unsafeAck} onChange={(e) => setUnsafeAck(e.target.checked)} />
              <span>I understand Slack messages can make these agents run commands on this Mac</span>
            </label>
          )}
          {pending && isAuto && (
            <label className="approval__allow approval__allow--auto">
              <input type="checkbox" checked={autoAck} onChange={(e) => setAutoAck(e.target.checked)} />
              <span>I understand replies are posted without my review</span>
            </label>
          )}
        </div>
      )}

      {pending && flags.slackNotConnected && (trigFlag || wantsSlackMe(detail?.draft ?? null) || (flags.slackAlerts ?? []).length > 0) && (
        <div className="approval__line text-secondary">
          <Icon name="warning" size={12} /> Slack isn’t connected: alerts are Mac-only{trigFlag ? ' and the trigger is saved off' : ''} until you{' '}
          <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
            connect Slack
          </button>
          .
        </div>
      )}

      {pending && needsAlertUser && isSetUp(slackStatus) && (
        <div className="approval__handle">
          <span className="approval__handle-label">Send my alerts to</span>
          <UserPicker value={alertUser} onPick={(u) => void pickAlertUser(u.id, userName(u))} placeholder={slackStatus?.alertSuggestion ? `e.g. ${slackStatus.alertSuggestion.name}` : 'Search people…'} />
          <div className="approval__handle-note text-tertiary">Only you can set this (Settings › Notifications). Empty = a Mac notification only.</div>
        </div>
      )}

      {pending ? (
        <>
          {noteOpen && (
            <input
              className="input input--sm approval__note"
              autoFocus
              value={note}
              maxLength={2000}
              placeholder="Tell Claude what to change (optional), then Reject"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && !e.metaKey) {
                  e.preventDefault()
                  void reject()
                } else if (e.key === 'Escape') {
                  setNoteOpen(false)
                  setNote('')
                }
              }}
            />
          )}
          {canEdit && (
            <label className="approval__allow" title="Only this exact version. Any later change asks again, and a run that passes a different value to a command input still needs a card.">
              <input type="checkbox" checked={allowRun} onChange={(e) => setAllowRun(e.target.checked)} />
              <span>Allow this agent to run workflows it created</span>
            </label>
          )}
          <div className="approval__actions">
            <Button variant="primary" size="sm" disabled={busy || !detail || needsTick} onClick={() => void approve()} kbd={hotkeys ? '⌘↩' : undefined} title={!detail ? 'Loading the details…' : isAuto && !autoAck ? 'Tick “I understand replies are posted without my review” first' : isUnsafe && !unsafeAck ? 'Tick the full-permissions warning first' : undefined}>
              {approveLabel}
            </Button>
            {noteOpen ? (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void reject()} kbd={hotkeys ? '⌘⌫' : undefined}>
                Reject
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => setNoteOpen(true)} kbd={hotkeys ? '⌘⌫' : undefined} title="Reject, with an optional note for the agent">
                Reject…
              </Button>
            )}
            {canEdit && (
              <Button size="sm" variant="ghost" icon="edit" onClick={() => editDraftInEditor(d.id)} title="Open it in the workflow editor; Save there approves your edited version">
                Edit in editor
              </Button>
            )}
            <span className="flex1" />
            {scheduleHint({ kind: d.kind, flags, scheduleRequest: sched }) && <span className="text-tertiary approval__hint">{scheduleHint({ kind: d.kind, flags, scheduleRequest: sched })}</span>}
          </div>
          {hotkeys && !compact && (
            <div className="approval__keys text-tertiary">
              <Kbd>⌘↩</Kbd> {approveLabel.toLowerCase()} · <Kbd>⌘⌫</Kbd> reject
            </div>
          )}
        </>
      ) : (
        <div className="approval__resolved text-tertiary">
          <Icon name={d.status === 'approved' ? 'check' : 'close'} size={12} /> {outcomeText(d)}
          {d.decisionNote && <span className="selectable"> “{d.decisionNote}”</span>}
        </div>
      )}
    </div>
  )
}

function NodeLineRow({ line: l, diff }: { line: NodeLine; diff: 'added' | 'changed' | null }): React.JSX.Element {
  const [more, setMore] = useState(false)
  const long = !!l.text && (l.text.length > 160 || l.text.split('\n').length > 2)
  return (
    <div className={`anode ${diff ? `anode--${diff}` : ''}`}>
      <div className="anode__head">
        <span className="anode__glyph">{l.glyph}</span>
        <span className="anode__type">{l.typeLabel}</span>
        <span className="anode__label">{l.label}</span>
        {l.who && <span className="text-secondary">· {l.who}</span>}
        {l.folder && <span className="text-tertiary">· {l.isolated ? '⎇ worktree' : l.folder}</span>}
        {l.extras.map((x) => (
          <span key={x} className="text-tertiary">
            · {x}
          </span>
        ))}
        {diff && <span className={`anode__diff anode__diff--${diff}`}>{diff}</span>}
      </div>
      {l.command !== null && <pre className="anode__cmd selectable">{l.command || '(empty)'}</pre>}
      {l.text && (
        <div className={`anode__text selectable ${more ? '' : 'is-clamped'}`}>
          {l.text}
          {long && (
            <button type="button" className="link-btn anode__more" onClick={() => setMore(!more)}>
              {more ? 'less' : 'more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
