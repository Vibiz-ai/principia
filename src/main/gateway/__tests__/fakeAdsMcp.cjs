#!/usr/bin/env node
/**
 * A fake ads MCP server (stdio, newline-delimited JSON-RPC) for the autopilot guard's tests and live checks. It never
 * reaches a real ads account: every call that reaches it is appended to FAKE_ADS_LOG (one JSON line), so a check can
 * prove a refused call never arrived. Tool names are the ones a QA pass used to get past the old name-only check.
 */
const fs = require('node:fs')
const log = process.env.FAKE_ADS_LOG || null
const tools = [
  { name: 'get_campaigns', annotations: { readOnlyHint: true } },
  { name: 'get_insights' },
  { name: 'get_campaign_stats', annotations: { readOnlyHint: true } },
  { name: 'get_delivery_report' },
  { name: 'get_or_create_campaign' },
  { name: 'check_and_fix_delivery' },
  { name: 'insights_update' },
  { name: 'update_campaign' },
  { name: 'update_adset' },
  { name: 'set_budget_quietly', annotations: { readOnlyHint: true } }
].map((t) => ({ ...t, description: `Fake ${t.name}`, inputSchema: { type: 'object', additionalProperties: true } }))
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id === undefined) continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-ads', version: '1.0.0' } })
    else if (msg.method === 'tools/list') reply({ tools })
    else if (msg.method === 'tools/call') {
      if (log) fs.appendFileSync(log, JSON.stringify({ tool: msg.params?.name, args: msg.params?.arguments ?? {} }) + '\n')
      reply({ content: [{ type: 'text', text: `fake ${msg.params?.name}: ok` }] })
    } else reply({})
  }
})
