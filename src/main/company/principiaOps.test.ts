import { describe, expect, it } from 'vitest'
import { approxTokens, bareTool, OPS_TITLE, principiaOps, principiaOpsReminder, TASK_STARTED_RULE } from './principiaOps'
import { buildReplyPrompt } from '../forum/responder'

const CHAT_TOOLS = [
  'mcp__hive__task_get', 'mcp__hive__task_list', 'mcp__hive__task_comment', 'mcp__hive__task_report', 'mcp__hive__task_ask', 'mcp__hive__task_create', 'mcp__hive__task_handoff',
  'mcp__hive__task_update', 'mcp__hive__company_departments', 'mcp__hive__company_file_task', 'mcp__hive__company_create_department', 'mcp__hive__hive_workflow_create',
  'mcp__hive__principia_propose_company', 'mcp__hivemem__memory_search', 'mcp__hivemem__memory_get', 'mcp__hivemem__memory_write'
]
const TASK_TOOLS = ['task_get', 'task_list', 'task_comment', 'task_report', 'task_ask', 'task_create', 'task_handoff', 'memory_search', 'memory_get', 'memory_write',
  'forum_read', 'forum_post', 'forum_ask_agent', 'team_activity', 'team_usage', 'team_board']

describe('principiaOps (PROACTIVE.md §1)', () => {
  it('strips server prefixes', () => {
    expect(bareTool('mcp__hive__task_list')).toBe('task_list')
    expect(bareTool('mcp__principia-forum__team_board')).toBe('team_board')
    expect(bareTool('hivemem.memory_get')).toBe('memory_get')
    expect(bareTool('task_get')).toBe('task_get')
  })

  it('a claude chat gets every trigger, imperative and under 600 tokens', () => {
    const ops = principiaOps({ kind: 'chat', tools: CHAT_TOOLS })
    expect(ops.startsWith(OPS_TITLE)).toBe(true)
    for (const t of ['task_create', 'task_update', 'in_progress', 'in_review', 'company_file_task', 'task_list {scope:"open"}', 'never file a duplicate', 'memory_search', 'memory_write', 'hive_workflow_create', 'Department dashboards', 'costs money'])
      expect(ops).toContain(t)
    expect(ops).toContain('two or more separate things')
    expect(ops).toContain('own words')
    // task-run rules never leak into a chat
    expect(ops).not.toContain('task_handoff')
    expect(ops).not.toContain('forum_ask_agent')
    expect(approxTokens(ops)).toBeLessThan(600)
  })

  it('a headless task turn gets the team, comment, handoff and memory rules', () => {
    const ops = principiaOps({ kind: 'task', tools: TASK_TOOLS })
    for (const t of ['team_board', 'task_comment', 'Handoff:', 'task_create', 'task_handoff', 'forum_ask_agent', 'memory_write', 'task_report', 'task_ask the founder first'])
      expect(ops).toContain(t)
    expect(ops).not.toContain('task_update')
    expect(ops).not.toContain('company_file_task')
    expect(approxTokens(ops)).toBeLessThan(600)
  })

  it('names only attached tools: a codex chat with memory only, and nothing at all', () => {
    const ops = principiaOps({ kind: 'chat', tools: ['hivemem.memory_search', 'hivemem.memory_get', 'hivemem.memory_write'] })
    expect(ops).toContain('memory_search')
    expect(ops).not.toMatch(/task_|company_file_task|hive_workflow_create/)
    expect(principiaOps({ kind: 'chat', tools: [] })).toBe('')
    expect(principiaOps({ kind: 'task', tools: ['Read', 'Bash'] })).toBe('')
  })

  it('a repo session without company tools tracks its own work but files nothing', () => {
    const ops = principiaOps({ kind: 'session', tools: CHAT_TOOLS.filter((t) => !t.includes('company_')) })
    expect(ops).toContain('task_update')
    expect(ops).not.toContain('company_file_task')
  })

  it('"Track work as tasks": off drops the tracking rules, always tracks every multi-step turn', () => {
    const auto = principiaOps({ kind: 'chat', tools: CHAT_TOOLS })
    expect(auto).toContain('"just do it"')
    expect(principiaOps({ kind: 'chat', tools: CHAT_TOOLS, track: 'auto' })).toBe(auto)
    const off = principiaOps({ kind: 'chat', tools: CHAT_TOOLS, track: 'off' })
    expect(off).not.toContain('task_update')
    expect(off).toContain('company_file_task')
    const always = principiaOps({ kind: 'chat', tools: CHAT_TOOLS, track: 'always' })
    expect(always).toContain('Track every multi-step turn')
    expect(approxTokens(always)).toBeLessThan(600)
  })

  it('connections: missing tools come with their principia://connect link, never a password request', () => {
    const chat = principiaOps({ kind: 'chat', tools: [...CHAT_TOOLS, 'mcp__hive__connections_list', 'mcp__principia__principia_list_tools', 'mcp__principia__principia_call_tool'] })
    expect(chat).toContain('principia://connect/stripe')
    expect(chat).toContain('Settings › Connections')
    expect(chat).toContain('Never ask for passwords')
    expect(chat).toContain('principia_list_tools')
    expect(approxTokens(chat)).toBeLessThan(700)
    const task = principiaOps({ kind: 'task', tools: [...TASK_TOOLS, 'connections_list'] })
    expect(task).toContain('connections_list')
    expect(task).toContain('task_ask the founder first')
    expect(approxTokens(task)).toBeLessThan(600)
    // without the tool, no connect rule (the generic principia:// line stays)
    expect(principiaOps({ kind: 'chat', tools: CHAT_TOOLS })).not.toContain('connections_list')
    expect(principiaOps({ kind: 'chat', tools: CHAT_TOOLS })).toContain('principia://board?task=NC-12')
  })

  it('Principia itself: principia_help, with its link, never a guess or "ask support"', () => {
    const chat = principiaOps({ kind: 'chat', tools: [...CHAT_TOOLS, 'mcp__hive__connections_list', 'mcp__hive__principia_help'] })
    expect(chat).toContain('Questions about Principia itself')
    expect(chat).toContain('call principia_help')
    expect(chat).toContain('principia:// link')
    expect(chat).toContain('send the founder to support')
    expect(approxTokens(chat)).toBeLessThan(760)
    for (const kind of ['session', 'task'] as const) expect(principiaOps({ kind, tools: [...TASK_TOOLS, 'hivemem.principia_help'] })).toContain('call principia_help')
    // the tool alone is enough for the section; without it, no rule
    expect(principiaOps({ kind: 'chat', tools: ['principia_help'] })).toContain('call principia_help')
    expect(principiaOps({ kind: 'chat', tools: CHAT_TOOLS })).not.toContain('principia_help')
  })

  it('a task filed from a chat is said plainly, never "on the Board", and never filed twice (CHAT-UI.md §8)', () => {
    const chat = principiaOps({ kind: 'chat', tools: CHAT_TOOLS })
    expect(chat).toContain(`say "I started VO-9: <title>. I'll post the result here."`)
    expect(chat).toContain(`never "It's on the Board"`)
    expect(chat).toContain('task_list {scope:"open"} first and never file a duplicate (even one a teammate just filed)')
    expect(TASK_STARTED_RULE).toContain("I'll post the result here")
    // only where a task can be filed
    expect(principiaOps({ kind: 'chat', tools: ['hivemem.memory_search'] })).not.toContain('I started')
    // the Forum reply rules (a teammate's reply run) say the same
    const reply = buildReplyPrompt({ seat: { name: 'Growth Analyst', instructions: '' }, department: 'Marketing', me: 'julia', channel: '#chat-ugc', messages: [{ ref: 'm1', author: 'you', text: 'get more conversion' }], thread: [], replyTo: 'm1' })
    expect(reply).toContain(TASK_STARTED_RULE)
    expect(reply).toContain('"text":"I started {task}: <title>. I\'ll post the result here."')
    expect(reply).toContain('do not file another: say who is on it')
    expect(reply).not.toMatch(/say (in your reply )?that it is on the Board/)
  })

  it('the reminder repeats the rules', () => {
    const ops = principiaOps({ kind: 'chat', tools: CHAT_TOOLS })
    expect(principiaOpsReminder(ops)).toContain(ops)
    expect(principiaOpsReminder('')).toBe('')
  })
})

describe('principiaOps: the company browser', () => {
  it('names the browser only when its tools are attached', () => {
    const without = principiaOps({ tools: ['memory_search'], kind: 'chat' })
    expect(without).not.toContain('browser')
    const withB = principiaOps({ tools: ['memory_search', 'mcp__principia-browser__browser_navigate', 'mcp__principia-browser__browser_snapshot'], kind: 'chat' })
    expect(withB).toContain('You have a browser in Principia')
    expect(withB).toContain('the founder can watch it')
    expect(withB).toContain('rather than any other browser tool')
    expect(approxTokens(withB)).toBeLessThan(600)
    expect(principiaOps({ tools: ['browser_navigate'], kind: 'task' })).toContain('browser_snapshot')
  })
})
