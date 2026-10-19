import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Runner } from './runner.mjs'
import { startTelegram } from './telegram.mjs'
export function createApi(runner, token, workflows = null) {
  if (!token || token.length < 32) throw new Error('PRINCIPIA_API_TOKEN must contain at least 32 characters')
  return createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(runner.redact(JSON.stringify(body))) }
    const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' })
    const path = new URL(req.url, 'http://localhost').pathname
    try {
      if (req.method === 'GET' && path === '/health') return reply(200, { ok: true })
      if (workflows && req.method === 'GET' && path === '/workflows') return reply(200, workflows.list())
      if (workflows && req.method === 'GET' && path === '/runs') return reply(200, workflows.runs())
      const workflowRoute = /^\/workflows(?:\/([a-zA-Z0-9_-]+)\/run)?$/.exec(path)
      if (workflows && workflowRoute && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1000000) return reply(413, { error: 'Request too large' }) }
        const value = JSON.parse(body || '{}')
        return reply(202, workflowRoute[1] ? workflows.start(workflowRoute[1], value.inputs ?? {}) : workflows.import(value))
      }
      const runRoute = /^\/runs\/([a-zA-Z0-9_-]+)(\/cancel)?$/.exec(path)
      if (workflows && runRoute && req.method === 'GET' && !runRoute[2]) { const run = workflows.get(runRoute[1]); return reply(run ? 200 : 404, run ?? { error: 'Not found' }) }
      if (workflows && runRoute && req.method === 'POST' && runRoute[2]) { await workflows.cancel(runRoute[1]); return reply(200, { status: 'cancelled' }) }
      if (req.method === 'GET' && path === '/jobs') return reply(200, runner.list())
      if (req.method === 'POST' && path === '/jobs') {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 40000) return reply(413, { error: 'Request too large' }) }
        return reply(202, runner.submit(JSON.parse(body)))
      }
      const match = /^\/jobs\/([a-f0-9-]+)(\/cancel)?$/.exec(path)
      if (match && req.method === 'GET' && !match[2]) { const job = runner.get(match[1]); return reply(job ? 200 : 404, job ?? { error: 'Not found' }) }
      if (match && req.method === 'POST' && match[2]) return reply(runner.cancel(match[1]) ? 200 : 409, { id: match[1], status: runner.get(match[1])?.status ?? 'not_found' })
      reply(404, { error: 'Not found' })
    } catch (e) { reply(400, { error: runner.redact(e.message) }) }
  })
}
export async function main() {
  const env = process.env; const number = (name, fallback, max) => { const n = Number(env[name] ?? fallback); if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`); return n }
  if (!env.PRINCIPIA_API_TOKEN || env.PRINCIPIA_API_TOKEN.length < 32) throw new Error('PRINCIPIA_API_TOKEN must contain at least 32 characters')
  if (env.TELEGRAM_BOT_TOKEN && (!env.TELEGRAM_ALLOWED_USER_IDS || !env.TELEGRAM_ALLOWED_CHAT_IDS)) throw new Error('Telegram requires both user and chat allowlists')
  const runner = new Runner({ dataDir: env.PRINCIPIA_DATA_DIR ?? './principia-data', workspace: env.PRINCIPIA_WORKSPACE ?? process.cwd(), concurrency: number('PRINCIPIA_CONCURRENCY', 1, 8), timeoutMs: number('PRINCIPIA_TIMEOUT_MS', 1800000, 86400000), secrets: Object.entries(env).filter(([k]) => /TOKEN|SECRET|PASSWORD|API_KEY/.test(k)).map(([, v]) => v) })
  const { createCloudWorkflows } = await import('../out-cloud/workflows.mjs')
  const originalRedact = runner.redact.bind(runner)
  const workflows = await createCloudWorkflows({ dataDir: runner.dir, workspace: runner.workspace, redact: originalRedact })
  runner.attachment = cwd => workflows.attachment(cwd)
  runner.redact = text => workflows.redact(text)
  const server = createApi(runner, env.PRINCIPIA_API_TOKEN, workflows); const controller = new AbortController()
  server.requestTimeout = 15000; server.headersTimeout = 10000
  server.listen(number('PORT', 8787, 65535), env.HOST ?? '127.0.0.1', () => console.log('Principia runner listening'))
  if (env.TELEGRAM_BOT_TOKEN) void startTelegram({ token: env.TELEGRAM_BOT_TOKEN, users: new Set((env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').filter(Boolean)), workflows, chats: new Set((env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').filter(Boolean)), runner, signal: controller.signal }).catch(e => { console.error(e.message); process.exitCode = 1; server.close(); runner.close(); void workflows.close() })
  const stop = () => { controller.abort(); runner.close(); server.close(); void workflows.close() }; server.on('error', () => { console.error('Principia API listener failed'); process.exitCode = 1; stop() }); process.once('SIGTERM', stop); process.once('SIGINT', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
