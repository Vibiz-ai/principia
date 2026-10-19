import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowDraft } from '../../shared/types'
import { workflowFile } from '../ipcSchemas'
import { Marketplace, type MarketplaceDeps } from '../marketplace'
import { validateWorkflow } from '../engine/validate'
import { profile } from '../engine/__tests__/fakes'

const BUILTIN = path.join(__dirname, '../../../resources/marketplace')

describe('built-in catalog', () => {
  const index = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'index.json'), 'utf8')) as { items: { kind: string; path: string; id: string }[] }
  const deps = {
    getProfile: (id: string) => (id === 'prof_claude' ? profile('prof_claude', 'claude') : id === 'prof_codex' ? profile('prof_codex', 'codex') : null),
    getRepo: () => null
  }
  for (const item of index.items.filter((i) => i.kind === 'workflow' || i.kind === 'script')) {
    it(`${item.id} is a valid workflow`, () => {
      const parsed = workflowFile.safeParse(JSON.parse(fs.readFileSync(path.join(BUILTIN, item.path), 'utf8')))
      expect(parsed.success && parsed.data.hive).toBe('workflow')
      if (parsed.success) expect(validateWorkflow(parsed.data.workflow as WorkflowDraft, deps)).toEqual([])
    })
  }
  it('lists every item with a readable file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mkt-'))
    const m = new Marketplace({ ...baseDeps(home), builtinDir: BUILTIN, workflowNodes: () => [] })
    const { items } = await m.list()
    expect(items).toHaveLength(index.items.length)
    for (const i of items.filter((x) => x.kind !== 'workflow')) await expect(m.preview(i)).resolves.toMatchObject({ overwrites: false })
  })
})

function baseDeps(home: string): MarketplaceDeps {
  return {
    builtinDir: '',
    homeDir: home,
    remoteUrl: () => null,
    fetchText: async () => {
      throw new Error('offline')
    },
    workflowNames: () => [],
    importWorkflow: () => ({ id: 'wf_1' }),
    workflowNodes: () => []
  }
}

describe('Marketplace', () => {
  let home: string
  let cat: string
  const agent = '---\nname: rev\ndescription: reviews\n---\n\nbody\n'
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mkt-home-'))
    cat = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mkt-cat-'))
    fs.writeFileSync(path.join(cat, 'rev.md'), agent)
    fs.writeFileSync(
      path.join(cat, 'index.json'),
      JSON.stringify({
        hive: 'marketplace',
        version: 1,
        items: [
          { id: 'rev', kind: 'agent', name: 'Rev', description: 'd', path: 'rev.md' },
          { id: 'esc', kind: 'skill', name: 'Esc', description: 'd', path: '../outside.md' }
        ]
      })
    )
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cat, { recursive: true, force: true })
  })

  it('installs an agent to ~/.claude/agents and refuses to overwrite without consent', async () => {
    const m = new Marketplace({ ...baseDeps(home), builtinDir: cat })
    const r = await m.install({ source: 'builtin', id: 'rev' })
    expect(r).toEqual({ kind: 'agent', path: path.join(home, '.claude/agents/rev.md') })
    expect(fs.readFileSync(path.join(home, '.claude/agents/rev.md'), 'utf8')).toBe(agent)
    expect((await m.list()).items.find((i) => i.id === 'rev')?.installed).toBe(true)
    await expect(m.install({ source: 'builtin', id: 'rev' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(m.install({ source: 'builtin', id: 'rev' }, { overwrite: true })).resolves.toMatchObject({ kind: 'agent' })
  })

  it('never reads outside the catalog', async () => {
    const m = new Marketplace({ ...baseDeps(home), builtinDir: cat })
    await expect(m.preview({ source: 'builtin', id: 'esc' })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('lists a remote index next to the built-in one and resolves its files against the index URL', async () => {
    const fetched: string[] = []
    const m = new Marketplace({
      ...baseDeps(home),
      builtinDir: cat,
      remoteUrl: () => 'https://raw.example.com/org/repo/main/index.json',
      fetchText: async (url) => {
        fetched.push(url)
        if (url.endsWith('index.json'))
          return JSON.stringify({ hive: 'marketplace', version: 1, items: [{ id: 'flow', kind: 'workflow', name: 'Flow', description: 'd', path: 'w/flow.hive.json' }] })
        return JSON.stringify({ hive: 'workflow', version: 1, workflow: { name: 'Flow', nodes: [] } })
      }
    })
    const l = await m.list()
    expect(l.remoteError).toBeNull()
    expect(l.items.map((i) => `${i.source}/${i.id}`)).toEqual(['remote/flow', 'builtin/rev', 'builtin/esc'])
    expect(await m.install({ source: 'remote', id: 'flow' })).toEqual({ kind: 'workflow', workflowId: 'wf_1' })
    expect(fetched).toContain('https://raw.example.com/org/repo/main/w/flow.hive.json')
  })

  it('keeps the built-in catalog when the remote index fails', async () => {
    const m = new Marketplace({ ...baseDeps(home), builtinDir: cat, remoteUrl: () => 'https://x.example/index.json' })
    const l = await m.list()
    expect(l.remoteError).toBe('offline')
    expect(l.items).toHaveLength(2)
  })

  it('rejects agent files without front matter', async () => {
    fs.writeFileSync(path.join(cat, 'rev.md'), 'just text')
    const m = new Marketplace({ ...baseDeps(home), builtinDir: cat })
    await expect(m.install({ source: 'builtin', id: 'rev' })).rejects.toMatchObject({ code: 'bad_request' })
  })
})
