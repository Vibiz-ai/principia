// Vendored from open-passport 0.1.0 (packages/js/src/node/mcp.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// The stdio MCP server for a passport folder (SPEC.md §9.4): newline-delimited JSON-RPC 2.0, dual-era (modern
// per-request `_meta` and legacy `initialize`). Reads come from the folder on every call, so a live vault (Principia,
// Obsidian) is always current. Writes are `direct` (applied to the folder), `propose` (queued under
// `.open-passport/proposals/` for a person to review) or `off`.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { textFiles, MANIFEST } from './manifest'
import { handleMcpMessage, type JsonRpcMessage, type McpServerSpec } from './mcpProtocol'
import { applyNotesBlock, applyTaste } from './notes'
import { loadPassport } from './passport'
import { proposalFromWrite, PROPOSALS_DIR, type LocalProposal } from './proposals'
import { FULL_ACCESS, READ_ONLY_ACCESS, runTool, serverInstructions, toolAllowed, toolsFor, type ToolResult } from './tools'
import { newLineId } from './grammar'
import { buildFolder, readFolder, writeFiles } from './fs'

export type WriteMode = 'direct' | 'propose' | 'off'

export interface McpOptions {
  /** provenance actor for direct writes and the `app` of proposals */
  actor: string
  /** same as writes: 'off' */
  readOnly?: boolean
  writes?: WriteMode
  /** server name in serverInfo (default open-passport) */
  name?: string
  now?: () => Date
}

const modeOf = (o: McpOptions): WriteMode => (o.readOnly ? 'off' : (o.writes ?? 'direct'))

/** Writes a proposal file into `<dir>/.open-passport/proposals/` (atomic). Returns its path. */
export function writeProposal(dir: string, p: LocalProposal): string {
  const d = path.join(dir, ...PROPOSALS_DIR.split('/'))
  fs.mkdirSync(d, { recursive: true })
  const file = path.join(d, `${p.id}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

/** Pending proposal files of a folder (sorted by name). */
export function listProposals(dir: string): { file: string; raw: unknown }[] {
  const d = path.join(dir, ...PROPOSALS_DIR.split('/'))
  let names: string[] = []
  try {
    names = fs.readdirSync(d).filter((f) => /^pp-[0-9a-f]+\.json$/.test(f)).sort()
  } catch {
    return []
  }
  const out: { file: string; raw: unknown }[] = []
  for (const f of names) {
    try {
      out.push({ file: path.join(d, f), raw: JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) })
    } catch {
      // a half-written or foreign file: skipped
    }
  }
  return out
}

/** One tool call against the folder. Exported for tests and for hosts that embed the stdio behavior. */
export function passportToolCall(dir: string, opts: McpOptions, name: string, args: Record<string, unknown>): ToolResult {
  const mode = modeOf(opts)
  const now = (opts.now ?? (() => new Date()))()
  const all = readFolder(dir)
  const files = textFiles(all)
  const model = loadPassport(files)
  const access = mode === 'off' ? READ_ONLY_ACCESS : FULL_ACCESS
  if (!toolAllowed(access, name)) return { text: mode === 'off' ? 'this passport is read-only here' : `unknown tool ${name}`, isError: true }
  const out = runTool({ model, access, urlFor: (p) => `passport://${encodeURIComponent(model.name)}/${p.split('/').map(encodeURIComponent).join('/')}` }, name, args)
  if (out.kind === 'result') return out
  const w = out.write
  if (mode === 'propose') {
    const p = proposalFromWrite(w, { app: opts.actor, source: 'mcp', now: now.toISOString() })
    writeProposal(dir, p)
    return { text: JSON.stringify({ status: 'proposed', proposal: p.id, note: 'saved for the owner to review' }) }
  }
  const prov = { actor: opts.actor, via: null, run: null, session: null, date: now.toISOString().slice(0, 10) }
  // a plain vault (no passport.json) stays a plain vault: no manifest or renders are written into it
  const rebuild = () => all.has(MANIFEST) && buildFolder(dir, { now: now.toISOString() })
  if (w.tool === 'taste') {
    const r = applyTaste(files, model, w.feedback, { ...prov, actor: w.stated ? 'user' : opts.actor }, () => newLineId('f'))
    writeFiles(dir, new Map([[r.path, files.get(r.path)!]]))
    rebuild()
    return { text: JSON.stringify({ status: 'applied', path: r.path, reinforced: r.reinforced }) }
  }
  const before = new Map(files)
  const r = applyNotesBlock(files, model, [{ title: w.note, type: w.type, lines: w.lines }], prov, (k) => newLineId(k))
  writeFiles(dir, new Map([...files].filter(([p, v]) => before.get(p) !== v)))
  rebuild()
  return { text: JSON.stringify({ status: r.written ? 'applied' : 'unchanged', written: r.written, created: r.created }) }
}

export function stdioSpec(dir: string, opts: McpOptions): McpServerSpec {
  const mode = modeOf(opts)
  let name = 'this company'
  try {
    name = loadPassport(textFiles(readFolder(dir))).name
  } catch {
    // an unreadable folder still serves (each call reports its own error)
  }
  return {
    name: opts.name ?? 'open-passport',
    version: '0.2.0',
    instructions: serverInstructions(name),
    tools: () => toolsFor(mode === 'off' ? READ_ONLY_ACCESS : FULL_ACCESS),
    call: (n, args) => passportToolCall(dir, opts, n, args)
  }
}

export async function serveMcp(dir: string, opts: McpOptions): Promise<void> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`)
  const spec = stdioSpec(dir, opts)
  const rl = readline.createInterface({ input: process.stdin })
  const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`)
  for await (const line of rl) {
    if (!line.trim()) continue
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    const r = await handleMcpMessage(spec, msg)
    if (r.body) send(r.body)
  }
}
