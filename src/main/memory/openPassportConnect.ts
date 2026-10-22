/**
 * "Use this Passport in other apps" and "Import into Passport" (open-passport docs/connect.md; PASSPORT.md §12b).
 *
 * - Other apps (Claude Desktop, Cursor, VS Code, Codex, Claude Code, Windsurf, Gemini CLI) run the bundled
 *   `mcp-passport.js` on Principia's own runtime (ELECTRON_RUN_AS_NODE) against the company's live vault, with
 *   `--writes propose`: their `remember` / `taste` calls land as Open Passport proposal files under
 *   `<vault>/.open-passport/proposals/` (a dot folder the indexer ignores), which `ingestQueued` moves into the Inbox.
 *   Nothing here edits another app's config unless the user clicks the button for it (`installClaudeDesktop`).
 * - Importers (a ChatGPT or Claude export, a Notion / Obsidian folder, a website, pasted text) produce the same
 *   proposals; `fileProposals` turns them into Inbox items (facts: `harvest` with createNote/observe/relate ops; taste:
 *   `taste` through PassportRuntime.taste). Every item is fingerprinted, so importing the same export twice files nothing
 *   new and a rejected item never comes back.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { candidatesToProposals, importText, parseLine, parseLocalProposal, slugify, PROPOSALS_DIR, type ImportResult, type LocalProposal } from '../openPassport'
import { listProposals } from '../openPassport/mcp'
import { importSource } from '../openPassport/import'
import type { PassportConnectApp, PassportConnectSnippet, PassportDepartment, PassportImportKind, PassportImportResult, ProposalEvidence, VaultOp } from '../../shared/passport'
import { normName } from '../../shared/vault/resolve'
import { insertProposal, type IndexDB } from './vault/indexDb'
import { fingerprintOf } from './vault/suggest/queue'
import { sha1 } from './vault/fsutil'
import type { TasteInput } from './taste'

export const PASSPORT_MCP_SCRIPT = 'mcp-passport.js'

/** What the runtime gives this module. */
export interface ConnectHost {
  db: IndexDB
  /** the company's vault root */
  root(companyId: string): string
  departments(companyId: string): PassportDepartment[]
  /** files an inferred taste as a `taste` proposal (PassportRuntime.taste with stated: false) */
  taste(companyId: string, input: TasteInput, source: 'agent' | 'import'): Promise<{ status: string }>
  now(): Date
}

export interface FileCounts {
  filed: number
  /** already in the Inbox, already decided, or already true */
  known: number
  skipped: number
}

const noteRow = (db: IndexDB, companyId: string, title: string): { path: string; title: string } | null => {
  const want = normName(title)
  return (
    (db.prepare(`SELECT path, title FROM mem_note WHERE company_id = ? AND norm_title = ? AND removed_at IS NULL ORDER BY path LIMIT 1`).get(companyId, want) as { path: string; title: string } | undefined) ??
    (db
      .prepare(`SELECT n.path, n.title FROM mem_alias a JOIN mem_note n ON n.company_id = a.company_id AND n.id = a.note_id WHERE a.company_id = ? AND a.norm_alias = ? AND n.removed_at IS NULL LIMIT 1`)
      .get(companyId, want) as { path: string; title: string } | undefined) ??
    null
  )
}

/** The Inbox label of who asked: an importer or another app's MCP client. */
function originLabel(p: LocalProposal): string {
  if (p.source.startsWith('import:')) {
    const k = p.source.slice('import:'.length)
    return `Imported from ${({ chatgpt: 'a ChatGPT export', claude: 'a Claude export', folder: 'a folder', url: 'a website', text: 'pasted text' } as Record<string, string>)[k] ?? k}`
  }
  return `From ${p.app || 'another app'} (MCP)`
}

/**
 * Files Open Passport proposals into the Inbox. Facts become one `harvest` proposal per note (create the note when it
 * does not exist, then observe / relate); taste goes through the taste pipeline (reinforcement, fingerprints).
 */
export async function fileProposals(host: ConnectHost, companyId: string, proposals: LocalProposal[]): Promise<FileCounts> {
  const out: FileCounts = { filed: 0, known: 0, skipped: 0 }
  const at = host.now().toISOString()
  const deps = host.departments(companyId)
  const source = (p: LocalProposal) => (p.source.startsWith('import:') ? 'import' : 'agent')
  for (const p of proposals) {
    const label = originLabel(p)
    if (p.kind === 'taste' && p.taste) {
      let scope: TasteInput['scope'] = 'company'
      if (p.taste.scope !== 'company') {
        const slug = p.taste.scope.slice('department:'.length)
        const d = deps.find((x) => slugify(x.name) === slug || (x.passportNote && slugify(x.passportNote) === slug))
        if (!d) {
          out.skipped++
          continue
        }
        scope = { department: d }
      }
      try {
        const r = await host.taste(companyId, { scope, polarity: p.taste.polarity, text: p.taste.text, example: p.taste.example }, source(p))
        if (r.status === 'proposed') out.filed++
        else out.known++
      } catch {
        out.skipped++
      }
      continue
    }
    for (const n of p.notes ?? []) {
      const existing = noteRow(host.db, companyId, n.title)
      const name = existing ? existing.title : n.title
      const ops: VaultOp[] = []
      if (!existing) ops.push({ op: 'createNote', title: n.title, type: n.type ?? 'note' })
      const quotes: string[] = []
      for (const raw of n.lines) {
        const l = parseLine(raw)
        if (l?.kind === 'observation') ops.push({ op: 'observe', note: name, category: l.category, text: l.text })
        else if (l?.kind === 'relation') ops.push({ op: 'relate', from: name, rel: l.rel, to: l.target, ...(l.context ? { context: l.context } : {}) })
        else continue
        quotes.push(raw.replace(/^- /, ''))
      }
      if (!quotes.length) {
        out.skipped++
        continue
      }
      const evidence: ProposalEvidence[] = [
        ...quotes.slice(0, 5).map((q) => ({ path: existing?.path ?? null, line: null, quote: q.slice(0, 300), note: label })),
        ...(p.evidence ?? []).slice(0, 3).map((e) => ({ path: null, line: null, quote: e.slice(0, 300), note: `why: ${label}` }))
      ]
      const id = insertProposal(host.db, {
        companyId,
        kind: 'harvest',
        payload: ops,
        evidence,
        score: Math.max(0.3, Math.min(0.9, p.score ?? 0.5)),
        source: source(p),
        fingerprint: fingerprintOf(`open-passport:${normName(n.title)}:${sha1(quotes.map((q) => normName(q)).sort().join('\n'))}`),
        baseHashes: {},
        createdAt: at
      })
      if (id) out.filed++
      else out.known++
    }
  }
  return out
}

/** Moves the proposals other apps queued in the vault into the Inbox; each file goes to `inboxed/` once filed. */
export async function ingestQueued(host: ConnectHost, companyId: string): Promise<FileCounts> {
  const root = host.root(companyId)
  const total: FileCounts = { filed: 0, known: 0, skipped: 0 }
  for (const q of listProposals(root)) {
    const parsed = parseLocalProposal(q.raw)
    const r = parsed ? await fileProposals(host, companyId, [parsed.proposal]) : { filed: 0, known: 0, skipped: 1 }
    total.filed += r.filed
    total.known += r.known
    total.skipped += r.skipped
    const done = path.join(path.dirname(q.file), 'inboxed')
    fs.mkdirSync(done, { recursive: true })
    fs.renameSync(q.file, path.join(done, path.basename(q.file)))
  }
  return total
}

/** How many proposals other apps have queued in the vault. */
export function queuedCount(root: string): number {
  try {
    return fs.readdirSync(path.join(root, ...PROPOSALS_DIR.split('/'))).filter((f) => /^pp-[0-9a-f]+\.json$/.test(f)).length
  } catch {
    return 0
  }
}

/** Runs an importer and files what it found as Inbox proposals. */
export async function importIntoInbox(
  host: ConnectHost,
  companyId: string,
  req: { kind: PassportImportKind; source?: string; text?: string; max?: number; cardTitle: string },
  opts: { fetch?: typeof fetch } = {}
): Promise<PassportImportResult> {
  const budget = { maxCandidates: Math.min(200, Math.max(1, req.max ?? 40)) }
  let r: ImportResult
  if (req.kind === 'text') r = importText(req.text ?? '', { ...defaultBudget(), ...budget })
  else if (!req.source) throw new Error('Choose what to import')
  else r = await importSource(req.source, { kind: req.kind === 'url' ? 'url' : req.kind === 'folder' ? 'folder' : undefined, budget, fetch: opts.fetch })
  const proposals = candidatesToProposals(r.candidates, { source: `import:${r.kind}`, app: 'principia', now: host.now().toISOString(), cardTitle: req.cardTitle })
  const counts = await fileProposals(host, companyId, proposals)
  return {
    kind: r.kind,
    candidates: r.candidates.length,
    ...counts,
    documents: r.stats.documents,
    dropped: r.stats.dropped,
    preview: r.candidates.slice(0, 12).map((c) => ({ kind: c.kind, note: c.note ?? req.cardTitle, text: c.polarity ? `${c.polarity}: ${c.text}` : `${c.category}: ${c.text}`, from: c.from }))
  }
}
const defaultBudget = () => ({ maxCandidates: 40, maxMessages: 4000, maxCharsPerMessage: 4000, maxTotalChars: 3_000_000 })

// ---------- configs for other apps ----------

export interface StdioEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/** The stdio server entry for one app: Principia's runtime running the bundled server over the live vault. */
export function stdioEntry(execPath: string, script: string, vault: string, actor: string): StdioEntry {
  return { command: execPath, args: [script, '--dir', vault, '--writes', 'propose', '--actor', actor], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

const q = (s: string) => (/^[A-Za-z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const tomlStr = (s: string) => JSON.stringify(s)

export function cursorDeeplink(name: string, entry: object): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify(entry)).toString('base64'))}`
}
export function vscodeInstallLink(name: string, entry: object): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...entry }))}`
}

/** Copy-paste configs for the local (stdio) server, one per app. */
export function localSnippets(name: string, execPath: string, script: string, vault: string): PassportConnectSnippet[] {
  const e = (actor: string) => stdioEntry(execPath, script, vault, actor)
  const json = (o: unknown) => JSON.stringify(o, null, 2)
  const cc = e('claude-code')
  const codex = e('codex')
  return [
    { app: 'claude-desktop', label: 'Claude Desktop', where: claudeDesktopConfigPath().replace(os.homedir(), '~'), text: json({ mcpServers: { [name]: e('claude-desktop') } }), action: 'install' },
    { app: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json', text: json({ mcpServers: { [name]: e('cursor') } }), action: 'open' },
    { app: 'vscode', label: 'VS Code', where: 'mcp.json (MCP: Open User Configuration)', text: json({ servers: { [name]: { type: 'stdio', ...e('vscode') } } }), action: 'open' },
    {
      app: 'codex',
      label: 'Codex',
      where: '~/.codex/config.toml',
      text: [`[mcp_servers.${name}]`, `command = ${tomlStr(codex.command)}`, `args = [${codex.args.map(tomlStr).join(', ')}]`, `env = { ELECTRON_RUN_AS_NODE = "1" }`].join('\n'),
      action: null
    },
    { app: 'claude-code', label: 'Claude Code', where: 'terminal', text: `claude mcp add --transport stdio ${name} --env ELECTRON_RUN_AS_NODE=1 -- ${[cc.command, ...cc.args].map(q).join(' ')}`, action: null },
    { app: 'windsurf', label: 'Windsurf', where: '~/.codeium/windsurf/mcp_config.json', text: json({ mcpServers: { [name]: e('windsurf') } }), action: null },
    { app: 'gemini', label: 'Gemini CLI', where: '~/.gemini/settings.json', text: json({ mcpServers: { [name]: e('gemini') } }), action: null }
  ]
}

/** Configs for the hosted URL (ChatGPT and Claude.ai take only this; desktop apps may use it too, with OAuth). */
export function hostedSnippets(name: string, mcpUrl: string): PassportConnectSnippet[] {
  const json = (o: unknown) => JSON.stringify(o, null, 2)
  return [
    { app: 'chatgpt', label: 'ChatGPT', where: 'chatgpt.com/plugins → + → Add custom MCP server', text: `Name: ${name}\nServer URL: ${mcpUrl}\nAuthentication: OAuth (leave the client fields empty)`, action: null },
    { app: 'claude-ai', label: 'Claude.ai', where: 'Customize → Connectors → + → Add custom connector', text: `Name: ${name}\nURL: ${mcpUrl}`, action: null },
    { app: 'cursor', label: 'Cursor (hosted)', where: '~/.cursor/mcp.json', text: json({ mcpServers: { [name]: { url: mcpUrl } } }), action: 'open' },
    { app: 'vscode', label: 'VS Code (hosted)', where: 'mcp.json', text: json({ servers: { [name]: { type: 'http', url: mcpUrl } } }), action: 'open' },
    { app: 'codex', label: 'Codex (hosted)', where: 'terminal', text: `codex mcp add ${name} --url ${mcpUrl}\ncodex mcp login ${name}`, action: null },
    { app: 'claude-code', label: 'Claude Code (hosted)', where: 'terminal', text: `claude mcp add --transport http ${name} ${mcpUrl}`, action: null }
  ]
}

export function claudeDesktopConfigPath(home = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
}

/** Whether Claude Desktop's config already names this server. */
export function claudeDesktopHas(configPath: string, name: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, unknown> }
    return !!j.mcpServers?.[name]
  } catch {
    return false
  }
}

/**
 * Adds (or replaces) one server in Claude Desktop's config, only when the user clicks for it. The file keeps every
 * other key; the previous file is kept next to it as `.bak`. A file that is not JSON is never overwritten.
 */
export function installClaudeDesktop(configPath: string, name: string, entry: StdioEntry): { path: string; replaced: boolean; backup: string | null } {
  let cfg: Record<string, unknown> = {}
  let backup: string | null = null
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8')
    try {
      cfg = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      throw new Error(`${configPath} is not valid JSON; fix it in Claude Desktop (Settings → Developer → Edit Config) and try again`)
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${configPath} is not a JSON object`)
    backup = `${configPath}.bak`
    fs.writeFileSync(backup, text)
  } else fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {}) as Record<string, unknown>
  const replaced = name in servers
  cfg.mcpServers = { ...servers, [name]: entry }
  const tmp = `${configPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
  fs.renameSync(tmp, configPath)
  return { path: configPath, replaced, backup }
}

/** A stable server name for other apps: `<company slug>-passport`. */
export function serverNameFor(slug: string, name: string): string {
  return `${slugify(slug || name) || 'company'}-passport`.slice(0, 60)
}

export type { PassportConnectApp }
