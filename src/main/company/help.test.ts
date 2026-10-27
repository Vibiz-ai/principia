import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { buildAuthorHandlers, listedHiveTools } from '../author/server/tools'
import { buildHandlers } from '../memory/server/build'
import { callHelpTool, CONNECTIONS_TOOL, HELP_TOOL } from './taskToolDefs'

const CO = 'co_aaaaaaaaaaaaaaaaaaaa'
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('')

describe('principia_help: how Principia itself works, listed where connections_list is', () => {
  it('is listed beside connections_list on company sessions (hive) and task runs (hivemem)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-help-'))
    try {
      const company = listedHiveTools({ HIVE_TOOLSETS: 'author', HIVE_COMPANY_ID: CO })
      expect(company).toContain(CONNECTIONS_TOOL)
      expect(company).toContain(HELP_TOOL)
      // every interactive session gets it, company or not; a bare Slack step does not
      expect(listedHiveTools({ HIVE_TOOLSETS: 'author' })).toContain(HELP_TOOL)
      expect(listedHiveTools({ HIVE_TOOLSETS: 'slack' })).not.toContain(HELP_TOOL)
      const hive = buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'author', HIVE_COMPANY_ID: CO })
      const names = hive.listTools().map((t) => t.name)
      expect(names).toContain(CONNECTIONS_TOOL)
      expect(names).toContain(HELP_TOOL)
      expect(hive.listTools().find((t) => t.name === HELP_TOOL)?.annotations).toEqual({ readOnlyHint: true })
      const instr = typeof hive.instructions === 'function' ? hive.instructions() : hive.instructions
      expect(instr).toContain('principia_help')
      const mem = buildHandlers({ HIVE_TASK_ID: 'task_x', HIVE_LIVE_DIR: dir }).handlers
      expect(mem.listTools().map((t) => t.name)).toEqual(expect.arrayContaining([CONNECTIONS_TOOL, HELP_TOOL]))
      expect(typeof mem.instructions === 'function' ? mem.instructions() : mem.instructions).toContain('call principia_help')
      expect(buildHandlers({}).handlers.listTools().map((t) => t.name)).not.toContain(HELP_TOOL)
      // answered in the server process: no mailbox line is written
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '')
      for (const h of [hive, mem]) {
        const res = await h.callTool(HELP_TOOL, { question: 'how can I use principia from my phone?' }, { requestId: 1, meta: null, signal: new AbortController().signal })
        expect(res.isError).toBeFalsy()
        expect(text(res)).toContain('principia://settings/phone')
      }
      expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toBe('')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the best entries, or every topic title when nothing matches; refuses an empty question', () => {
    const hit = callHelpTool({ question: 'start a new chat' })
    expect(JSON.parse(text(hit)).entries[0].title).toBe('Start a new conversation')
    const miss = JSON.parse(text(callHelpTool({ question: 'zxqv blorp' })))
    expect(miss.entries).toEqual([])
    expect(miss.topics).toContain('Use Principia from your phone')
    expect(callHelpTool({}).isError).toBe(true)
  })

  it('the broker answers a stray line with the same data, for any owner', async () => {
    const b = new AuthorBroker({} as BrokerDeps)
    const ask = (args: unknown) => new Promise<{ ok: boolean; result?: { entries: { title: string }[] }; error?: string }>((resolve) => b.handleCall({ runId: 'r_1', stepId: 'st_1' }, { hive: 'author_call', call_id: 'hac_0000000003', tool: HELP_TOOL, args }, (_id, p) => resolve(p as never)))
    const ok = await ask({ question: 'use principia on my iPhone' })
    expect(ok.ok).toBe(true)
    expect(ok.result?.entries[0]?.title).toBe('Use Principia from your phone')
    expect((await ask({})).ok).toBe(false)
  })
})
