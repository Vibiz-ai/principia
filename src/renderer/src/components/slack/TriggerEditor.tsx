/**
 * Slack triggers (SLACK.md §9, §12.5): the list on Schedules › Slack triggers, the editor sheet, the dry-run Test, and
 * the workflow chip. Draft is the default reply mode; Auto is amber, needs an allow-list, shows the fixed limits and is
 * disabled for unfiltered "any message" triggers (PO-S3c).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ValidationError, Workflow } from '@shared/types'
import { SLACK_AUTO_LIMITS, type SlackMessage, type SlackReplyMode, type SlackTrigger, type SlackTriggerEvent, type SlackTriggerInput, type SlackTriggerTestResult } from '@shared/slack'
import { Button, EmptyState, ErrorState, Field, Loading, RelativeTime, Segmented, Sheet, StatusGlyph, Stepper, Switch } from '../ui'
import { Icon } from '../Icon'
import { TemplateTextArea } from '../TemplateTextArea'
import { TRIGGER_REFS, channelLabel, defaultTrigger, mrkdwnPreview, parsePermalink, replyModeRow, toggleOn, triggerEventText, triggerSentence, userName, validateTriggerInput, type Namer } from '../../lib/slack'
import { runVisual } from '../../lib/graph'
import { clock } from '../../lib/time'
import { confirmNative, errorMessage, hive, nativeMenu } from '../../lib/hive'
import { onSlackEvent, slackCall } from '../../lib/slackApi'
import { isConnected, isSetUp, useSlack } from '../../state/slack'
import { attempt, navigate, toast, useStore } from '../../state/store'
import { ChannelMultiPicker, UserPicker } from './bits'
import { autoModeProblem } from '@shared/slack'

/** Names for sentences from the local mirror. */
export function useNamer(): Namer {
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const bot = useSlack((s) => s.status?.workspace?.botName ?? 'hive')
  return useMemo(
    () => ({
      channel: (id: string) => (id === 'dm' ? `DMs with @${bot}` : channels.some((c) => c.id === id) ? channelLabel(channels.find((c) => c.id === id), users) : id),
      user: (id: string) => userName(users[id], id),
      bot
    }),
    [channels, users, bot]
  )
}

function useTriggers(workflowId?: string): { list: SlackTrigger[] | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<SlackTrigger[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = (): void => {
    slackCall('slackTriggers:list', workflowId ? { workflowId } : undefined).then(
      (l) => {
        setList(l)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
  }
  useEffect(reload, [workflowId])
  useEffect(
    () =>
      onSlackEvent('slackTrigger:updated', (t) => {
        if (workflowId && t.workflowId !== workflowId) return
        setList((l) => (l ? (l.some((x) => x.id === t.id) ? l.map((x) => (x.id === t.id ? t : x)) : [...l, t]) : l))
      }),
    [workflowId]
  )
  return { list, error, reload }
}

/** Workflow page chip: "Slack · 2 triggers" (glyph chip, SLACK.md §12.5). */
export function SlackTriggerChip({ workflowId }: { workflowId: string }): React.JSX.Element | null {
  const { list } = useTriggers(workflowId)
  if (!list?.length) return null
  const on = list.filter((t) => t.enabled).length
  const auto = list.some((t) => t.enabled && t.reply.mode === 'auto')
  return (
    <button type="button" className={`slack-chip no-drag ${auto ? 'slack-chip--auto' : ''}`} title={list.map((t) => t.sentence).join('\n')} onClick={() => void navigate({ name: 'schedules', tab: 'slack', nonce: Date.now() })}>
      <Icon name="slack" size={12} /> Slack · {on}/{list.length} on{auto ? ' · auto' : ''}
    </button>
  )
}

export function SlackTriggersTab({ seedWorkflowId, nonce }: { seedWorkflowId?: string; nonce?: number }): React.JSX.Element {
  const status = useSlack((s) => s.status)
  const available = useSlack((s) => s.available)
  const paused = useStore((s) => !!s.status?.schedulesPaused)
  const autoPaused = useStore((s) => !!s.settings?.slackAutoPaused)
  const namer = useNamer()
  const { list, error, reload } = useTriggers()
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [sheet, setSheet] = useState<{ edit: SlackTrigger | null; workflowId?: string } | null>(null)
  useEffect(() => void hive.workflows.list().then(setWorkflows, () => undefined), [])
  useEffect(() => {
    if (seedWorkflowId) setSheet({ edit: null, workflowId: seedWorkflowId })
  }, [seedWorkflowId, nonce])

  const setEnabled = async (t: SlackTrigger, enabled: boolean): Promise<void> => {
    const r = await attempt(() => slackCall('slackTriggers:setEnabled', { id: t.id, enabled }), enabled ? 'Enable' : 'Disable')
    if (r) reload()
  }
  const remove = async (t: SlackTrigger): Promise<void> => {
    const ok = await confirmNative({ message: `Delete the Slack trigger “${t.name}”?`, detail: 'Its past runs are kept.', confirmLabel: 'Delete Trigger', destructive: true }).catch(() => false)
    if (!ok) return
    await attempt(() => slackCall('slackTriggers:remove', { id: t.id }), 'Delete')
    if (sel === t.id) setSel(null)
    reload()
  }
  const menu = async (t: SlackTrigger): Promise<void> => {
    const id = await nativeMenu([{ id: 'edit', label: 'Edit…' }, { id: 'toggle', label: t.enabled ? 'Disable' : 'Enable' }, { id: 'wf', label: 'Open Workflow' }, { type: 'separator' }, { id: 'delete', label: 'Delete' }])
    if (id === 'edit') setSheet({ edit: t })
    if (id === 'toggle') void setEnabled(t, !t.enabled)
    if (id === 'wf') void navigate({ name: 'editor', workflowId: t.workflowId, nonce: Date.now() })
    if (id === 'delete') void remove(t)
  }

  if (available === false) return <EmptyState icon="slack" text="Slack isn’t available in this build yet." />
  const selected = list?.find((t) => t.id === sel) ?? null
  const wfName = (id: string): string => workflows.find((w) => w.id === id)?.name ?? 'workflow'
  return (
    <>
      {!isSetUp(status) && (
        <div className="banner banner--accent banner--bar">
          Slack isn’t connected: triggers can be set up but won’t fire.{' '}
          <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'connections' })}>
            Connect Slack
          </button>
        </div>
      )}
      {paused && <div className="banner banner--warning banner--bar">Schedules are paused, and so are Slack triggers: nothing will fire.</div>}
      {autoPaused && <div className="banner banner--warning banner--bar">Auto-replies are paused: every reply becomes a draft you approve.</div>}
      {error && !list ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !list ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState icon="slack" text={`Run a workflow when someone mentions @${namer.bot}, DMs it, or posts in a channel. Replies are drafts you approve unless you allow auto.`}>
          <Button variant="primary" icon="plus" onClick={() => setSheet({ edit: null })} disabled={!workflows.length} title={!workflows.length ? 'Create a workflow first' : undefined}>
            New Slack Trigger
          </Button>
        </EmptyState>
      ) : (
        <div className={`split-h ${selected ? 'has-inspector' : ''}`}>
          <div className="table scroll split-h__main">
            <div className="tr tr--head stg-cols">
              <span className="th">On</span>
              <span className="th">Name</span>
              <span className="th">Workflow</span>
              <span className="th">When</span>
              <span className="th">Replies</span>
              <span className="th">Last</span>
            </div>
            {list.map((t) => (
              <div
                key={t.id}
                className={`tr stg-cols ${sel === t.id ? 'is-selected' : ''} ${t.enabled ? '' : 'is-dim'}`}
                onClick={() => setSel(t.id)}
                onDoubleClick={() => setSheet({ edit: t })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSel(t.id)
                  void menu(t)
                }}
              >
                <span className="td" onClick={(e) => e.stopPropagation()}>
                  <Switch checked={t.enabled} onChange={(v) => void setEnabled(t, v)} label={`Enable ${t.name}`} />
                </span>
                <span className="td td--main td--ellipsis">
                  {t.name}
                  {t.note && <span className="pill pill--warning" title={t.note}>{t.note}</span>}
                </span>
                <span className="td text-secondary td--ellipsis">⇶ {wfName(t.workflowId)}</span>
                <span className="td text-secondary td--ellipsis" title={t.sentence || triggerSentence(t, namer)}>
                  {(t.sentence || triggerSentence(t, namer)).split(' · ')[0]}
                </span>
                <span className="td">
                  <ReplyBadge mode={t.reply.mode} />
                </span>
                <span className="td">
                  {t.lastFiredAt ? (
                    <>
                      {t.lastRunStatus && <StatusGlyph status={runVisual(t.lastRunStatus)} />} <RelativeTime iso={t.lastFiredAt} />
                    </>
                  ) : (
                    <span className="text-tertiary">—</span>
                  )}
                </span>
              </div>
            ))}
          </div>
          {selected && <TriggerEvents trigger={selected} onEdit={() => setSheet({ edit: selected })} />}
        </div>
      )}
      {list && list.length > 0 && (
        <div className="stg-add">
          <Button icon="plus" onClick={() => setSheet({ edit: null })}>
            New Slack Trigger
          </Button>
        </div>
      )}
      {sheet && (
        <TriggerSheet
          existing={sheet.edit}
          workflows={workflows}
          seedWorkflowId={sheet.workflowId}
          onClose={() => setSheet(null)}
          onSaved={(t) => {
            setSheet(null)
            setSel(t.id)
            reload()
          }}
        />
      )}
    </>
  )
}

function ReplyBadge({ mode }: { mode: SlackReplyMode }): React.JSX.Element {
  if (mode === 'auto') return <span className="pill pill--warning">Auto</span>
  if (mode === 'none') return <span className="pill">None</span>
  return <span className="pill pill--accent">Draft</span>
}

function TriggerEvents({ trigger, onEdit }: { trigger: SlackTrigger; onEdit: () => void }): React.JSX.Element {
  const namer = useNamer()
  const [events, setEvents] = useState<SlackTriggerEvent[] | null>(null)
  useEffect(() => {
    slackCall('slackTriggers:events', { triggerId: trigger.id, limit: 50 }).then(setEvents, () => setEvents([]))
  }, [trigger.id, trigger.lastFiredAt])
  return (
    <aside className="history scroll">
      <div className="history__head">
        <div className="history__title">{trigger.name}</div>
        <div className="text-secondary stg-sentence">{trigger.sentence || triggerSentence(trigger, namer)}</div>
      </div>
      <div className="stg-limits text-tertiary">
        Waits {trigger.limits.debounceSec} s for more messages · up to {trigger.limits.maxRunsPerThreadPerHour} runs per thread and {SLACK_AUTO_LIMITS.runsPerTriggerPerHour} per hour
      </div>
      <div className="stg-actions">
        <Button size="sm" onClick={onEdit}>
          Edit…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'editor', workflowId: trigger.workflowId, nonce: Date.now() })}>
          Open Workflow
        </Button>
      </div>
      <div className="stg-section">Recent activity</div>
      {!events ? (
        <Loading />
      ) : events.length === 0 ? (
        <div className="text-tertiary">Nothing yet.</div>
      ) : (
        events.map((e) => (
          <div key={e.id} className={`stg-event stg-event--${e.kind}`}>
            <span className="stg-event__time text-tertiary">{clock(new Date(e.createdAt))}</span>
            <span className="stg-event__text">
              {triggerEventText(e.kind)}
              {e.channelId && <span className="text-tertiary"> · {namer.channel(e.channelId)}</span>}
              {e.message && <span className="text-tertiary selectable"> · {e.message}</span>}
            </span>
            {e.runId && (
              <button type="button" className="link-btn" onClick={() => void navigate({ name: 'run', runId: e.runId! })}>
                Run
              </button>
            )}
          </div>
        ))
      )}
    </aside>
  )
}

function inputOf(t: SlackTrigger): SlackTriggerInput {
  return { name: t.name, workflowId: t.workflowId, enabled: t.enabled, match: t.match, reply: t.reply, limits: t.limits, inputs: t.inputs, access: t.access }
}

export function TriggerSheet({ existing, workflows, seedWorkflowId, onClose, onSaved }: { existing: SlackTrigger | null; workflows: Workflow[]; seedWorkflowId?: string; onClose: () => void; onSaved: (t: SlackTrigger) => void }): React.JSX.Element {
  const namer = useNamer()
  const status = useSlack((s) => s.status)
  const seedWf = workflows.find((w) => w.id === seedWorkflowId) ?? workflows[0] ?? null
  const [t, setT] = useState<SlackTriggerInput>(() => (existing ? inputOf(existing) : defaultTrigger(seedWf, namer.bot)))
  const [nameTouched, setNameTouched] = useState(!!existing)
  const [keyword, setKeyword] = useState('')
  const [keysText, setKeysText] = useState(() => (existing?.access?.secretNames ?? []).join(', '))
  const [serverErrors, setServerErrors] = useState<ValidationError[]>([])
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState((t.limits?.debounceSec ?? 0) > 120)
  const wf = workflows.find((w) => w.id === t.workflowId) ?? null
  const agentNodes = (wf?.nodes ?? []).filter((n) => n.type === 'agent' || n.type === 'room' || n.type === 'check' || n.type === 'shell')
  const required = (wf?.inputs ?? []).filter((i) => i.default === undefined || i.default === '').map((i) => i.name)
  const problems = validateTriggerInput(t, required)
  const autoBlocked = autoModeProblem(t.match)
  const err = (path: string): string | undefined => serverErrors.find((e) => e.path === path)?.message ?? problems.find((p) => p.path === path)?.message
  const set = (patch: Partial<SlackTriggerInput>): void => setT((x) => ({ ...x, ...patch }))
  const setMatch = (patch: Partial<SlackTriggerInput['match']>): void => setT((x) => ({ ...x, match: { ...x.match, ...patch } }))
  const setReply = (patch: Partial<SlackTriggerInput['reply']>): void => setT((x) => ({ ...x, reply: { ...x.reply, ...patch } }))
  const setLimits = (patch: Partial<NonNullable<SlackTriggerInput['limits']>>): void => setT((x) => ({ ...x, limits: { ...x.limits, ...patch } }))

  // switching workflow re-defaults the reply node (PO-S10) and the name while untouched
  const pickWorkflow = (id: string): void => {
    const w = workflows.find((x) => x.id === id) ?? null
    const d = defaultTrigger(w, namer.bot)
    setT((x) => ({ ...x, workflowId: id, name: nameTouched ? x.name : d.name, reply: { ...x.reply, replyNode: d.reply.replyNode ?? null }, inputs: {} }))
  }
  // auto that the form can no longer allow falls back to draft (never silently stays auto)
  useEffect(() => {
    if (t.reply.mode === 'auto' && autoBlocked) setReply({ mode: 'draft' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBlocked])

  const save = async (): Promise<void> => {
    if (problems.length || busy) return
    setBusy(true)
    setServerErrors([])
    try {
      const out = existing ? await slackCall('slackTriggers:update', { id: existing.id, input: t }) : await slackCall('slackTriggers:create', t)
      toast(existing ? 'Slack trigger saved' : `Slack trigger added${isConnected(status) ? '' : ' (fires once Slack is connected)'}`)
      onSaved(out)
    } catch (e) {
      const errs = (e as { errors?: ValidationError[] }).errors
      if (errs?.length) setServerErrors(errs)
      else toast(`Save: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  const addKeyword = (): void => {
    const k = keyword.trim()
    if (k && !t.match.keywords.includes(k)) setMatch({ keywords: [...t.match.keywords, k] })
    setKeyword('')
  }
  const sentence = triggerSentence(t, namer)
  const row = replyModeRow(t.reply.mode, t.reply.autoChannels, t.limits?.maxRunsPerThreadPerHour ?? 4, namer)

  return (
    <Sheet title={existing ? `Edit ${existing.name}` : 'New Slack Trigger'} onCancel={onClose} onPrimary={() => void save()} primaryLabel={t.reply.mode === 'auto' ? 'Save with auto-reply' : 'Save'} primaryDisabled={busy || problems.length > 0} primaryTitle={problems.map((p) => p.message).join('\n') || undefined} width={640} footerLeft={<span className="text-tertiary stg-preview" title={sentence}>{sentence}</span>}>
      <Field label="Workflow" error={err('workflowId')}>
        <select className="input" value={t.workflowId} onChange={(e) => pickWorkflow(e.target.value)}>
          {!t.workflowId && <option value="">Pick a workflow…</option>}
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name" error={err('name')}>
        <input
          className="input"
          value={t.name}
          maxLength={120}
          onChange={(e) => {
            setNameTouched(true)
            set({ name: e.target.value })
          }}
        />
      </Field>
      <Field label="When" align="start" error={err('match.on')}>
        <div className="stg-when">
          <label className="checkbox">
            <input type="checkbox" checked={t.match.on.includes('mention')} onChange={(e) => setT((x) => toggleOn(x, 'mention', e.target.checked))} /> @{namer.bot} is mentioned
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={t.match.on.includes('dm')} onChange={(e) => setT((x) => toggleOn(x, 'dm', e.target.checked))} /> someone DMs @{namer.bot}
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={t.match.on.includes('message')} onChange={(e) => setT((x) => toggleOn(x, 'message', e.target.checked))} /> any message in…
          </label>
        </div>
      </Field>
      {(t.match.on.includes('mention') || t.match.on.includes('message')) && (
        <Field label="Channels" align="start" error={err('match.channels')} hint={t.match.on.includes('message') ? undefined : 'Empty = any channel @' + namer.bot + ' is in.'}>
          <ChannelMultiPicker value={t.match.channels} onChange={(channels) => setMatch({ channels })} botName={namer.bot} />
        </Field>
      )}
      <Field label="Keywords" align="start" error={err('match.keywords')} hint="Any of these words (case-insensitive).">
        <div className="chips">
          {t.match.keywords.map((k) => (
            <span key={k} className="chip">
              {k}
              <button type="button" className="chip__x" aria-label={`Remove ${k}`} onClick={() => setMatch({ keywords: t.match.keywords.filter((x) => x !== k) })}>
                ×
              </button>
            </span>
          ))}
          <input
            className="input input--sm stg-kw"
            value={keyword}
            maxLength={100}
            placeholder="Add keyword, Return"
            onChange={(e) => setKeyword(e.target.value)}
            onBlur={addKeyword}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addKeyword()
              } else if (e.key === 'Backspace' && !keyword && t.match.keywords.length) setMatch({ keywords: t.match.keywords.slice(0, -1) })
            }}
          />
        </div>
      </Field>
      <Field label="Regex" error={err('match.regex')}>
        <input className={`input mono ${err('match.regex') ? 'is-invalid' : ''}`} value={t.match.regex ?? ''} maxLength={300} placeholder="optional, e.g. deploy(ed)?\s+fail" onChange={(e) => setMatch({ regex: e.target.value || null })} spellCheck={false} />
      </Field>
      <Field label="From people" align="start" hint="Empty = anyone (never other bots).">
        <div className="chips">
          {t.match.fromUsers.map((id) => (
            <span key={id} className="chip">
              {namer.user(id)}
              <button type="button" className="chip__x" aria-label={`Remove ${namer.user(id)}`} onClick={() => setMatch({ fromUsers: t.match.fromUsers.filter((x) => x !== id) })}>
                ×
              </button>
            </span>
          ))}
          <UserPicker value={null} onPick={(u) => !t.match.fromUsers.includes(u.id) && setMatch({ fromUsers: [...t.match.fromUsers, u.id] })} placeholder="Add person…" exclude={t.match.fromUsers} />
        </div>
      </Field>
      <Field label="Wait for more" hint={`Messages within ${t.limits?.debounceSec ?? 0} s become one run (one run per thread at a time).`} error={err('limits.debounceSec')}>
        <div className="stg-debounce">
          <input type="range" min={0} max={advanced ? 600 : 120} step={advanced ? 5 : 1} value={t.limits?.debounceSec ?? 0} onChange={(e) => setLimits({ debounceSec: Number(e.target.value) })} aria-label="Debounce seconds" />
          <Stepper value={t.limits?.debounceSec ?? 0} min={0} max={600} onChange={(v) => setLimits({ debounceSec: v })} label="Debounce seconds" /> <span className="text-tertiary">s</span>
          {!advanced && (
            <button type="button" className="link-btn" onClick={() => setAdvanced(true)}>
              longer…
            </button>
          )}
        </div>
      </Field>
      <Field label="Fallback" hint="On: runs only when none of your other triggers matched the message, so a specific workflow always wins.">
        <label className="run-check">
          <input type="checkbox" checked={!!t.match.fallback} onChange={(e) => setMatch({ fallback: e.target.checked || undefined })} />
          Only when no other trigger matches
        </label>
      </Field>
      <Field label="Max runs" hint={`Per thread per hour (a DM counts as one thread). Each trigger also stops at ${SLACK_AUTO_LIMITS.runsPerTriggerPerHour} runs per hour.`} error={err('limits.maxRunsPerThreadPerHour')}>
        <Stepper value={t.limits?.maxRunsPerThreadPerHour ?? 4} min={1} max={30} onChange={(v) => setLimits({ maxRunsPerThreadPerHour: v })} label="Max runs per thread per hour" />
      </Field>
      <Field label="Reply" align="start" error={err('reply.mode') ?? err('reply.autoChannels')}>
        <Segmented<SlackReplyMode>
          size="sm"
          items={[
            { value: 'draft', label: 'Draft (recommended)' },
            { value: 'auto', label: 'Auto', disabled: !!autoBlocked, title: autoBlocked ?? 'Post without your review, only in the channels you allow' },
            { value: 'none', label: 'None' }
          ]}
          value={t.reply.mode}
          onChange={(mode) => setReply({ mode })}
        />
        {autoBlocked && t.reply.mode !== 'auto' && <div className="field__hint">{autoBlocked}</div>}
        {t.reply.mode === 'draft' && <div className="field__hint">Each reply waits in Needs you. Edit it, then Send.</div>}
        {t.reply.mode === 'auto' && (
          <div className="stg-auto">
            <div className="stg-auto__title">Posts without your review in:</div>
            {!t.match.on.includes('message') && (
              <label className="run-check">
                <input
                  type="checkbox"
                  checked={t.reply.autoChannels.includes('*')}
                  onChange={(e) => setReply({ autoChannels: e.target.checked ? ['*'] : [] })}
                />
                Anywhere @{namer.bot} is tagged or DMed
              </label>
            )}
            {!t.reply.autoChannels.includes('*') && (
              <ChannelMultiPicker value={t.reply.autoChannels} onChange={(autoChannels) => setReply({ autoChannels })} allowDm botName={namer.bot} />
            )}
            <div className="stg-auto__limits">
              {SLACK_AUTO_LIMITS.perRun} post per run · {SLACK_AUTO_LIMITS.perChannelPerHour} per channel per hour · more than {SLACK_AUTO_LIMITS.maxUserMentions} @people becomes a draft · only in the thread that triggered it. Anything else becomes a draft. Pause auto-replies on the Slack page stops it all.
            </div>
          </div>
        )}
      </Field>
      {t.reply.mode !== 'none' && (
        <Field label="Reply with" hint={t.reply.replyNode ? 'Skipped when the agent already drafted or posted with its Slack tools.' : 'Only what the agent drafts or posts with its Slack tools.'}>
          <select className="input" value={t.reply.replyNode ?? ''} onChange={(e) => setReply({ replyNode: e.target.value || null })}>
            {agentNodes.map((n) => (
              <option key={n.id} value={n.id}>
                the output of {n.label || n.id}
              </option>
            ))}
            <option value="">Let the agent use Slack tools only</option>
          </select>
        </Field>
      )}
      <Field
        label="Agent access"
        align="start"
        error={err('access.secretNames')}
        hint={
          t.access?.fullPermissions
            ? 'Anyone who can post in these channels can steer agents that run shell commands, edit files and use the web on this Mac.'
            : 'Agents can read files in their folder and use Slack tools only: no shell, no file edits, no web. Only Claude Code runs this way.'
        }
      >
        <label className={`stg-access ${t.access?.fullPermissions ? 'stg-access--unsafe' : ''}`} data-unsafe-access={t.access?.fullPermissions ? '' : undefined}>
          <input
            type="checkbox"
            checked={!!t.access?.fullPermissions}
            onChange={(e) => set({ access: { ...t.access, fullPermissions: e.target.checked, secretNames: t.access?.secretNames ?? [] } })}
          />
          <span>Unsafe: full agent permissions</span>
        </label>
        <input
          className="input"
          placeholder="Keys agents may use (names, comma-separated; none by default)"
          value={keysText}
          onChange={(e) => {
            setKeysText(e.target.value)
            set({
              access: {
                ...t.access,
                fullPermissions: !!t.access?.fullPermissions,
                secretNames: e.target.value.split(',').map((x) => x.trim()).filter(Boolean)
              }
            })
          }}
          aria-label="Vault keys allowed for Slack-triggered runs"
        />
      </Field>
      <Field
        label="Slack reads"
        align="start"
        error={err('access.readChannels')}
        hint="Agents read only the conversation that started the run. Add channels they may also read in full (never DMs). Replies always stay in that thread."
      >
        <div data-slack-read-channels="">
          <ChannelMultiPicker
            value={t.access?.readChannels ?? []}
            onChange={(readChannels) => set({ access: { fullPermissions: !!t.access?.fullPermissions, secretNames: t.access?.secretNames ?? [], readChannels } })}
            botName={namer.bot}
          />
        </div>
      </Field>
      {wf && wf.inputs.length > 0 && (
        <Field label="Inputs" align="start" hint="Type {{ for trigger.text, trigger.thread, trigger.user, trigger.permalink…">
          <div className="stg-inputs">
            {wf.inputs.map((i) => (
              <div key={i.name} className="stg-input">
                <span className="mono stg-input__name" title={i.label}>
                  {i.name}
                  {required.includes(i.name) && <span className="text-failed">*</span>}
                </span>
                <div className="stg-input__val">
                  <TemplateTextArea
                    value={t.inputs?.[i.name] ?? ''}
                    onChange={(v) => set({ inputs: { ...t.inputs, [i.name]: v } })}
                    suggestions={[...TRIGGER_REFS]}
                    placeholder={i.default ? `default: ${i.default}` : '{{trigger.text}}'}
                    singleLine
                    minRows={1}
                  />
                  {err(`inputs.${i.name}`) && <div className="field__error">{err(`inputs.${i.name}`)}</div>}
                </div>
              </div>
            ))}
          </div>
        </Field>
      )}
      <div className={`stg-row stg-row--${row.tone}`}>{row.text}</div>
      <TriggerTest input={t} disabled={problems.length > 0} />
      {serverErrors.filter((e) => !['name', 'workflowId', 'match.on', 'match.channels', 'match.regex', 'match.keywords', 'reply.mode', 'reply.autoChannels', 'limits.debounceSec', 'limits.maxRunsPerThreadPerHour'].includes(e.path) && !e.path.startsWith('inputs.')).map((e, i) => (
        <div key={i} className="field__error">
          ✕ {e.message}
        </div>
      ))}
    </Sheet>
  )
}

/** Dry run (never starts a run): a pasted permalink or a recent message from the first channel. */
function TriggerTest({ input, disabled }: { input: SlackTriggerInput; disabled: boolean }): React.JSX.Element {
  const channels = useSlack((s) => s.channels)
  const users = useSlack((s) => s.users)
  const [link, setLink] = useState('')
  const [recent, setRecent] = useState<SlackMessage[]>([])
  const [pick, setPick] = useState('')
  const [res, setRes] = useState<SlackTriggerTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const chan = input.match.channels[0] ?? channels.find((c) => c.isMember && (c.kind === 'channel' || c.kind === 'private'))?.id ?? null
  useEffect(() => {
    if (!chan) return
    slackCall('slack:messages', { channelId: chan, limit: 15 }).then(
      (p) => setRecent(p.messages.filter((m) => !m.deleted && !m.subtype).slice(-10).reverse()),
      () => setRecent([])
    )
  }, [chan])
  const run = async (): Promise<void> => {
    const parsed = link.trim() ? parsePermalink(link) : null
    if (link.trim() && !parsed) return setErr('That doesn’t look like a Slack message link.')
    const sample = parsed ? { permalink: link.trim() } : pick && chan ? { channelId: chan, ts: pick } : null
    if (!sample) return setErr('Paste a message link or pick a recent message.')
    setBusy(true)
    setErr(null)
    try {
      setRes(await slackCall('slackTriggers:test', { input, sample }))
    } catch (e) {
      setErr(errorMessage(e))
      setRes(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="stg-test">
      <div className="stg-test__bar">
        <span className="stg-test__label">Test</span>
        <input className="input input--sm" value={link} placeholder="Paste a Slack message link" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && void run())} />
        <span className="text-tertiary">or</span>
        <select className="input input--sm" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!recent.length} aria-label="Recent message">
          <option value="">{recent.length ? 'a recent message…' : 'no recent messages'}</option>
          {recent.map((m) => (
            <option key={m.ts} value={m.ts}>
              {userName(users[m.userId ?? ''], m.userId)}: {mrkdwnPreview(m.text, undefined, 60)}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={() => void run()} disabled={busy || disabled}>
          {busy ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {err && <div className="field__error">{err}</div>}
      {res && (
        <div className={`stg-test__res ${res.fires ? 'is-yes' : 'is-no'}`}>
          {res.fires ? '✓ Would fire' : `✕ Would not fire${res.reasons.length ? `: ${res.reasons.join('; ')}` : ''}`}
          {res.fires && Object.keys(res.inputs).length > 0 && (
            <div className="kv stg-test__inputs">
              {Object.entries(res.inputs).map(([k, v]) => (
                <span key={k} className="kv__pair">
                  <span className="text-tertiary mono">{k}</span>
                  <span className="kv__val selectable" title={v}>
                    {v.length > 120 ? `${v.slice(0, 119)}…` : v || '(empty)'}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
