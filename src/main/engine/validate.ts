/** Save-time workflow validation (SPEC 7.3, A4, A5; AUTHORING.md §4). [] = valid. Messages name the node. */
import { isAbsolute } from 'node:path'
import type { AgentProfile, Repo, ValidationError, WorkflowDraft } from '../../shared/types'
import { ancestors, effectiveDeps, topoOrder } from './graph'
import { isMemoryMode } from './memory'
import { isCommandField, nodeTexts, parseRefs } from './templates'
import type { NotifySlackTarget, SlackTriggerInput, SlackTriggerOn } from '../../shared/slack'
import { autoModeProblem } from '../../shared/slack'
import { commandInputs } from './authoring'

/** SLACK.md §9.2: Slack text is untrusted; it never reaches a shell. */
export const TRIGGER_IN_COMMAND = 'Slack text is untrusted; pass it through a file or an agent prompt'
/** Slack channel id (C… public, G… private / group DM, D… DM). */
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{2,20}$/
/** Slack user id. */
export const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/

/** SLACK.md §10.1: `slack` of a notify node. null = valid. */
export function notifySlackError(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) return 'slack must be {"kind":"me"}, {"kind":"channel","channel":"C…"} or null'
  const t = v as Partial<NotifySlackTarget> & Record<string, unknown>
  if (t.kind === 'me') return null
  if (t.kind === 'channel') {
    if (typeof t.channel !== 'string' || !SLACK_CHANNEL_ID.test(t.channel)) return 'slack channel must be a channel id (C…/G…)'
    return null
  }
  return 'slack must be {"kind":"me"}, {"kind":"channel","channel":"C…"} or null'
}
import { isBooleanValue } from '../../shared/inputs'

const NODE_ID = /^[a-z][a-z0-9_-]*$/
const INPUT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const INPUT_TYPES = ['text', 'multiline', 'repo', 'boolean']
export const NODE_TYPES = ['agent', 'room', 'check', 'shell', 'wait', 'notify'] as const
/** A git branch name for worktree.base (no templates, no spaces, no `..`). */
const BRANCH = /^(?!.*\.\.)(?!-)[A-Za-z0-9._/-]{1,200}$/
const WORKTREE_INPUT = /^\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/

export interface ValidateDeps {
  getProfile(id: string): AgentProfile | null
  getRepo(id: string): Repo | null
  /** The workflow has a Slack trigger (or a Slack-triggered run is starting): Slack-driven rules apply. */
  slackTriggered?: boolean
}

/** $HIVE_OUT_<NODE>: the env var holding the path of a finished node's output file (id upper-cased, - -> _). */
export const hiveOutVar = (nodeId: string): string => `HIVE_OUT_${nodeId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`

/**
 * Review fix: in a Slack-driven workflow (a Slack trigger, or slackTools) an upstream step's output may carry Slack text
 * (an agent read it), so `{{node.output}}` / `{{node.transcript}}` never reaches a shell, wait or check command. The
 * command reads the output as data from "$HIVE_OUT_<NODE>" instead. [] = none. The executor refuses it at run time too.
 */
export function slackOutputInCommands(draft: Pick<WorkflowDraft, 'nodes'>): ValidationError[] {
  const errs: ValidationError[] = []
  for (const n of Array.isArray(draft?.nodes) ? draft.nodes : []) {
    if (!n || typeof n !== 'object') continue
    for (const { field, text } of nodeTexts(n)) {
      if (!isCommandField(n, field)) continue
      for (const r of parseRefs(text)) {
        if (r.kind !== 'node') continue
        errs.push({ path: n.id, message: `Node "${n.id}": ${r.raw} in a command: ${slackCommandHint(r.nodeId)}` })
      }
    }
  }
  return errs
}
export const slackCommandHint = (nodeId: string): string =>
  `this workflow reads Slack, so another step's output never runs as shell; read it as data from "$${hiveOutVar(nodeId)}" (a file path) instead`

export function validateWorkflow(draft: WorkflowDraft, deps0: ValidateDeps): ValidationError[] {
  const errs: ValidationError[] = []
  const err = (path: string, message: string): void => void errs.push({ path, message })

  if (!draft || typeof draft !== 'object') return [{ path: 'name', message: 'Workflow is empty' }]
  if (!draft.name?.trim()) err('name', 'Name is required')

  const inputs = Array.isArray(draft.inputs) ? draft.inputs : []
  const inputNames = new Set<string>()
  for (const i of inputs) {
    if (!INPUT_NAME.test(i?.name ?? '')) err('inputs', `Input "${i?.name ?? ''}" must match [a-zA-Z_][a-zA-Z0-9_]*`)
    else if (inputNames.has(i.name)) err('inputs', `Input "${i.name}" is defined twice`)
    inputNames.add(i?.name)
    const ty = (i as { type?: unknown })?.type
    if (ty !== undefined && ty !== null && !INPUT_TYPES.includes(ty as string)) err('inputs', `Input "${i?.name ?? ''}": type must be text, multiline, repo or boolean`)
    if (ty === 'boolean' && i.default !== undefined && i.default !== '' && !isBooleanValue(i.default))
      err('inputs', `Input "${i.name}" is a checkbox: its default must be true or false`)
  }

  const nodes = Array.isArray(draft.nodes) ? draft.nodes : []
  if (!nodes.length) err('nodes', 'Add at least one node')
  const okNodes = nodes.filter((n) => n && NODE_ID.test(n.id ?? ''))
  const deps = effectiveDeps(okNodes)
  const isolated = new Set(okNodes.filter((n) => n.isolate === 'worktree').map((n) => n.id))

  // AUTHORING.md §4: workflow-level worktree (repo id that is git, or {{inputs.X}} of a repo input)
  const wt = draft.worktree ?? null
  let worktreeRepo: string | null = null
  if (wt !== null && wt !== undefined) {
    const repo = typeof wt === 'object' && typeof wt.repo === 'string' ? wt.repo.trim() : ''
    if (!repo) err('worktree', 'Worktree needs a repository')
    else {
      worktreeRepo = repo
      const m = WORKTREE_INPUT.exec(repo)
      if (m) {
        const input = inputs.find((i) => i?.name === m[1])
        if (!input) err('worktree', `Worktree repository ${repo} references unknown input "${m[1]}"`)
        else if (input.type !== 'repo') err('worktree', `Worktree repository ${repo}: input "${m[1]}" must be of type repo`)
      } else if (repo.startsWith('repo_')) {
        const r = deps0.getRepo(repo)
        if (!r) err('worktree', 'Worktree repository no longer exists')
        else if (!r.isGit) err('worktree', `Worktree repository "${r.name}" is not a git repository`)
      } else err('worktree', 'Worktree repository must be a repository or {{inputs.<repo input>}}')
    }
    const base = (wt as { base?: unknown }).base
    if (base !== undefined && base !== null && (typeof base !== 'string' || !BRANCH.test(base)))
      err('worktree', 'Worktree base must be a branch name (or empty for the default branch)')
  }
  const ids = new Set<string>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    if (!NODE_ID.test(n?.id ?? '')) err(n?.id || 'nodes', `Node id "${n?.id ?? ''}" must be a lowercase slug ([a-z][a-z0-9_-]*)`)
    else if (ids.has(n.id)) err(n.id, `Node id "${n.id}" is used twice`)
    ids.add(n?.id)
  }

  const profileOk = (nodeId: string, field: string, id: string | null | undefined, allowShell: boolean): void => {
    if (!id) return err(nodeId, `Node "${nodeId}": pick an agent for ${field}`)
    const p = deps0.getProfile(id)
    if (!p) return err(nodeId, `Node "${nodeId}": agent profile for ${field} no longer exists`)
    if (!allowShell && p.adapter === 'shell') err(nodeId, `Node "${nodeId}": ${field} cannot be a shell profile`)
  }

  for (const n of nodes) {
    if (!n || !NODE_ID.test(n.id ?? '')) continue
    const id = n.id
    if (!(NODE_TYPES as readonly string[]).includes(n.type)) {
      err(id, `Node "${id}": unknown type "${String((n as { type?: unknown }).type)}"`)
      continue
    }
    for (const a of n.after ?? []) {
      if (a === id) err(id, `Node "${id}" cannot run after itself`)
      else if (!byId.has(a)) err(id, `Node "${id}": after references unknown node "${a}"`)
    }
    const t = Number(n.timeoutMin)
    if (!Number.isFinite(t) || t < 1 || t > 1440) err(id, `Node "${id}": timeout must be 1-1440 minutes`)

    // Memory (MEMORY.md 3.3, CONTRACT 11.3). Absent = off.
    const mem = (n as { memory?: unknown }).memory
    if (mem !== undefined && mem !== null) {
      if (!isMemoryMode(mem)) err(id, `Node "${id}": memory must be off, read or read-write`)
      else if (mem !== 'off') {
        if (n.type === 'shell' || n.type === 'wait' || n.type === 'notify' || (n.type === 'check' && !!n.command?.trim()))
          err(id, `Node "${id}": ${n.type === 'notify' ? 'notify' : 'shell'} steps cannot use memory`)
        else if (n.type === 'check' && mem === 'read-write') err(id, `Node "${id}": a reviewer can only read memory`)
      }
    }

    switch (n.type) {
      case 'agent':
        profileOk(id, 'the agent', n.profileId, true)
        if (!n.prompt?.trim()) err(id, `Node "${id}": prompt is empty`)
        break
      case 'room': {
        const ps = Array.isArray(n.participants) ? n.participants : []
        if (ps.length < 2) err(id, `Node "${id}": a room needs at least 2 participants`)
        const labels = new Set<string>()
        ps.forEach((p, i) => {
          profileOk(id, `participant ${i + 1}`, p?.profileId, false)
          const l = p?.label?.trim()
          if (!l) err(id, `Node "${id}": participant ${i + 1} needs a label`)
          else if (labels.has(l)) err(id, `Node "${id}": participant label "${l}" is used twice`)
          if (l) labels.add(l)
        })
        if (!n.topic?.trim()) err(id, `Node "${id}": topic is empty`)
        if (!Number.isInteger(n.rounds) || n.rounds < 1 || n.rounds > 10) err(id, `Node "${id}": rounds must be 1-10`)
        if (n.final !== 'last' && n.final !== 'summary') err(id, `Node "${id}": final must be "last" or "summary"`)
        break
      }
      case 'check': {
        const hasProfile = !!n.profileId
        const hasCommand = !!n.command?.trim()
        if (hasProfile === hasCommand) err(id, `Node "${id}": reviewer must be either an agent or a command`)
        else if (hasProfile) profileOk(id, 'the reviewer', n.profileId, false)
        const target = byId.get(n.target)
        if (!n.target || !target) err(id, `Node "${id}": target "${n.target ?? ''}" does not exist`)
        else if (target.type !== 'agent') err(id, `Node "${id}": target "${n.target}" must be an agent node`)
        if (!Number.isInteger(n.maxRetries) || n.maxRetries < 0 || n.maxRetries > 5)
          err(id, `Node "${id}": retries must be 0-5`)
        if (hasProfile && !n.criteria?.trim()) err(id, `Node "${id}": criteria is empty`)
        break
      }
      case 'shell':
        if (!n.command?.trim()) err(id, `Node "${id}": command is empty`)
        break
      case 'wait': {
        if (!n.command?.trim()) err(id, `Node "${id}": command is empty`)
        if (n.until !== 'exit0' && n.until !== 'match') err(id, `Node "${id}": until must be "exit0" or "match"`)
        else if (n.until === 'match') {
          const pat = typeof n.pattern === 'string' ? n.pattern : ''
          if (!pat) err(id, `Node "${id}": until "match" needs a pattern`)
          else if (pat.length > 500) err(id, `Node "${id}": pattern is longer than 500 characters`)
          else if (pat.includes('{{')) err(id, `Node "${id}": pattern cannot use templates`)
          else
            try {
              new RegExp(pat, 'm')
            } catch (e) {
              err(id, `Node "${id}": pattern is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`)
            }
        }
        if (!Number.isInteger(n.intervalSec) || n.intervalSec < 5 || n.intervalSec > 3600)
          err(id, `Node "${id}": interval must be 5-3600 seconds`)
        if (n.onTimeout !== 'fail' && n.onTimeout !== 'continue') err(id, `Node "${id}": on timeout must be "fail" or "continue"`)
        break
      }
      case 'notify':
        if (!n.message?.trim()) err(id, `Node "${id}": message is empty`)
        if (typeof n.title !== 'string') err(id, `Node "${id}": title must be text`)
        else if (n.title.length > 200) err(id, `Node "${id}": title is longer than 200 characters`)
        // SLACK.md §10.4: iMessage was removed; `slack` is the target. A legacy boolean `imessage` is tolerated (read as slack me).
        {
          const se = notifySlackError(n.slack)
          if (se) err(id, `Node "${id}": ${se}`)
          const im = (n as { imessage?: unknown }).imessage
          if (im !== undefined && im !== null && typeof im !== 'boolean') err(id, `Node "${id}": imessage was removed; use slack: {"kind":"me"}`)
        }
        break
    }

    // AUTHORING.md §4: isolate
    const iso = (n as { isolate?: unknown }).isolate
    if (iso !== undefined && iso !== null && iso !== 'worktree') err(id, `Node "${id}": isolate must be "worktree" or empty`)
    else if (iso === 'worktree') {
      if (n.type === 'notify') err(id, `Node "${id}": a notify node cannot run in a worktree`)
      else if (!worktreeRepo) err(id, `Node "${id}": isolate needs a workflow worktree repo`)
      else if (n.cwd && n.cwd.trim() !== worktreeRepo)
        err(id, `Node "${id}": an isolated node runs in the worktree; leave its folder empty or equal to the worktree repo`)
    }

    for (const { field, text } of nodeTexts(n)) {
      for (const r of parseRefs(text)) {
        if (r.kind === 'invalid') err(id, `Node "${id}": ${r.raw} in ${field} is not a valid template`)
        else if (r.kind === 'trigger' && isCommandField(n, field))
          err(id, `Node "${id}": ${r.raw} in ${field}: ${TRIGGER_IN_COMMAND}`)
        else if (r.kind === 'trigger' && field === 'cwd') err(id, `Node "${id}": ${r.raw} cannot choose a folder`)
        else if (r.kind === 'input' && !inputNames.has(r.name))
          err(id, `Node "${id}": ${r.raw} references unknown input "${r.name}"`)
        else if (r.kind === 'node') {
          if (r.nodeId === id) err(id, `Node "${id}": ${r.raw} references itself`)
          else if (!byId.has(r.nodeId)) err(id, `Node "${id}": ${r.raw} references unknown node "${r.nodeId}"`)
        } else if (r.kind === 'worktree' && !isolated.has(id)) {
          const anc = ancestors(deps, id)
          if (![...anc].some((a) => isolated.has(a)))
            err(id, `Node "${id}": ${r.raw} is used before the worktree is created (make this node isolated or run it after an isolated node)`)
        }
      }
    }
    if (n.cwd && n.type !== 'notify' && !n.cwd.includes('{{')) {
      if (n.cwd.startsWith('repo_')) {
        if (!deps0.getRepo(n.cwd)) err(id, `Node "${id}": folder (repository) no longer exists`)
      } else if (!isAbsolute(n.cwd)) err(id, `Node "${id}": folder must be a repository or an absolute path`)
    }
  }

  const st = (draft as { slackTools?: unknown }).slackTools
  if (st !== undefined && st !== null && typeof st !== 'boolean') err('slackTools', 'slackTools must be true or false')
  if (draft.slackAgentPermissions !== undefined && !['restricted', 'profile'].includes(draft.slackAgentPermissions)) err('slackAgentPermissions', 'Slack agent permissions must be restricted or profile')
  if (draft.slackAgentPermissions === 'profile' && st !== true) err('slackAgentPermissions', 'Enable Slack tools before choosing profile permissions')
  if (deps0.slackTriggered || st === true) errs.push(...slackOutputInCommands({ nodes: okNodes }))

  const { cycle } = topoOrder(deps)
  if (cycle?.length) err(cycle[0], `Nodes ${cycle.map((c) => `"${c}"`).join(', ')} form a cycle`)
  return errs
}

// ---------- Slack triggers (SLACK.md §9.1, §9.2, §9.5; PO-S3c, PO-S9) ----------

export const SLACK_TRIGGER_ON = ['mention', 'dm', 'message'] as const
export const SLACK_REGEX_MAX = 300
/** A trigger regex must not take longer than this on any probe string (catastrophic backtracking guard). */
export const SLACK_REGEX_PROBE_MS = 50

/**
 * Catastrophic-backtracking probe (SLACK.md §9.1). JS regexes cannot be interrupted, so the probe grows adversarial
 * strings step by step and stops at the first one slower than `budgetMs`: an exponential pattern is caught at a short
 * length, long before it could hang. null = OK, else a readable reason.
 */
export function regexProbe(source: string, budgetMs = SLACK_REGEX_PROBE_MS): string | null {
  let re: RegExp
  try {
    re = new RegExp(source, 'i')
  } catch (e) {
    return `regex is not valid (${e instanceof Error ? e.message : String(e)})`
  }
  // characters the pattern talks about, plus the usual suspects
  const found: string[] = source.replace(/\\[a-zA-Z]/g, '').match(/[a-zA-Z0-9 ._@:-]/g) ?? []
  const lits = [...new Set([...found, 'a', '0', ' ', '.', '-'])].slice(0, 12)
  const units = [...lits, lits.join(''), 'ab', 'a0 ', 'aaaa ']
  const tails = ['!', '\u0000', '\n!', '']
  for (let n = 8; n <= 40; n += 4) {
    for (const u of units) {
      const body = u.repeat(Math.max(1, Math.ceil(n / Math.max(1, u.length)))).slice(0, Math.max(n, u.length))
      for (const t of tails) {
        const s = body + t
        const t0 = performance.now()
        re.lastIndex = 0
        re.test(s)
        if (performance.now() - t0 > budgetMs) return 'regex is too slow on repetitive text (catastrophic backtracking); simplify it'
      }
    }
  }
  return null
}

export interface SlackTriggerValidateDeps {
  /** The trigger's workflow (null = not found). */
  workflow: WorkflowDraft | null
}

/**
 * Save-time validation of a Slack trigger (pure). Used by main's slackTriggers:create/update, by authoring
 * (`slack_trigger` on hive_workflow_create/update/validate) and by the engine's test(). [] = valid.
 */
export function validateSlackTrigger(input: SlackTriggerInput, deps: SlackTriggerValidateDeps): ValidationError[] {
  const errs: ValidationError[] = []
  const err = (path: string, message: string): void => void errs.push({ path, message })
  if (!input || typeof input !== 'object') return [{ path: 'trigger', message: 'Trigger is empty' }]
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) err('name', 'Name is required')
  else if (name.length > 120) err('name', 'Name is longer than 120 characters')
  const wf = deps.workflow
  if (!wf) err('workflowId', 'Workflow not found')
  // a Slack trigger makes the workflow Slack-driven: no step output may run as shell in it
  else for (const e of slackOutputInCommands(wf)) err('workflowId', `${e.message} (fix the workflow before adding a Slack trigger)`)

  const m = (input.match ?? {}) as Partial<SlackTriggerInput['match']>
  const on = Array.isArray(m.on) ? m.on : []
  if (!on.length) err('match.on', 'Pick when it fires: mention, DM or message')
  for (const o of on) if (!(SLACK_TRIGGER_ON as readonly string[]).includes(o)) err('match.on', `Unknown trigger "${String(o)}" (mention, dm or message)`)
  if (new Set(on).size !== on.length) err('match.on', 'A condition is listed twice')
  const channels = Array.isArray(m.channels) ? m.channels : []
  if (channels.length > 50) err('match.channels', 'At most 50 channels')
  for (const c of channels) if (typeof c !== 'string' || !SLACK_CHANNEL_ID.test(c)) err('match.channels', `"${String(c)}" is not a channel id (C…/G…)`)
  if (on.includes('message') && !channels.length) err('match.channels', 'Pick at least one channel for "any message"')
  const keywords = Array.isArray(m.keywords) ? m.keywords : []
  if (keywords.length > 20) err('match.keywords', 'At most 20 keywords')
  for (const k of keywords)
    if (typeof k !== 'string' || !k.trim() || k.length > 100) err('match.keywords', 'Each keyword is 1-100 characters')
  const regex = m.regex ?? null
  if (regex !== null) {
    if (typeof regex !== 'string') err('match.regex', 'regex must be text or null')
    else if (regex.length > SLACK_REGEX_MAX) err('match.regex', `regex is longer than ${SLACK_REGEX_MAX} characters`)
    else if (regex.trim()) {
      const why = regexProbe(regex)
      if (why) err('match.regex', why)
    }
  }
  const fromUsers = Array.isArray(m.fromUsers) ? m.fromUsers : []
  if (fromUsers.length > 50) err('match.fromUsers', 'At most 50 people')
  for (const u of fromUsers) if (typeof u !== 'string' || !SLACK_USER_ID.test(u)) err('match.fromUsers', `"${String(u)}" is not a user id (U…)`)

  const r = (input.reply ?? {}) as Partial<SlackTriggerInput['reply']>
  const mode = r.mode ?? 'draft'
  if (mode !== 'draft' && mode !== 'auto' && mode !== 'none') err('reply.mode', 'Reply mode must be draft, auto or none')
  const autoChannels = Array.isArray(r.autoChannels) ? r.autoChannels : []
  if (autoChannels.length > 20) err('reply.autoChannels', 'At most 20 auto channels')
  for (const c of autoChannels)
    if (c !== 'dm' && c !== '*' && (typeof c !== 'string' || !SLACK_CHANNEL_ID.test(c))) err('reply.autoChannels', `"${String(c)}" is not a channel id or "dm"`)
  if (autoChannels.includes('*') && on.includes('message')) err('reply.autoChannels', '"Anywhere" auto replies are only for mentions and DMs (someone addressed @hive), not "any message"')
  if (mode === 'auto') {
    if (!autoChannels.length) err('reply.autoChannels', 'Auto mode needs at least one allow-listed channel (or "dm")')
    const blocked = autoModeProblem({ on: on as SlackTriggerOn[], keywords: keywords.filter((k) => typeof k === 'string'), regex: typeof regex === 'string' ? regex : null, fromUsers })
    if (blocked) err('reply.mode', blocked)
  }
  const replyNode = r.replyNode ?? null
  if (replyNode !== null && wf) {
    const node = (wf.nodes ?? []).find((n) => n.id === replyNode)
    if (!node) err('reply.replyNode', `Reply node "${replyNode}" is not in the workflow`)
    else if (node.type === 'notify' || node.type === 'check') err('reply.replyNode', `Reply node "${replyNode}" must be an agent, room, shell or wait node`)
  }

  const l = (input.limits ?? {}) as Partial<SlackTriggerInput['limits'] & object>
  if (l.debounceSec !== undefined && (!Number.isInteger(l.debounceSec) || l.debounceSec < 0 || l.debounceSec > 600))
    err('limits.debounceSec', 'Debounce must be 0-600 seconds')
  if (l.maxRunsPerThreadPerHour !== undefined && (!Number.isInteger(l.maxRunsPerThreadPerHour) || l.maxRunsPerThreadPerHour < 1 || l.maxRunsPerThreadPerHour > 30))
    err('limits.maxRunsPerThreadPerHour', 'Runs per thread per hour must be 1-30')

  // inputs: workflow input name -> template over {{trigger.*}} and literals only
  const map = input.inputs ?? {}
  if (typeof map !== 'object' || Array.isArray(map)) err('inputs', 'inputs must map workflow input names to templates')
  else if (wf) {
    const defs = new Map((wf.inputs ?? []).map((i) => [i.name, i]))
    const inCommands = new Set(commandInputs(wf))
    for (const [k, v] of Object.entries(map)) {
      const def = defs.get(k)
      if (!def) {
        err('inputs', `"${k}" is not an input of this workflow`)
        continue
      }
      if (typeof v !== 'string' || v.length > 2000) {
        err('inputs', `Input "${k}": the value must be text up to 2,000 characters`)
        continue
      }
      const refs = parseRefs(v)
      for (const ref of refs) if (ref.kind !== 'trigger') err('inputs', `Input "${k}": ${ref.raw} is not allowed here; use {{trigger.*}} or plain text`)
      const fromSlack = refs.some((ref) => ref.kind === 'trigger')
      if (fromSlack && inCommands.has(k)) err('inputs', `Input "${k}" is used in a command: ${TRIGGER_IN_COMMAND}`)
      if (fromSlack && def.type === 'repo') err('inputs', `Input "${k}" picks a repository; Slack text cannot choose it`)
      if (def.type === 'boolean' && (fromSlack || !isBooleanValue(v))) err('inputs', `Input "${k}" is a checkbox: map it to true or false`)
    }
    for (const d of wf.inputs ?? [])
      if (d.type !== 'boolean' && (d.default === undefined || d.default === '') && !(d.name in map))
        err('inputs', `Input "${d.name}" has no default: map it (e.g. {{trigger.text}})`)
  }
  return errs
}
