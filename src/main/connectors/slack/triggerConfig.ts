/**
 * Slack trigger config (SLACK.md §9.1, §9.5; PO-S3c, PO-S9, PO-S10): normalize + validate a SlackTriggerInput and build
 * the trigger sentence. Main-side (the engine validates templates/commands itself in engine/validate.ts).
 * The regex probe runs in node:vm with a 50 ms timeout, which interrupts a catastrophic backtrack.
 */
import vm from 'node:vm'
import {
  SLACK_READ_CHANNEL_ID,
  autoModeProblem,
  slackAccessOf,
  type SlackAgentAccess,
  defaultDebounceSec,
  type SlackReplyPolicy,
  type SlackTriggerInput,
  type SlackTriggerLimits,
  type SlackTriggerMatch,
  type SlackTriggerOn
} from '../../../shared/slack'
import type { ValidationError, WorkflowDraft } from '../../../shared/types'

const CHANNEL_ID = /^[CGD][A-Z0-9]{1,20}$/
const USER_ID = /^[UW][A-Z0-9]{1,20}$/
const ON: SlackTriggerOn[] = ['mention', 'dm', 'message']
const PROBES = ['a'.repeat(28) + '!', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', `${'ab'.repeat(16)}c`, `${'x '.repeat(20)}!`, `${'0'.repeat(30)}x`, `${'-'.repeat(30)}@`]

export interface NormalizedTrigger {
  name: string
  workflowId: string
  enabled: boolean
  match: SlackTriggerMatch
  reply: SlackReplyPolicy
  limits: SlackTriggerLimits
  inputs: Record<string, string>
  /** SA2: restricted, no keys unless set. */
  access: SlackAgentAccess
}

/** Rejects a regex that does not compile or backtracks catastrophically (> 50 ms on adversarial input). */
export function regexProblem(src: string): string | null {
  if (src.length > 300) return 'Regex is longer than 300 characters'
  try {
    new RegExp(src, 'i')
  } catch (e) {
    return `Regex does not compile: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    vm.runInNewContext('for (const s of probes) re.test(s)', { re: new RegExp(src, 'i'), probes: PROBES }, { timeout: 50 })
  } catch {
    return 'Regex is too slow (catastrophic backtracking); simplify it'
  }
  return null
}

/** PO-S10: the workflow's last agent node (then room), or null. */
export function defaultReplyNode(wf: Pick<WorkflowDraft, 'nodes'> | null): string | null {
  const nodes = wf?.nodes ?? []
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type === 'agent') return nodes[i].id
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type === 'room') return nodes[i].id
  return null
}

const uniq = <T extends string>(a: T[]): T[] => [...new Set(a)]

export function normalizeTrigger(input: SlackTriggerInput, wf: (Pick<WorkflowDraft, 'nodes' | 'inputs'> & { id?: string }) | null): { trigger: NormalizedTrigger; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  const err = (path: string, message: string) => errors.push({ path, message })
  const m = input.match ?? ({} as SlackTriggerMatch)
  const on = uniq((Array.isArray(m.on) ? m.on : []).filter((x): x is SlackTriggerOn => ON.includes(x as SlackTriggerOn)))
  if (!on.length) err('match.on', 'Pick at least one of: @hive is mentioned, someone DMs @hive, any message in…')
  const channels = uniq((m.channels ?? []).map((c) => String(c).trim()).filter(Boolean))
  if (channels.length > 50) err('match.channels', 'At most 50 channels')
  for (const c of channels) if (!CHANNEL_ID.test(c)) err('match.channels', `"${c}" is not a channel id (C…/G…)`)
  if (on.includes('message') && !channels.length) err('match.channels', '"Any message in…" needs at least one channel')
  const keywords = uniq((m.keywords ?? []).map((k) => String(k).trim()).filter(Boolean))
  if (keywords.length > 20) err('match.keywords', 'At most 20 keywords')
  for (const k of keywords) if (k.length > 100) err('match.keywords', 'A keyword is at most 100 characters')
  const regex = typeof m.regex === 'string' && m.regex.trim() ? m.regex.trim() : null
  if (regex) {
    const p = regexProblem(regex)
    if (p) err('match.regex', p)
  }
  const fromUsers = uniq((m.fromUsers ?? []).map((u) => String(u).trim()).filter(Boolean))
  if (fromUsers.length > 50) err('match.fromUsers', 'At most 50 people')
  for (const u of fromUsers) if (!USER_ID.test(u)) err('match.fromUsers', `"${u}" is not a user id (U…)`)
  if (m.allowGuests !== undefined && typeof m.allowGuests !== 'boolean') err('match.allowGuests', 'allowGuests is true or false')
  // default: workspace members only (slackAuthorProblem); stored only when opted in
  const match: SlackTriggerMatch = { on, channels, keywords, regex, fromUsers, ...(m.allowGuests === true ? { allowGuests: true } : {}), ...(m.fallback === true ? { fallback: true } : {}) }

  const r = input.reply ?? ({ mode: 'draft', autoChannels: [] } as SlackTriggerInput['reply'])
  const mode = r.mode === 'auto' || r.mode === 'none' ? r.mode : 'draft'
  const autoChannels = uniq((r.autoChannels ?? []).map((c) => String(c).trim()).filter(Boolean))
  for (const c of autoChannels) if (c !== 'dm' && c !== '*' && !CHANNEL_ID.test(c)) err('reply.autoChannels', `"${c}" is not a channel id or "dm"`)
  if (autoChannels.length > 20) err('reply.autoChannels', 'At most 20 auto channels')
  if (mode === 'auto') {
    if (!autoChannels.length) err('reply.autoChannels', 'Auto replies need an explicit list of channels (or DMs)')
    const p = autoModeProblem(match)
    if (p) err('reply.mode', p)
  }
  let replyNode: string | null = r.replyNode === undefined ? defaultReplyNode(wf) : r.replyNode
  if (replyNode && wf && !wf.nodes.some((n) => n.id === replyNode)) err('reply.replyNode', `No node "${replyNode}" in this workflow`)
  if (mode === 'none') replyNode = r.replyNode === undefined ? null : replyNode
  const reply: SlackReplyPolicy = { mode, autoChannels: mode === 'auto' ? autoChannels : autoChannels, replyNode }

  const l = input.limits ?? {}
  const debounceSec = typeof l.debounceSec === 'number' ? Math.round(l.debounceSec) : defaultDebounceSec(on)
  if (debounceSec < 0 || debounceSec > 600) err('limits.debounceSec', 'Debounce is 0..600 seconds')
  const maxRunsPerThreadPerHour = typeof l.maxRunsPerThreadPerHour === 'number' ? Math.round(l.maxRunsPerThreadPerHour) : 4
  if (maxRunsPerThreadPerHour < 1 || maxRunsPerThreadPerHour > 30) err('limits.maxRunsPerThreadPerHour', 'Max runs per thread per hour is 1..30')
  const limits: SlackTriggerLimits = { debounceSec: Math.min(600, Math.max(0, debounceSec)), maxRunsPerThreadPerHour: Math.min(30, Math.max(1, maxRunsPerThreadPerHour)) }

  const inputs: Record<string, string> = {}
  const wfInputs = new Map((wf?.inputs ?? []).map((i) => [i.name, i]))
  for (const [k, v] of Object.entries(input.inputs ?? {})) {
    if (typeof v !== 'string') continue
    if (wf && !wfInputs.has(k)) err(`inputs.${k}`, `The workflow has no input "${k}"`)
    if (v.length > 2000) err(`inputs.${k}`, 'A mapping is at most 2,000 characters')
    for (const ref of v.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      if (!/^trigger\.(text|thread|channel|channel_id|ts|thread_ts|user|user_id|permalink)$/.test(ref[1])) err(`inputs.${k}`, `{{${ref[1]}}} is not allowed here; use {{trigger.*}} only`)
    }
    inputs[k] = v
  }
  for (const i of wf?.inputs ?? []) {
    if ((i.default === undefined || i.default === '') && !(i.name in inputs) && i.type !== 'boolean') err(`inputs.${i.name}`, `Map the workflow input "${i.name}" (it has no default), e.g. {{trigger.text}}`)
  }

  const rawAccess = (input.access ?? {}) as { secretNames?: unknown; readChannels?: unknown }
  if (Array.isArray(rawAccess.secretNames) && rawAccess.secretNames.includes('*')) err('access.secretNames', 'Name each key a Slack-triggered run may use; "*" (all keys) is not allowed')
  // reads beyond the triggering conversation: channels only, never DMs (enforced again at read time)
  if (rawAccess.readChannels !== undefined && !Array.isArray(rawAccess.readChannels)) err('access.readChannels', 'Read channels must be a list of channel ids')
  const reads = Array.isArray(rawAccess.readChannels) ? rawAccess.readChannels : []
  if (reads.length > 50) err('access.readChannels', 'At most 50 read channels')
  for (const c of reads)
    if (typeof c !== 'string' || !SLACK_READ_CHANNEL_ID.test(c))
      err('access.readChannels', /^D/.test(String(c)) ? `"${String(c)}" is a direct message; Slack-triggered runs never read other DMs` : `"${String(c)}" is not a channel id (C…/G…)`)
  const access = slackAccessOf(input.access)

  const name = (input.name ?? '').trim()
  if (!name) err('name', 'Name the trigger')
  if (name.length > 120) err('name', 'Name is at most 120 characters')
  return {
    trigger: { name: name.slice(0, 120), workflowId: input.workflowId, enabled: input.enabled !== false, match, reply, limits, inputs, access },
    errors
  }
}

/** "When @hive is mentioned in #support · replies as drafts". */
export function triggerSentence(t: Pick<NormalizedTrigger, 'match' | 'reply'>, channelName: (id: string) => string = (id) => id): string {
  const chans = (ids: string[]) => ids.map((id) => `#${channelName(id)}`).join(', ')
  const parts: string[] = []
  if (t.match.on.includes('mention')) parts.push(`@hive is mentioned${t.match.channels.length && !t.match.on.includes('message') ? ` in ${chans(t.match.channels)}` : ''}`)
  if (t.match.on.includes('dm')) parts.push('someone DMs @hive')
  if (t.match.on.includes('message')) parts.push(`any message in ${chans(t.match.channels)}`)
  const filters: string[] = []
  if (t.match.keywords.length) filters.push(`containing ${t.match.keywords.map((k) => `“${k}”`).join(' or ')}`)
  if (t.match.regex) filters.push(`matching /${t.match.regex}/`)
  if (t.match.fromUsers.length) filters.push(`from ${t.match.fromUsers.length === 1 ? '1 person' : `${t.match.fromUsers.length} people`}`)
  // who can trigger, when no people are named (they are the audience otherwise)
  const who = t.match.fromUsers.length ? '' : t.match.allowGuests ? ' · anyone, including guests and other organizations' : ' · workspace members only'
  const reply =
    t.reply.mode === 'draft'
      ? 'replies as drafts'
      : t.reply.mode === 'none'
        ? 'no replies'
        : t.reply.autoChannels.includes('*')
          ? 'auto-replies wherever it is tagged'
          : `auto-replies in ${t.reply.autoChannels.map((c) => (c === 'dm' ? 'DMs' : `#${channelName(c)}`)).join(', ')}`
  return `When ${parts.join(' or ')}${filters.length ? ` ${filters.join(', ')}` : ''}${who} · ${reply}`
}
