import { describe, expect, it } from 'vitest'
import { groupSummary, partialField, toolLine } from '../../shared/toolVerbs'
import { ChatReducer, suggestionLabel } from '../../shared/chatReduce'
import { chatTitle, isDefaultTitle } from '../../shared/chatTitle'
import { withChoices, withConversation } from './chatArgs'
import { plainLabel } from './chatSession'
import type { ChatToolItem } from '../../shared/chat'

const tool = (name: string, input: Record<string, unknown>, status: ChatToolItem['status']) => ({ name, input, status, resultText: '' })

describe('chat words for non-technical users (CHAT-UI.md §4.3, QA round 1)', () => {
  it('a denied tool never reads like it happened', () => {
    const edit = toolLine(tool('Edit', { file_path: '/w/hello.txt', old_string: 'a', new_string: 'b' }, 'denied'))
    expect(edit).toMatchObject({ verb: "Didn't edit", target: 'hello.txt', meta: null })
    expect(toolLine(tool('Write', { file_path: '/w/notes.txt', content: 'x' }, 'denied')).verb).toBe("Didn't create")
    expect(toolLine(tool('Bash', { command: 'rm -rf x' }, 'denied')).verb).toBe("Didn't run")
    expect(toolLine(tool('Write', { file_path: '/w/notes.txt' }, 'interrupted')).verb).toBe('Stopped before creating')
    expect(toolLine(tool('Edit', { file_path: '/w/a', old_string: 'a', new_string: 'b' }, 'ok')).verb).toBe('Edited')
  })

  it('grouped look-ups name what they did, never "1 thing"', () => {
    expect(groupSummary([{ name: 'WebFetch', status: 'ok' }, { name: 'ToolSearch', status: 'ok' }])).toBe('Read 1 page, looked up tools')
    expect(groupSummary([{ name: 'mcp__hivemem__memory_search', status: 'ok' }, { name: 'SomethingNew', status: 'ok' }])).toBe('Checked memory, used 1 tool')
  })

  it('a streaming Write shows the file text so far, not JSON with \\n escapes', () => {
    expect(partialField('{"file_path": "/a/b.md", "content": "# Ethiopia\\n\\n1. Bright', 'content')).toBe('# Ethiopia\n\n1. Bright')
    expect(partialField('{"file_path": "/a/b.md", "content": "say \\"hi\\" \\u00e9', 'content')).toBe('say "hi" é')
    expect(partialField('{"file_path": "/a/b.m', 'content')).toBeNull()
    expect(partialField('{"content": "done", "x": 1}', 'content')).toBe('done')
  })

  it('"Always allow" labels never cut a command mid-quote; outcome lines drop the backticks', () => {
    const rule = (toolName: string, ruleContent: string) => ({ type: 'addRules', rules: [{ toolName, ruleContent }], destination: 'localSettings' })
    expect(suggestionLabel(rule('Bash', "printf 'hi there' > /tmp/some/really/long/path/file.txt:*"))).toBe('Always allow `printf` commands here')
    expect(suggestionLabel(rule('Bash', 'git push:*'))).toBe('Always allow `git push` here')
    expect(suggestionLabel(rule('WebFetch', 'domain:example.com'))).toBe('Always allow opening `example.com` here')
    expect(plainLabel('Always allow opening `example.com` here')).toBe('Always allow opening “example.com” here')
  })

  it('a chat is titled by its first message; only generated titles are replaced', () => {
    expect(chatTitle('  Write 10 Instagram captions\nabout our Ethiopia coffee  ')).toBe('Write 10 Instagram captions about our Ethiopia coffee')
    expect(chatTitle('x'.repeat(80)).length).toBeLessThanOrEqual(60)
    expect(isDefaultTitle('Chat · Claude', '/w/companies/northwind/workspace')).toBe(true)
    expect(isDefaultTitle('ledgerly-app · Claude', '/repos/ledgerly-app')).toBe(true)
    expect(isDefaultTitle('Pricing research', '/w')).toBe(false)
  })

  it('the picked model and mode replace the profile flags; bypass keeps its flag', () => {
    const base = ['--session-id', 'c1', '--model', 'opus', '--permission-mode', 'default', '--append-system-prompt', 'S']
    const out = withChoices(base, { model: 'haiku', permissionMode: 'acceptEdits' })
    expect(out[out.indexOf('--model') + 1]).toBe('haiku')
    expect(out[out.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    const added = withChoices(['--resume', 'c1', '--permission-mode', 'default'], { model: 'sonnet' })
    expect(added.slice(0, 4)).toEqual(['--resume', 'c1', '--model', 'sonnet'])
    expect(withChoices(['--dangerously-skip-permissions'], { permissionMode: 'plan' })).toEqual(['--dangerously-skip-permissions'])
    expect(withChoices(base, { model: 'default' })).toEqual(base)
    expect(withConversation(['--resume', 'c1'], false)).toEqual(['--session-id', 'c1'])
    expect(withConversation(['--session-id', 'c1'], true)).toEqual(['--resume', 'c1'])
  })

  it('a replayed tool that Stop denied reads as not done', () => {
    const r = new ChatReducer()
    r.line({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/notes.txt', content: 'x' } }] } })
    r.line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Interrupted by the user' }] } })
    expect(r.model.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'denied' })
  })

  it('the interrupt line sends its settle patches (the renderer never keeps a spinning card)', () => {
    const r = new ChatReducer()
    r.line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    r.line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tw', name: 'Write' } } })
    const ops = r.line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    expect(ops).toContainEqual({ op: 'patch', id: 'tool:tw', set: { status: 'interrupted' } })
  })
})
