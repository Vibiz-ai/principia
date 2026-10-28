/**
 * Five doors §2.6: LIVE's second line is a sentence, never a raw tool line. The live tracker records what the agent
 * last did as "<Tool> <argument>" (e.g. `Bash cd "/private/tmp/…" && npm test`), which is right for the technical
 * view and wrong for the sidebar. This turns a tool line into words and keeps anything else as it is, on one line.
 */
const base = (p: string): string => {
  const clean = p.trim().replace(/^["']|["']$/g, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? clean
}
const firstArg = (rest: string): string => rest.trim().split(/\s+/)[0] ?? ''

const TOOLS: Record<string, (rest: string) => string> = {
  Bash: () => 'Running a command',
  BashOutput: () => 'Checking a command',
  KillShell: () => 'Stopping a command',
  Read: (r) => (r.trim() ? `Reading ${base(firstArg(r))}` : 'Reading a file'),
  NotebookRead: (r) => (r.trim() ? `Reading ${base(firstArg(r))}` : 'Reading a notebook'),
  Edit: (r) => (r.trim() ? `Editing ${base(firstArg(r))}` : 'Editing a file'),
  MultiEdit: (r) => (r.trim() ? `Editing ${base(firstArg(r))}` : 'Editing a file'),
  NotebookEdit: (r) => (r.trim() ? `Editing ${base(firstArg(r))}` : 'Editing a notebook'),
  Write: (r) => (r.trim() ? `Writing ${base(firstArg(r))}` : 'Writing a file'),
  Grep: () => 'Searching the files',
  Glob: () => 'Looking through the files',
  LS: () => 'Looking through the files',
  WebSearch: () => 'Searching the web',
  WebFetch: () => 'Reading a web page',
  Task: () => 'Working with a helper',
  Agent: () => 'Working with a helper',
  TodoWrite: () => 'Planning the next steps'
}

/** pm-review C7: a company with no code never reads "command" or "file" (Maya's agents are working, not running bash). */
const PLAIN: Record<string, string> = {
  Bash: 'Working on it',
  BashOutput: 'Working on it',
  KillShell: 'Working on it',
  Grep: 'Looking through its notes',
  Glob: 'Looking through its notes',
  LS: 'Looking through its notes'
}

export function plainActivity(line: string | null | undefined, opts: { code?: boolean } = {}): string | null {
  if (!line) return null
  const one = line.replace(/\s+/g, ' ').trim()
  if (!one) return null
  const m = /^([A-Z][A-Za-z]+)(?:\s+(.*))?$/.exec(one)
  if (m && opts.code === false && PLAIN[m[1]!]) return PLAIN[m[1]!]!
  const fn = m ? TOOLS[m[1]] : undefined
  if (fn) return fn(m![2] ?? '')
  // Principia's memory lines (`[memory] search "auth"`, `[memory] write Stripe (2 facts)`)
  const mem = /^\[memory\]\s+(\w+)/.exec(one)
  if (mem) return /^(?:write|link|invalidate|forget)$/.test(mem[1]!) ? 'Saving to memory' : 'Checking memory'
  const tool = connectorCall(one)
  if (tool) return connectorPhrase(tool.server, tool.tool, tool.rest, opts.code ?? true)
  return one
}

/**
 * A connector (MCP) call as the live tracker writes it: `mcp__posthog__exec …` (Claude's name), `mcp:posthog.exec …`
 * (Cursor), or `posthog.exec call execute-sql {"query": …}` (the tracker's display name plus its main argument).
 * A file name (`notes.md`) is not a call.
 */
const NOT_A_TOOL = /^(?:[jt]sx?|mjs|cjs|json|md|mdx|txt|py|rb|go|rs|css|scss|html?|ya?ml|toml|csv|tsv|sh|log|env|lock|png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|zip|sql)$/i
export function connectorCall(line: string): { server: string; tool: string; rest: string } | null {
  const mcp = /^mcp__([^_\s]+(?:_[^_\s]+)*)__(\S+)(?:\s+(.*))?$/.exec(line)
  if (mcp) return { server: mcp[1]!, tool: mcp[2]!, rest: mcp[3] ?? '' }
  const dotted = /^(?:mcp:)?([a-z][\w-]+)\.([A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(line)
  if (dotted && !NOT_A_TOOL.test(dotted[2]!)) return { server: dotted[1]!, tool: dotted[2]!, rest: dotted[3] ?? '' }
  return null
}

/** The connected tool by its own name ("PostHog", "Google Drive"); Principia's own servers by what they are. */
const SERVICE: Record<string, string> = {
  posthog: 'PostHog',
  github: 'GitHub',
  gitlab: 'GitLab',
  hubspot: 'HubSpot',
  google_drive: 'Google Drive',
  google_calendar: 'Google Calendar',
  gmail: 'Gmail',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  hive: 'Principia',
  principia: 'Principia'
}
export function serviceName(server: string): string {
  const k = server.toLowerCase().replace(/-/g, '_')
  return SERVICE[k] ?? k.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * What a connector call does, in words: `posthog.exec call execute-sql {…}` reads "Running a SQL query in PostHog",
 * `mcp__google_drive__search` "Searching Google Drive", a write "Updating Linear". The verb comes from the tool's
 * name and the words before its arguments (PostHog's one `exec` tool names the command it runs: `call execute-sql`).
 */
export function connectorPhrase(server: string, tool: string, rest = '', code = true): string {
  const s = server.toLowerCase()
  const head = rest.split(/[{["']/)[0] ?? ''
  const words = new Set(`${tool} ${head}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const has = (...w: string[]): boolean => w.some((x) => words.has(x))
  if (s === 'hivemem') return has('write', 'save', 'remember', 'add', 'update', 'forget', 'delete', 'invalidate') ? 'Saving to memory' : 'Checking memory'
  if (s === 'hive' || s === 'principia') {
    if (has('create', 'file') && has('task')) return 'Filing a task'
    if (has('comment')) return 'Commenting on a task'
    if (has('task')) return 'Updating a task'
  }
  const name = serviceName(server)
  if (has('sql', 'hogql') || (has('query') && /\bselect\b/i.test(rest))) return code ? `Running a SQL query in ${name}` : `Looking up data in ${name}`
  if (has('search', 'find', 'lookup')) return `Searching ${name}`
  if (has('query', 'insight', 'insights', 'trends', 'funnel', 'funnels', 'analytics', 'report')) return `Looking up data in ${name}`
  if (has('send', 'post', 'reply', 'publish', 'message', 'email')) return `Posting to ${name}`
  if (has('create', 'add', 'new', 'insert', 'upload')) return `Adding to ${name}`
  if (has('update', 'edit', 'set', 'patch', 'move', 'rename', 'merge')) return `Updating ${name}`
  if (has('delete', 'remove', 'archive', 'cancel')) return `Removing from ${name}`
  if (has('list', 'get', 'read', 'fetch', 'retrieve', 'view', 'show', 'describe', 'download')) return `Reading from ${name}`
  return `Using ${name}`
}
