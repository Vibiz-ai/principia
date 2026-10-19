import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ADAPTER_IDS, type Id } from '../shared/types'
import { HiveError } from '../shared/errors'
import {
  MARKET_KINDS,
  type MarketIndex,
  type MarketIndexItem,
  type MarketInstallResult,
  type MarketItem,
  type MarketList,
  type MarketPreview,
  type MarketRef
} from '../shared/marketplace'

const MAX_INDEX = 2 * 1024 * 1024
const MAX_FILE = 5 * 1024 * 1024
const MAX_MARKDOWN = 256 * 1024
const REMOTE_TTL_MS = 10 * 60_000

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'id must be a lowercase slug')
const indexSchema = z.object({
  hive: z.literal('marketplace'),
  version: z.literal(1),
  name: z.string().max(200).optional(),
  items: z
    .array(
      z.object({
        id: slug,
        kind: z.enum(MARKET_KINDS),
        name: z.string().min(1).max(120),
        description: z.string().max(2000),
        tags: z.array(z.string().max(40)).max(20).optional(),
        author: z.string().max(120).optional(),
        keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128)).max(20).optional(),
        adapters: z.array(z.enum(ADAPTER_IDS)).max(5).optional(),
        path: z.string().min(1).max(2048)
      })
    )
    .max(2000)
})

export interface MarketplaceDeps {
  /** resources/marketplace: index.json + the files it names. */
  builtinDir: string
  /** ~ : agents and skills go to ~/.claude/{agents,skills}. */
  homeDir: string
  remoteUrl: () => string | null
  /** https GET as text; rejects on non-2xx or a body over maxBytes. */
  fetchText: (url: string, maxBytes: number) => Promise<string>
  workflowNames: () => string[]
  /** Parses + validates a .hive.json object and saves it (same path as Workflows › Import). */
  importWorkflow: (raw: unknown) => { id: Id }
  /** Draft nodes of a parsed .hive.json (for the preview); throws when it is not one. */
  workflowNodes: (raw: unknown) => { id: string; type: string; label: string; command: string | null }[]
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function parseIndex(text: string, where: string): MarketIndex {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new HiveError('bad_request', `${where} is not JSON: ${errText(e)}`)
  }
  const r = indexSchema.safeParse(raw)
  if (!r.success) throw new HiveError('bad_request', `${where} is not a Hive marketplace index: ${r.error.issues[0]?.message ?? 'invalid'}`)
  const seen = new Set<string>()
  return { ...r.data, items: r.data.items.filter((i) => !seen.has(i.id) && !!seen.add(i.id)) }
}

export class Marketplace {
  private builtin: MarketIndex | null = null
  private remote: { url: string; at: number; index: MarketIndex | null; error: string | null } | null = null

  constructor(private d: MarketplaceDeps) {}

  private loadBuiltin(): MarketIndex {
    this.builtin ??= parseIndex(fs.readFileSync(path.join(this.d.builtinDir, 'index.json'), 'utf8'), 'The built-in catalog')
    return this.builtin
  }

  private async loadRemote(fresh: boolean): Promise<{ url: string | null; index: MarketIndex | null; error: string | null }> {
    const url = this.d.remoteUrl()
    if (!url) return { url: null, index: null, error: null }
    const c = this.remote
    if (!fresh && c && c.url === url && Date.now() - c.at < REMOTE_TTL_MS) return c
    let index: MarketIndex | null = null
    let error: string | null = null
    try {
      index = parseIndex(await this.d.fetchText(url, MAX_INDEX), 'The marketplace URL')
    } catch (e) {
      error = errText(e)
    }
    this.remote = { url, at: Date.now(), index, error }
    return this.remote
  }

  agentPath(id: string): string {
    return path.join(this.d.homeDir, '.claude', 'agents', `${id}.md`)
  }
  skillPath(id: string): string {
    return path.join(this.d.homeDir, '.claude', 'skills', id, 'SKILL.md')
  }

  private toItem(i: MarketIndexItem, source: MarketItem['source'], names: Set<string>): MarketItem {
    const { path: _p, ...rest } = i
    const installed =
      i.kind === 'workflow' || i.kind === 'script' ? names.has(i.name.trim().toLowerCase()) : fs.existsSync(i.kind === 'agent' ? this.agentPath(i.id) : this.skillPath(i.id))
    return { ...rest, source, installed }
  }

  async list(opts: { refresh?: boolean } = {}): Promise<MarketList> {
    const names = new Set(this.d.workflowNames().map((n) => n.trim().toLowerCase()))
    const remote = await this.loadRemote(!!opts.refresh)
    return {
      items: [
        ...(remote.index?.items.map((i) => this.toItem(i, 'remote', names)) ?? []),
        ...this.loadBuiltin().items.map((i) => this.toItem(i, 'builtin', names))
      ],
      remoteUrl: remote.url,
      remoteError: remote.error
    }
  }

  private async find(ref: MarketRef): Promise<{ entry: MarketIndexItem; item: MarketItem; text: string }> {
    const index = ref.source === 'builtin' ? this.loadBuiltin() : (await this.loadRemote(false)).index
    const entry = index?.items.find((i) => i.id === ref.id)
    if (!entry) throw new HiveError('not_found', 'That item is no longer in the marketplace. Refresh the list.')
    const names = new Set(this.d.workflowNames().map((n) => n.trim().toLowerCase()))
    return { entry, item: this.toItem(entry, ref.source, names), text: await this.readFile(ref.source, entry.path) }
  }

  private async readFile(source: MarketRef['source'], rel: string): Promise<string> {
    if (source === 'builtin') {
      const root = path.resolve(this.d.builtinDir)
      const file = path.resolve(root, rel)
      if (!file.startsWith(root + path.sep)) throw new HiveError('bad_request', 'Item path leaves the catalog')
      if (fs.statSync(file).size > MAX_FILE) throw new HiveError('bad_request', 'Item file is larger than 5 MB')
      return fs.readFileSync(file, 'utf8')
    }
    const base = this.d.remoteUrl()
    if (!base) throw new HiveError('not_found', 'No marketplace URL is set')
    let url: URL
    try {
      url = new URL(rel, base)
    } catch {
      throw new HiveError('bad_request', `Bad item path: ${rel}`)
    }
    if (url.protocol !== 'https:') throw new HiveError('bad_request', 'Marketplace files must be https')
    try {
      return await this.d.fetchText(url.toString(), MAX_FILE)
    } catch (e) {
      throw new HiveError('bad_request', `Couldn’t download ${url.toString()}: ${errText(e)}`)
    }
  }

  private parseWorkflow(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new HiveError('bad_request', `Not a Hive workflow file: ${errText(e)}`)
    }
  }

  private checkMarkdown(kind: 'agent' | 'skill', text: string): string {
    if (text.length > MAX_MARKDOWN) throw new HiveError('bad_request', `This ${kind} file is larger than 256 KB`)
    // Claude Code reads name/description from YAML front matter; without it the file is ignored.
    if (!/^---\r?\n[\s\S]*?\bname:[\s\S]*?\bdescription:[\s\S]*?\r?\n---/.test(text)) {
      throw new HiveError('bad_request', `This ${kind} file has no front matter with name and description`)
    }
    return text
  }

  async preview(ref: MarketRef): Promise<MarketPreview> {
    const { entry, item, text } = await this.find(ref)
    if (entry.kind === 'workflow' || entry.kind === 'script') {
      return { item, target: null, text: null, nodes: this.d.workflowNodes(this.parseWorkflow(text)), overwrites: false }
    }
    const target = entry.kind === 'agent' ? this.agentPath(entry.id) : this.skillPath(entry.id)
    return { item, target, text: this.checkMarkdown(entry.kind, text), nodes: [], overwrites: fs.existsSync(target) }
  }

  async install(ref: MarketRef, opts: { overwrite?: boolean } = {}): Promise<MarketInstallResult> {
    const { entry, text } = await this.find(ref)
    if (entry.kind === 'workflow' || entry.kind === 'script') return { kind: entry.kind, workflowId: this.d.importWorkflow(this.parseWorkflow(text)).id }
    const body = this.checkMarkdown(entry.kind, text)
    const target = entry.kind === 'agent' ? this.agentPath(entry.id) : this.skillPath(entry.id)
    if (fs.existsSync(target) && !opts.overwrite) throw new HiveError('conflict', `${target} already exists`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
    return { kind: entry.kind, path: target }
  }
}
