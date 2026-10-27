/**
 * The `hive` server <-> main mailbox through real files (AUTHORING.md §1.2): the server's callHive appends an
 * author_call line to the owner's events.jsonl, LiveBridge intercepts it (never delivered to channel callbacks) and
 * the answer file comes back. Also the MCP surface (initialize, tools/list) of buildAuthorHandlers.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LiveOwner } from '../../../shared/engine'
import { AUTHOR_TOOLS } from '../../../shared/authoring'
import { createLiveBridge } from '../../live/bridge'
import { dispatch } from '../../memory/server/jsonrpc'
import { buildAuthorHandlers, callHive, callTimeoutMs } from '../server/tools'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('hive server mailbox', () => {
  it('round-trips a call through events.jsonl and answers/<call_id>.json; channel callbacks never see it', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-author-'))
    tmp.push(userData)
    const seen: { owner: LiveOwner; tool: unknown }[] = []
    const bridge = createLiveBridge({
      userData,
      execPath: process.execPath,
      hookScript: '/nonexistent/hive-hook.js',
      pollMs: 20,
      onAuthor: (owner, line, writeAnswer) => {
        seen.push({ owner, tool: line.tool })
        if (line.hive === 'author_call') writeAnswer(String(line.call_id), { ok: true, result: { echo: line.args } })
      }
    })
    const ch = bridge.open({ sessionId: 's_0000000001' })
    const delivered: unknown[] = []
    ch.onLine((l) => delivered.push(l))
    const res = await callHive(ch.dir, 'hive_workflow_validate', { workflow: { name: 'x' } })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ echo: { workflow: { name: 'x' } } })
    expect(seen).toEqual([{ owner: { sessionId: 's_0000000001' }, tool: 'hive_workflow_validate' }])
    // a normal hook line still reaches the channel
    fs.appendFileSync(path.join(ch.dir, 'events.jsonl'), `${JSON.stringify({ v: 1, provider: 'claude', payload: {} })}\n`)
    await new Promise((r) => setTimeout(r, 120))
    expect(delivered).toHaveLength(1)
    expect(JSON.stringify(delivered)).not.toMatch(/author_call/)
    ch.close()
  })

  it('a cancel appends author_cancelled and rejects the call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-author-'))
    tmp.push(dir)
    fs.mkdirSync(path.join(dir, 'answers'))
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '')
    const ac = new AbortController()
    const p = callHive(dir, 'hive_workflow_create', { workflow: {}, summary: 'x' }, { signal: ac.signal }, () => new Promise(() => undefined))
    ac.abort()
    await expect(p).rejects.toThrow('canceled')
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.hive)).toEqual(['author_call', 'author_cancelled'])
    expect(lines[1].call_id).toBe(lines[0].call_id)
  })

  it('oversized arguments never leave the server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-author-'))
    tmp.push(dir)
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '')
    const r = await callHive(dir, 'hive_workflow_create', { workflow: { name: 'x'.repeat(300 * 1024) } })
    expect(r.isError).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toBe('')
  })

  it('timeouts follow wait_s for writes and waiting reads', () => {
    expect(callTimeoutMs('hive_workflow_create', {})).toBe(630_000)
    expect(callTimeoutMs('hive_workflow_create', { wait_s: 0 })).toBe(30_000)
    expect(callTimeoutMs('hive_run_get', { wait_s: 100 })).toBe(130_000)
    expect(callTimeoutMs('hive_repos_list', {})).toBe(30_000)
  })

  it('MCP surface: tools/list lists exactly the authoring tools, none without a live dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-author-'))
    tmp.push(dir)
    const h = buildAuthorHandlers({ HIVE_LIVE_DIR: dir })
    const init = (await dispatch(h, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { instructions: string; serverInfo: { name: string } } }
    expect(init.result.serverInfo.name).toBe('hive')
    expect(init.result.instructions).toMatch(/hive_workflow_schema/)
    const list = (await dispatch(h, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    // plus principia_help (read-only, answered locally from shared/help.ts) on every interactive session
    expect(list.result.tools.map((t) => t.name)).toEqual([...AUTHOR_TOOLS, 'principia_help'])
    expect(buildAuthorHandlers({}).listTools()).toEqual([])
    const unknown = (await dispatch(h, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hive_settings_update', arguments: {} } })) as { result: { isError: boolean } }
    expect(unknown.result.isError).toBe(true)
  })
})
