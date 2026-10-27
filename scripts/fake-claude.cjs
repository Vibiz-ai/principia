#!/usr/bin/env node
/**
 * A stand-in `claude` for dev and test instances (never shipped): answers agent turns without a model, so chat and
 * routing flows can be clicked through on seeded data (docs/CHAT-UI.md §7). Point a dev instance at it with
 * HIVE_CLAUDE_BIN=<repo>/scripts/fake-claude.cjs (main/engine/providers.ts honours it only under electron-vite dev).
 *
 * - `--version`, `auth status --json`: what Principia's provider checks expect.
 * - `-p --input-format stream-json …`: answers the initialize handshake, then each user message with a short reply in
 *   the agent's role after FAKE_CLAUDE_DELAY_MS (default 2500, so "working" shows). A one-shot run (no
 *   --replay-user-messages) exits after its result; a chat keeps reading stdin.
 * - interactive (a terminal session): prints one line and waits.
 */
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const DELAY = Number(process.env.FAKE_CLAUDE_DELAY_MS || 2500)

if (args.includes('--version')) {
  console.log('2.1.310 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }))
  process.exit(0)
}

const at = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'))
const sessionId = at >= 0 ? args[at + 1] : '00000000-0000-4000-8000-000000000000'
const chat = args.includes('--replay-user-messages')

if (!args.includes('-p')) {
  process.stdout.write('Demo claude (scripts/fake-claude.cjs): terminal sessions are not simulated.\r\n')
  setInterval(() => {}, 1 << 30)
} else {
  let buf = ''
  let queue = Promise.resolve()
  let inited = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) queue = queue.then(() => handle(line))
    }
  })
  process.stdin.on('end', () => void queue.then(() => process.exit(0)))

  async function handle(line) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
      return
    }
    if (m.type !== 'user') return
    const text = typeof m.message?.content === 'string' ? m.message.content : (m.message?.content ?? []).map((c) => c.text ?? '').join('\n')
    if (!inited) {
      inited = true
      out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-demo', tools: [], cwd: process.cwd() })
    }
    if (chat) out({ type: 'user', message: { role: 'user', content: text }, session_id: sessionId, parent_tool_use_id: null })
    await new Promise((r) => setTimeout(r, DELAY))
    const reply = answer(text)
    out({ type: 'assistant', message: { id: 'msg_demo_' + Date.now(), role: 'assistant', model: 'claude-demo', content: [{ type: 'text', text: reply }], usage: { input_tokens: 900, output_tokens: 60 } }, session_id: sessionId, parent_tool_use_id: null })
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sessionId, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 900, output_tokens: 60 } })
    if (!chat) setTimeout(() => process.exit(0), 50)
  }
}

/** A short reply in the agent's role, about the person's words. */
function answer(prompt) {
  const role = /agent="([^"]+)"/.exec(prompt)?.[1] ?? null
  const asked = [...prompt.matchAll(/^- m[0-9a-z]+ @[^:]+: (.*)$/gm)].map((x) => x[1]).pop() ?? lastPlainLine(prompt)
  const about = clip(asked.replace(/@[\p{L}\p{N}_-]+/gu, '').replace(/\s+/g, ' ').trim(), 90)
  const who = role ? `${role} here. ` : ''
  if (/^(hi|hey|hello|yo)\b/i.test(about)) return `${who}Hi! Tell me what you need and I will take it from here. (Demo reply: no model ran.)`
  if (/\?$/.test(about)) return `${who}Good question. My short answer on “${about}”: let me check our notes and come back in this conversation within the hour. (Demo reply: no model ran.)`
  return `${who}On it: “${about}”. I will post a first draft right here. (Demo reply: no model ran.)`
}
function lastPlainLine(s) {
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('<'))
  return lines[lines.length - 1] ?? s
}
function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
