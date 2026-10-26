/**
 * PROACTIVE.md §1: the "Use Principia" operating section, pure. Built from the tools actually attached to one spawn
 * (a chat, a repo session, a headless task run), so it never names a tool the agent does not have. Each rule is an
 * imperative trigger ("When X, call Y") listed only when its tools are there. Kept under about 600 tokens.
 *
 * Safe by construction: what it makes automatic (tracking and filing tasks, comments, memory writes, asking a
 * teammate) is capped and reviewed by the board, the collab guards and the memory review queue; what costs money,
 * publishes outside the company, deletes or creates a company or department stays behind the founder's yes.
 */

export type OpsKind = 'chat' | 'session' | 'task'
/** Settings → "Track work as tasks" (shared/types.ts TrackTasks). Absent = 'auto'. */
export type OpsTrack = 'off' | 'auto' | 'always'
export interface OpsInput {
  /** tool names as attached (mcp__hive__task_create, hivemem.memory_search or bare) */
  tools: Iterable<string>
  /** chat: a company or department chat; session: an interactive pane in a repo; task: a headless task turn */
  kind: OpsKind
  /** how a chat tracks its own work: off (never unasked), auto (2+ separate things or multi-step work), always (every multi-step turn) */
  track?: OpsTrack
}

/** `mcp__hive__task_list` / `hivemem.memory_get` / `principia-forum__team_board` → the bare tool name. */
export function bareTool(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name)
  if (m) return m[1]!
  const i = Math.max(name.lastIndexOf('.'), name.lastIndexOf('/'))
  return i >= 0 ? name.slice(i + 1) : name
}

export const OPS_TITLE = '## Use Principia (on your own, without being asked)'

interface Rule {
  /** listed only when every group has at least one of its tools attached */
  needs: string[][]
  kinds: readonly OpsKind[]
  text: string
  /** the chat-tracking rules: listed per OpsTrack (absent = always listed) */
  track?: readonly OpsTrack[]
}
const CHATS: readonly OpsKind[] = ['chat', 'session']
const ALL: readonly OpsKind[] = ['chat', 'session', 'task']

const RULES: readonly Rule[] = [
  // tracking the chat's own work (task_create from a session holding no task tracks it; task_update moves it)
  {
    needs: [['task_create'], ['task_update']],
    kinds: CHATS,
    track: ['auto'],
    text: 'When one message asks for two or more separate things (fixes, features, changes) or for multi-step work, before working open one task per thing with task_create (parent groups them), then task_update each: in_progress when you start it, in_review once built and checked (note: what you did, how you checked). Never for questions, a quick ask, or when the founder says "just do it" or "no tasks".'
  },
  {
    needs: [['task_create'], ['task_update']],
    kinds: CHATS,
    track: ['always'],
    text: 'Track every multi-step turn: before working open a task per separate thing with task_create (parent groups them), then task_update each: in_progress when you start it, in_review once built and checked (note: what you did, how you checked). Skip only questions, or when the founder says "no tasks".'
  },
  {
    needs: [['task_update'], ['task_comment']],
    kinds: CHATS,
    track: ['auto', 'always'],
    text: 'Keep your tasks true: task_comment each decision with the why; tick "- [x]" criteria and, before ending a turn that changed things, rewrite the handoff notes (task_update description: where it stands, what is left, gotchas).'
  },
  {
    needs: [['company_file_task']],
    kinds: CHATS,
    text: 'When work belongs to another department, its agents, or later: task_list {scope:"open"} first and never file a duplicate, then company_file_task to the department whose charter fits (company_departments), instead of only suggesting it. New detail on it later: task_comment {id}.'
  },
  // headless task turns
  {
    needs: [['team_board', 'team_activity', 'task_list']],
    kinds: ['task'],
    text: 'Before starting: team_board / team_activity (or task_list) show what teammates run right now; never redo or re-file it.'
  },
  {
    needs: [['task_comment']],
    kinds: ['task'],
    text: 'While working: task_comment after each milestone and each decision (with the why). Before your closing call, task_comment a "Handoff:" note (where it stands, what is left, gotchas) for the next agent.'
  },
  {
    needs: [['task_create']],
    kinds: ['task'],
    text: 'Work with separate parts: split it with task_create (subtasks; blocksCurrent when you need the result first). Follow-up work you notice but should not do now: task_create it rather than only naming it in your report.'
  },
  {
    needs: [['task_handoff', 'forum_ask_agent']],
    kinds: ['task'],
    text: "Work outside your department's charter: task_handoff the task or task_create {departmentKey} for a piece; a quick question for a teammate: forum_ask_agent. Never do another department's work silently."
  },
  // everyone
  {
    needs: [['memory_search', 'memory_get']],
    kinds: ALL,
    text: 'Before answering about the company (customers, product, past decisions, who owns what): memory_search / memory_get first; answer from what they return and say when nothing is recorded.'
  },
  {
    needs: [['memory_write']],
    kinds: ALL,
    text: 'After a decision or a new durable fact (price, customer, convention, owner): memory_write it, one fact per line (it is reviewed before others rely on it).'
  },
  {
    needs: [['hive_workflow_create']],
    kinds: CHATS,
    text: 'Recurring needs ("every Monday"): if a ready-made routine fits (morning-brief, weekly-review, inbox-triage, social-drafts), give its link (principia://automations/routines?add=morning-brief, plus &at=6:30&days=tue-sun for another time: they press Turn on or Save); else propose one with hive_workflow_create (schedule).'
  },
  // connections (principia://connect links): what is missing, said plainly, with the link that fixes it
  {
    needs: [['connections_list']],
    kinds: ALL,
    text: 'When a tool or service would help but is not connected (Instagram, Stripe, a CRM, their own MCP server), say so in plain words and give the founder its link from connections_list, like principia://connect/stripe: it opens that card in Settings › Connections, where they sign in. Never ask for passwords or keys in the chat.'
  },
  {
    needs: [['principia_list_tools']],
    kinds: ALL,
    text: "The company's connected tools (Notion, Stripe, …) are behind principia_list_tools / principia_call_tool: list them when one could help."
  },
  // BROWSER.md §3: the company browser
  {
    needs: [['browser_navigate']],
    kinds: ALL,
    text: "You have a browser in Principia (browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot); the founder can watch it beside this chat and take over. Use it to look at websites instead of guessing, and use it rather than any other browser tool or skill. If the founder takes over, browser_wait and try again; do not end your turn. Never type passwords or card numbers or pay without the founder's yes."
  },
  {
    needs: [['task_report']],
    kinds: ['task'],
    text: 'A recurring need you notice: say so in task_report so the founder can schedule it, with the routine link when one fits (principia://automations/routines?add=weekly-review).'
  }
]

const HEAD: Record<OpsKind, string> = {
  chat: "Principia's board, memory and workflows are your working tools: use them as below without asking first.",
  session: "Principia's board, memory and workflows are your working tools: use them as below without asking first.",
  task: "Principia's board, team and memory are your working tools: use them as below without asking first."
}
const TAIL = [
  'Metrics questions: use the "Department dashboards" numbers above with their date; never invent numbers.',
  'To point the founder at a page, write its principia:// link (principia://board?task=NC-12, principia://settings/keys); it opens there in Principia.',
  'Ask the founder first before anything that costs money, publishes or sends outside the company, deletes data, or creates a company or department.'
]
const VOICE = 'Write tasks in your own words, never the message pasted in, and name each task you open or move by its identifier (like NC-12) in your answer. The founder\'s explicit wishes override these defaults.'

/** The section for one spawn, or '' when none of Principia's tools are attached. */
export function principiaOps(input: OpsInput): string {
  const have = new Set([...input.tools].map(bareTool))
  const track = input.track ?? 'auto'
  const rules = RULES.filter((r) => r.kinds.includes(input.kind) && (!r.track || r.track.includes(track)) && r.needs.every((g) => g.some((t) => have.has(t))))
  if (!rules.length) return ''
  const tail = input.kind === 'task' ? [TAIL[0]!, TAIL[1]!, TAIL[2]!.replace('Ask the founder first', 'task_ask the founder first')] : TAIL
  return [OPS_TITLE, `${HEAD[input.kind]} ${input.kind === 'task' ? '' : VOICE}`.trim(), ...[...rules.map((r) => r.text), ...tail].map((t) => `- ${t}`)].join('\n')
}

/** Sent on a resumed or compacted conversation: the rules again, marked as still in force. */
export function principiaOpsReminder(ops: string): string {
  return ops ? `Principia reminder (this conversation was resumed or compacted): these operating rules still apply.\n\n${ops}` : ''
}

/** A rough token count (about 4 characters per token for English prose); the tests keep the section under 600. */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4)
