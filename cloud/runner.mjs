import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export class Runner {
  constructor({ dataDir, workspace, concurrency = 1, timeoutMs = 1800000, commands = {}, secrets = [], attachment = () => null }) {
    this.dir = resolve(dataDir); this.workspace = realpathSync(workspace)
    this.concurrency = concurrency; this.timeoutMs = timeoutMs; this.commands = commands
    this.attachment = attachment; this.secrets = secrets.filter(Boolean); this.active = new Map(); this.jobs = []
    mkdirSync(this.dir, { recursive: true })
    try { this.jobs = JSON.parse(readFileSync(resolve(this.dir, 'jobs.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    for (const job of this.jobs) if (['running', 'queued'].includes(job.status)) Object.assign(job, { status: 'interrupted', endedAt: new Date().toISOString() })
    this.save()
  }
  redact(value) { let s = String(value); for (const secret of this.secrets) s = s.split(secret).join('[REDACTED]'); return s.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]') }
  save() { const file = resolve(this.dir, 'jobs.json'); writeFileSync(file + '.tmp', JSON.stringify(this.jobs), { mode: 0o600 }); renameSync(file + '.tmp', file) }
  list() { return this.jobs.map(({ output, prompt, ...job }) => job).reverse() }
  get(id) { return this.jobs.find(j => j.id === id) }
  submit({ prompt, harness = 'codex', cwd = '.' }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('prompt must contain 1–32000 characters')
    if (!['claude', 'codex'].includes(harness)) throw new Error('harness must be claude or codex')
    if (typeof cwd !== 'string') throw new Error('cwd must be a relative workspace path')
    const path = realpathSync(resolve(this.workspace, cwd))
    if (path !== this.workspace && !path.startsWith(this.workspace + sep)) throw new Error('cwd must stay inside workspace')
    const job = { id: randomUUID(), prompt: this.redact(prompt), harness, cwd: path, status: 'queued', output: '', createdAt: new Date().toISOString() }
    // Original prompt is only held in memory until spawn; secrets are never persisted.
    this.jobs.push(job); this.save(); this.pump(job.id, prompt); return job
  }
  pump(newId, rawPrompt) {
    this.pending ??= new Map(); if (newId) this.pending.set(newId, rawPrompt)
    while (this.active.size < this.concurrency) {
      const job = this.jobs.find(j => j.status === 'queued'); if (!job) break
      const prompt = this.pending.get(job.id) ?? job.prompt; this.pending.delete(job.id); this.start(job, prompt)
    }
  }
  start(job, prompt) {
    const command = this.commands[job.harness] ?? job.harness
    let args = job.harness === 'codex' ? ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt] : ['-p', prompt, '--permission-mode', 'dontAsk']
    const server = this.attachment(job.cwd)
    if (server) {
      if (job.harness === 'codex') {
        const config = [`mcp_servers.principia.command=${JSON.stringify(server.command)}`, `mcp_servers.principia.args=${JSON.stringify(server.args)}`, ...Object.entries(server.env ?? {}).map(([k, v]) => `mcp_servers.principia.env.${k}=${JSON.stringify(v)}`)]
        args.splice(args.length - 1, 0, ...config.flatMap(value => ['-c', value]))
      } else {
        const file = resolve(this.dir, `${job.id}.mcp.json`)
        writeFileSync(file, JSON.stringify({ mcpServers: { principia: { command: server.command, args: server.args, env: server.env } } }), { mode: 0o600 })
        args.splice(args.length - 1, 0, '--mcp-config', file, '--allowedTools', 'mcp__principia__principia_list_tools,mcp__principia__principia_call_tool')
      }
    }
    job.status = 'running'; job.startedAt = new Date().toISOString(); this.save()
    const child = spawn(command, args, { cwd: job.cwd, detached: process.platform !== 'win32', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PRINCIPIA_|TELEGRAM_|PORT$|HOST$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_CI$|NODE_OPTIONS$)/.test(name))), stdio: ['ignore', 'pipe', 'pipe'] })
    const state = { child, timer: null }; this.active.set(job.id, state)
    const append = chunk => { job.output = (job.output + this.redact(chunk.toString())).slice(-128000); this.save() }
    const buffers = new Map()
    const receive = stream => chunk => {
      const text = (buffers.get(stream) ?? '') + chunk.toString()
      const newline = text.lastIndexOf('\n')
      if (newline >= 0) { append(text.slice(0, newline + 1)); buffers.set(stream, text.slice(newline + 1)) }
      else buffers.set(stream, text.slice(-128000))
    }
    child.stdout.on('data', receive('stdout')); child.stderr.on('data', receive('stderr'))
    const finish = (code, error) => {
      if (!this.active.has(job.id)) return
      for (const text of buffers.values()) if (text) append(text)
      clearTimeout(state.timer); if (!['cancelled', 'timed_out', 'interrupted'].includes(job.status)) clearTimeout(state.killTimer); this.active.delete(job.id)
      if (job.status === 'running') job.status = code === 0 && !error ? 'succeeded' : 'failed'
      if (error) append(error.message)
      if (server?.env?.PRINCIPIA_GATEWAY_DIR) { try { writeFileSync(resolve(server.env.PRINCIPIA_GATEWAY_DIR, 'closed'), '') } catch {} }
      job.exitCode = code; job.endedAt = new Date().toISOString(); this.save(); this.pump()
    }
    child.on('error', error => finish(null, error)); child.on('close', code => finish(code))
    state.timer = setTimeout(() => this.cancel(job.id, 'timed_out'), this.timeoutMs)
  }
  cancel(id, status = 'cancelled') {
    const job = this.get(id); if (!job) return false
    if (!['queued', 'running'].includes(job.status)) return false
    job.status = status; job.endedAt = new Date().toISOString(); this.pending?.delete(id)
    const state = this.active.get(id)
    if (state) {
      const kill = signal => { try { process.kill(process.platform === 'win32' ? state.child.pid : -state.child.pid, signal) } catch {} }
      kill('SIGTERM'); state.killTimer = setTimeout(() => kill('SIGKILL'), 3000)
    }
    this.save(); return true
  }
  close() { for (const job of this.jobs) if (['queued', 'running'].includes(job.status)) this.cancel(job.id, 'interrupted') }
}
