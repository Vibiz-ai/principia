/**
 * DEPARTMENTS.md §9 "Chats that know the company": where a chat runs and what it is told, on top of the Passport block
 * (the company card, and for a department chat the department slot, which the engine adds through passportContext).
 * Pure: the caller (hive.ts chatContext) passes the company's repos, departments, agents and tasks.
 *
 * - Company chat: the company's repos (name + path, all reachable with --add-dir) and its departments (name + charter
 *   one-liner). cwd: the company's only repo when it has exactly one, else the company workspace.
 * - Department chat: the department's agents (name, role) and open tasks (title, status, assignee; capped), and the
 *   repos. cwd: the one repo its agents default to, else the company's only repo, else the workspace.
 * - Both: answer and do the work in the chat by default; propose filing work into a department only when it clearly
 *   belongs to that department's charter, and file it (company_file_task) only after the user agrees or asks.
 */
import type { BoardTask, CompanyAgent, Department } from '../../shared/company'

/** Caps on what one chat brief lists (the Passport block has its own). */
export const CHAT_CAPS = { repos: 20, departments: 12, agents: 12, tasks: 15, line: 160 } as const

export interface ChatRepo {
  id: string
  name: string
  path: string
  exists: boolean
}
export interface ChatContextInput {
  company: { id: string; name: string }
  repos: readonly ChatRepo[]
  departments: readonly Department[]
  agents: readonly CompanyAgent[]
  tasks: readonly BoardTask[]
  /** null = the company chat */
  departmentId: string | null
  /** the chat can call company_file_task / company_departments (claude with the board on) */
  fileTool: boolean
}
export interface ChatPlacement {
  /** the chat's cwd; null = the company workspace */
  cwd: string | null
  /** the company's other repo folders, for --add-dir (absolute, existing, never the cwd) */
  addDirs: string[]
  /** appended to the Passport block (claude --append-system-prompt, codex developer_instructions) */
  brief: string
  /** the department of a department chat (null for the company chat) */
  department: Pick<Department, 'id' | 'key' | 'name'> | null
}

const OPEN = (t: Pick<BoardTask, 'status'>): boolean => t.status !== 'done' && t.status !== 'canceled'
const one = (s: string, max: number = CHAT_CAPS.line): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}
/** An agent as the founder sees it: its persona's name and its role label ("Ada (Copywriter)"), or the role alone. */
export function agentLine(a: Pick<CompanyAgent, 'name' | 'data'>): string {
  const persona = a.data.persona?.name?.trim()
  return persona && persona !== a.name ? `${persona} (${a.name})` : a.name
}
const rank = (p: number): number => (p === 0 ? 5 : p)

/** The repo a chat runs in (see the module doc), or null for the workspace. */
export function chatRepo(input: Pick<ChatContextInput, 'repos' | 'agents' | 'departmentId'>): ChatRepo | null {
  const repos = input.repos.filter((r) => r.exists)
  if (input.departmentId) {
    const ids = new Set(
      input.agents.filter((a) => a.departmentId === input.departmentId && !a.archivedAt && a.data.defaultRepoId).map((a) => a.data.defaultRepoId as string)
    )
    const used = repos.filter((r) => ids.has(r.id))
    if (used.length === 1) return used[0]!
  }
  return repos.length === 1 ? repos[0]! : null
}

/** Where the chat runs, which folders it may reach, and its brief. A department of another company counts as none. */
export function chatPlacement(input: ChatContextInput): ChatPlacement {
  const dep = input.departmentId ? (input.departments.find((d) => d.id === input.departmentId && d.companyId === input.company.id) ?? null) : null
  const at = chatRepo({ ...input, departmentId: dep?.id ?? null })
  const addDirs = input.repos.filter((r) => r.exists && r.path.startsWith('/') && r.id !== at?.id).map((r) => r.path).slice(0, CHAT_CAPS.repos)
  return { cwd: at?.path ?? null, addDirs, brief: chatBrief({ ...input, departmentId: dep?.id ?? null }, at), department: dep ? { id: dep.id, key: dep.key, name: dep.name } : null }
}

/** The routing rules both chats follow (DEPARTMENTS.md §9). */
export function routingRules(fileTool: boolean, inDepartment: string | null): string[] {
  const how = fileTool
    ? 'call the company_file_task tool (departmentKey, title, description, reason) only after the user says yes, or when they explicitly ask you to send it there'
    : 'if the user agrees, tell them to file it on the Board for that department'
  return [
    '### How to work in this chat',
    '- Answer and do the work here in the chat by default. Most requests are for you.',
    `- Only when a request clearly belongs to ${inDepartment ? 'another' : 'one'} department's charter and is work for later or for that department's agents, propose filing it there (say which department and why), then ${how}.`,
    '- Never file or route work on your own initiative, and never file the same request twice.',
    ...(fileTool ? ['- When the user asks for a department that does not exist yet (or agrees to one you propose), create it with company_create_department; its agents are hired in Principia.'] : [])
  ]
}

/** The chat brief text (the "This chat" section). */
export function chatBrief(input: ChatContextInput, at: ChatRepo | null = chatRepo(input)): string {
  const company = one(input.company.name, 80)
  const dep = input.departmentId ? (input.departments.find((d) => d.id === input.departmentId) ?? null) : null
  const out: string[] = []
  const where = at ? `You run in the ${one(at.name, 60)} repository.` : `You run in ${company}'s workspace folder.`
  if (dep) {
    out.push(`## This chat: the ${one(dep.name, 60)} department of ${company}`)
    out.push(`The founder opened this chat inside ${one(dep.name, 60)}: think and work as that department, within its charter (the department section above). ${where}`)
  } else {
    out.push(`## This chat: ${company}`)
    out.push(`The founder is chatting with you about ${company}. Use the company card above. ${where}`)
  }

  const repos = input.repos.filter((r) => r.exists).slice(0, CHAT_CAPS.repos)
  if (repos.length) {
    out.push('', `### Repositories of ${company} (you can read and edit them)`)
    for (const r of repos) out.push(`- ${one(r.name, 60)}: ${r.path}${at?.id === r.id ? ' (current folder)' : ''}`)
  }

  if (dep) {
    const agents = input.agents.filter((a) => a.departmentId === dep.id && !a.archivedAt)
    out.push('', `### Agents in ${one(dep.name, 60)}`)
    if (!agents.length) out.push('- none yet')
    for (const a of agents.slice(0, CHAT_CAPS.agents)) out.push(`- ${one(agentLine(a), 80)}${a.pausedAt ? ' · paused' : ''}${a.data.capabilities.trim() ? `: ${one(a.data.capabilities, 120)}` : ''}`)
    const names = new Map(input.agents.map((a) => [a.id, agentLine(a)]))
    const open = input.tasks
      .filter((t) => t.departmentId === dep.id && OPEN(t))
      .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress') || rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt))
    out.push('', `### Open tasks in ${one(dep.name, 60)} (${open.length})`)
    if (!open.length) out.push('- none')
    for (const t of open.slice(0, CHAT_CAPS.tasks)) out.push(`- ${t.identifier} ${one(t.title, 100)} · ${t.status.replace('_', ' ')} · ${t.agentId ? one(names.get(t.agentId) ?? 'an agent', 60) : 'unassigned'}`)
    if (open.length > CHAT_CAPS.tasks) out.push(`- and ${open.length - CHAT_CAPS.tasks} more on the Board`)
  }

  const departments = input.departments.filter((d) => d.companyId === input.company.id && !d.archivedAt && d.id !== dep?.id).slice(0, CHAT_CAPS.departments)
  if (departments.length) {
    out.push('', dep ? `### Other departments of ${company}` : `### Departments of ${company}`)
    for (const d of departments) out.push(`- ${one(d.name, 60)} (${d.key})${d.data.charter.does.trim() ? `: ${one(d.data.charter.does, 140)}` : ''}`)
  }
  if (departments.length || dep) out.push('', ...routingRules(input.fileTool, dep ? dep.name : null))
  return out.join('\n')
}
