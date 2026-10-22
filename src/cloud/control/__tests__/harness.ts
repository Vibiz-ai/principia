/** Boots a real control plane app on 127.0.0.1:0 with a fake runtime, for HTTP-level tests. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ControlConfig } from '../context'
import { createControlApp, type ControlApp } from '../server'
import { createFakeRuntime, type FakeRuntime } from './fakeRuntime'

export const ADMIN = 'admin-token-0123456789-0123456789-abcdef'

export interface Harness {
  app: ControlApp
  url: string
  rt: FakeRuntime
  logs: string[]
  dir: string
  masterKey: Buffer
  call(method: string, path: string, o?: { token?: string | null; body?: unknown; rawBody?: Buffer | string; headers?: Record<string, string> }): Promise<{ status: number; json: any; text: string; headers: Headers }>
  pair(name?: string): Promise<string>
  close(): Promise<void>
}

export async function startHarness(o: { config?: Partial<ControlConfig>; autoComplete?: boolean; now?: () => Date; masterKey?: Buffer; dir?: string; heartbeatMs?: number } = {}): Promise<Harness> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'pcloud-'))
  const masterKey = o.masterKey ?? randomBytes(32)
  const logs: string[] = []
  let rt!: FakeRuntime
  const config: ControlConfig = {
    publicUrl: 'http://127.0.0.1:1', adminToken: ADMIN, workspaceName: 'Test cloud', consoleDir: join(dir, 'console'), dataDir: dir, workspaceDir: join(dir, 'ws'),
    logRetentionDays: 30, connectorAllowPrivate: [], passport: null, ...o.config
  }
  const app = createControlApp({ config, masterKey, createRuntime: ports => (rt = createFakeRuntime(ports, { autoComplete: o.autoComplete })), logWrite: l => logs.push(l), tickMs: 0, now: o.now, heartbeatMs: o.heartbeatMs })
  await app.start()
  const server = app.server()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  app.ctx.config.publicUrl = url
  const h: Harness = {
    app, url, rt, logs, dir, masterKey,
    async call(method, path, c = {}) {
      const headers: Record<string, string> = { ...c.headers }
      if (c.token) headers.authorization = `Bearer ${c.token}`
      let body: BodyInit | undefined
      if (c.rawBody !== undefined) body = typeof c.rawBody === 'string' ? c.rawBody : new Uint8Array(c.rawBody)
      else if (c.body !== undefined) { body = JSON.stringify(c.body); headers['content-type'] = 'application/json' }
      const res = await fetch(url + path, { method, headers, body, redirect: 'manual' })
      const text = await res.text()
      let json: any = null
      try { json = JSON.parse(text) } catch { json = null }
      return { status: res.status, json, text, headers: res.headers }
    },
    async pair(name = 'Test Mac') {
      const start = await h.call('POST', '/v1/pair/start', { token: ADMIN })
      const done = await h.call('POST', '/v1/pair/complete', { body: { code: start.json.code, deviceName: name, platform: 'darwin-arm64' } })
      if (done.status !== 201) throw new Error(`pair failed ${done.status} ${done.text}`)
      return done.json.deviceToken as string
    },
    async close() { await app.close(); if (!o.dir) rmSync(dir, { recursive: true, force: true }) }
  }
  return h
}

/** a console session: device mints a login link, the browser consumes it */
export async function consoleSession(h: Harness, device: string): Promise<{ cookie: string; csrf: string }> {
  const link = await h.call('POST', '/v1/login-links', { token: device })
  const t = new URL(link.json.url).searchParams.get('t')!
  const login = await h.call('GET', `/console/login?t=${t}`)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const me = await h.call('GET', '/v1/me', { headers: { cookie } })
  return { cookie, csrf: me.json.csrf }
}

export const workflowFile = (name: string, nodes: Record<string, unknown>[] = [{ id: 'main', type: 'agent', label: 'Main', after: [], cwd: null, timeoutMin: 30, profileId: 'prof_codex', prompt: 'Write the brief.' }]) =>
  ({ hive: 'workflow', version: 1, workflow: { name, description: '', inputs: [], nodes } })
