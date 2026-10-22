/** A local stand-in for the Open Passport host (SPEC §11.2 subset the control plane uses). */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface FakeGrant { id: string; passport: string; app: string; scopes: string[]; trusted: boolean; token: string; revoked: boolean }
export interface FakeHost {
  url: string
  admin: string
  passports: Map<string, { revision: number; bundle: Buffer; proposals: { id: string; kind: string; app: string; created: string; payload: unknown; status: string }[] }>
  grants: FakeGrant[]
  requests: { method: string; path: string; auth: string }[]
  down: boolean
  close(): Promise<void>
}

export async function startFakeHost(admin = 'fake-admin-token-0123456789'): Promise<FakeHost> {
  const passports: FakeHost['passports'] = new Map()
  const grants: FakeGrant[] = []
  const requests: FakeHost['requests'] = []
  const state = { down: false }
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://x')
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    requests.push({ method: req.method ?? '', path: url.pathname, auth })
    const send = (s: number, v: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (state.down) { res.destroy(); return }
    if (url.pathname === '/healthz') return send(200, { ok: true })
    const isAdmin = auth === admin
    const grant = grants.find(g => g.token === auth && !g.revoked)
    const owner = (pid: string) => isAdmin || (grant?.passport === pid && grant.scopes.includes('owner'))
    const parts = url.pathname.split('/').filter(Boolean)
    if (req.method === 'POST' && url.pathname === '/v1/passports') {
      if (!isAdmin) return send(403, { error: 'admin only' })
      if (body.subarray(0, 2).toString('latin1') !== 'PK') return send(400, { error: 'not a zip' })
      const id = url.searchParams.get('id') ?? `op-${randomBytes(4).toString('hex')}`
      if (passports.has(id)) return send(409, { error: `passport ${id} exists` })
      passports.set(id, { revision: 1, bundle: body, proposals: [] })
      return send(201, { id, revision: 1, digest: 'sha256:x', parent: null, created: new Date().toISOString(), author: 'admin', app: null })
    }
    if (req.method === 'DELETE' && parts[1] === 'grants' && parts[2]) {
      const g = grants.find(x => x.id === parts[2])
      if (!g) return send(404, { error: 'grant not found' })
      if (!owner(g.passport)) return send(403, { error: 'owner only' })
      g.revoked = true
      return send(200, { id: g.id, revoked: true })
    }
    const pid = parts[2]!
    const p = passports.get(pid)
    if (!p) return send(404, { error: 'passport not found' })
    const rest = parts.slice(3).join('/')
    if (rest === 'grants' && req.method === 'POST') {
      if (!owner(pid)) return send(403, { error: 'only the owner creates grants' })
      const b = JSON.parse(body.toString('utf8')) as { app: string; scopes: string[]; trusted: boolean }
      const g: FakeGrant = { id: `g_${randomBytes(4).toString('hex')}`, passport: pid, app: b.app, scopes: b.scopes, trusted: b.trusted, token: `opk_${randomBytes(24).toString('hex')}`, revoked: false }
      grants.push(g)
      return send(201, { id: g.id, token: g.token, scopes: g.scopes, trusted: g.trusted })
    }
    if (parts[3] === 'grants' && parts[4] && req.method === 'PATCH') {
      if (!owner(pid)) return send(403, { error: 'owner only' })
      const g = grants.find(x => x.id === parts[4])!
      g.trusted = (JSON.parse(body.toString('utf8')) as { trusted: boolean }).trusted
      return send(200, { id: g.id, trusted: g.trusted })
    }
    if (!rest && req.method === 'GET') {
      if (!isAdmin && grant?.passport !== pid) return send(401, { error: 'no' })
      return send(200, { id: pid, name: 'Acme', revision: p.revision, digest: 'sha256:x', l0: '', departments: [], tokens: 1 })
    }
    if (rest === 'proposals' && req.method === 'GET') {
      if (!owner(pid)) return send(403, { error: 'owner only' })
      return send(200, p.proposals.filter(x => x.status === 'pending'))
    }
    if (parts[3] === 'proposals' && parts[4] && req.method === 'POST') {
      if (!owner(pid)) return send(403, { error: 'owner only' })
      const pr = p.proposals.find(x => x.id === parts[4])
      if (!pr) return send(404, { error: 'proposal not found' })
      pr.status = parts[5] === 'accept' ? 'accepted' : 'rejected'
      if (parts[5] === 'accept') p.revision++
      return send(200, { status: parts[5] === 'accept' ? 'applied' : 'unchanged', revision: p.revision })
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  const host: FakeHost = {
    url: `http://127.0.0.1:${addr.port}`, admin, passports, grants, requests,
    get down() { return state.down }, set down(v: boolean) { state.down = v },
    close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() })
  }
  return host
}

/** the smallest valid-looking zip: a stored entry (enough for the fake; the real host needs a real passport) */
export const TINY_ZIP = Buffer.from('UEsDBAoAAAAAAAAAIQAAAAAAAAAAAAAAAAAIAAAAZW1wdHkubWRQSwECFAAKAAAAAAAAACEAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAABlbXB0eS5tZFBLBQYAAAAAAQABADYAAAAmAAAAAAA=', 'base64')
