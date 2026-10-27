import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
export function parseCommand(text) {
  const [command, ...rest] = String(text).trim().split(/\s+/)
  if (command === '/run') { const harness = rest.shift(); return { action: 'run', harness, prompt: rest.join(' ') } }
  if (command === '/workflow') return { action: 'workflow', id: rest.shift(), inputs: rest.length ? JSON.parse(rest.join(' ')) : {} }
  if (command === '/workflows') return { action: 'workflows' }
  if (command === '/runs') return { action: 'runs' }
  if (command === '/runstatus') return { action: 'runstatus', id: rest[0] }
  if (command === '/stopworkflow') return { action: 'stopworkflow', id: rest[0] }
  if (command === '/jobs') return { action: 'jobs' }
  if (command === '/job' || command === '/cancel') return { action: command.slice(1), id: rest[0] }
  return { action: 'help' }
}
export function authorized(message, users, chats) {
  return !!message?.from && users.has(String(message.from.id)) && chats.has(String(message.chat?.id))
}
export async function startTelegram({ token, users, chats, runner, workflows, signal }) {
  if (!users.size || !chats.size) throw new Error('Telegram requires both user and chat allowlists')
  const cursorFile = resolve(runner.dir, 'telegram-offset'); let offset = 0
  try { offset = Number(readFileSync(cursorFile, 'utf8')) || 0 } catch {}
  async function api(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`)
    const result = await res.json(); if (!result.ok) throw new Error('Telegram request rejected'); return result.result
  }
  while (!signal.aborted) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] })
      for (const update of updates) {
        // Persist before execution: restart cannot replay an already accepted command.
        offset = update.update_id + 1; writeFileSync(cursorFile, String(offset), { mode: 0o600 })
        const message = update.message; if (!authorized(message, users, chats)) continue
        let response
        try {
          const cmd = parseCommand(message.text)
          if (cmd.action === 'workflow' && workflows) { const run = workflows.start(cmd.id, cmd.inputs); response = `Started workflow run ${run.id}` }
          else if (cmd.action === 'workflows' && workflows) response = workflows.list().map(w => `${w.id} ${w.name}`).join('\n') || 'No workflows; import through the API first'
          else if (cmd.action === 'runs' && workflows) response = workflows.runs().slice(0, 10).map(r => `${r.id} ${r.status}`).join('\n') || 'No workflow runs'
          else if (cmd.action === 'runstatus' && workflows) response = JSON.stringify(workflows.get(cmd.id)).slice(-3500)
          else if (cmd.action === 'stopworkflow' && workflows) { await workflows.cancel(cmd.id); response = 'Cancellation requested' }
          else if (cmd.action === 'run') { const job = runner.submit(cmd); response = `Queued ${job.id} (${job.harness}). Use /job ${job.id}` }
          else if (cmd.action === 'jobs') response = runner.list().slice(0, 10).map(j => `${j.id} ${j.harness} ${j.status}`).join('\n') || 'No jobs'
          else if (cmd.action === 'cancel') response = runner.cancel(cmd.id) ? 'Cancellation requested' : 'Job not found or already finished'
          else if (cmd.action === 'job') { const job = runner.get(cmd.id); response = job ? `${job.id}: ${job.status}\n${job.output.slice(-3000)}` : 'Job not found' }
          else response = '/run codex <task>\n/run claude <task>\n/jobs\n/job <id>\n/cancel <id>\n/workflows\n/workflow <id> {"input":"value"}\n/runs\n/runstatus <id>\n/stopworkflow <id>'
        } catch (e) { response = runner.redact(e.message) }
        await api('sendMessage', { chat_id: message.chat.id, text: response.slice(0, 4000) })
      }
    } catch (e) {
      if (signal.aborted) break
      console.error('Telegram polling failed; retrying (credentials omitted)')
      await delay(5000, undefined, { signal }).catch(() => {})
    }
  }
}
