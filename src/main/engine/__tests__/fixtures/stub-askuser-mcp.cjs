#!/usr/bin/env node
/**
 * Test-only stand-in for hivemem's ask_user (LIVE.md §4.2; the real one is src/main/memory/server, backend-owned).
 * Newline-delimited JSON-RPC 2.0 over stdio. tools/call ask_user appends
 * {"hive":"ask_user","gate_id","question","options","agent_hint"} to $HIVE_LIVE_DIR/events.jsonl and waits for
 * $HIVE_LIVE_DIR/answers/<gate_id>.json. Answers ping while waiting; server/discover -> {}.
 */
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const LIVE = process.env.HIVE_LIVE_DIR
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const TOOLS = LIVE
  ? [
      {
        name: 'ask_user',
        description:
          'Ask the human user a question and wait for the answer. Use when you need a decision or information only the user has. The step pauses until they answer.',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
          required: ['question']
        },
        annotations: { readOnlyHint: true }
      }
    ]
  : []
let n = 0
const waits = new Map()

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = m
  if (method === 'notifications/cancelled') {
    const w = waits.get(params && params.requestId)
    if (w) {
      clearInterval(w.iv)
      waits.delete(params.requestId)
      fs.appendFileSync(path.join(LIVE, 'events.jsonl'), JSON.stringify({ hive: 'ask_user_cancelled', gate_id: w.gate }) + '\n')
    }
    return
  }
  if (id === undefined) return
  if (method === 'initialize')
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hivemem', version: '0' } } })
  if (method === 'server/discover') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call' && params && params.name === 'ask_user' && LIVE) {
    const gate = `ask_stub${++n}`
    const meta = params._meta || {}
    const a = params.arguments || {}
    fs.appendFileSync(
      path.join(LIVE, 'events.jsonl'),
      JSON.stringify({ hive: 'ask_user', gate_id: gate, question: String(a.question || ''), options: a.options || [], agent_hint: meta['claudecode/toolUseId'] || null }) + '\n'
    )
    const file = path.join(LIVE, 'answers', `${gate}.json`)
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(iv)
        waits.delete(id)
        const ans = JSON.parse(fs.readFileSync(file, 'utf8'))
        try {
          fs.rmSync(file)
        } catch {}
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(ans) }] } })
      } else if (Date.now() - t0 > 3600_000) {
        clearInterval(iv)
        waits.delete(id)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ answer: null, note: 'The user did not answer; continue with your best judgement.' }) }] } })
      }
    }, 100)
    waits.set(id, { iv, gate })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
})
