/**
 * Connectors in the cloud (CLOUD.md §7.5): one GatewayService per company, fed fresh from RunMaterials.connections
 * before each run, plus the built-in `passport` connection (Open Passport connected by default, §7.1). Roots are the
 * company folder. Credentials live only in this process (encrypted with a per-process key) and in the upstream
 * connection; an agent gets the bridge command and a grant folder, never a header or a key.
 *
 * The passport host usually sits on the compose network (`http://passport:8787`), which the gateway's HTTPS rule would
 * refuse. A tiny loopback relay forwards only `/v1/passports/<id>/mcp` to it, so the gateway still talks to
 * 127.0.0.1 and the rule stays as it is.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { McpServerSpec } from '../../shared/engine'
import { GatewayService } from '../../main/gateway/service'
import type { ConnectionMaterial, PassportMaterial } from '../contract'

export const PASSPORT_CONNECTION_ID = 'passport'
const MCP_PATH = /^\/v1\/passports\/[A-Za-z0-9._~-]{1,128}\/mcp$/

export interface CompanyGatewaysOptions {
  /** `<runtime>/gateway` */
  dir: string
  /** out-cloud: holds mcp-gateway.mjs */
  bundleDir: string
  baseEnv(): Record<string, string>
  companyDir(companyId: string): string
  addSecret(value: string): void
  /** CLOUD.md §7.8: the agent user; its bridge reads the grant folders, never the saved connections */
  agentUser?: { uid: number; gid: number } | null
}

/** AES-256-GCM with a key that lives only in this process: materials arrive fresh with every run. */
export function processCipher(key: Buffer = randomBytes(32)) {
  return {
    available: () => true,
    encrypt: (plain: string) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), enc])
    },
    decrypt: (data: Buffer) => {
      const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      d.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8')
    }
  }
}

const loopback = (u: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)

/** Forwards `/r/<key>/v1/passports/<id>/mcp` to the registered host. Loopback only; no other path. */
export class PassportRelay {
  private server: http.Server | null = null
  private port = 0
  private readonly targets = new Map<string, string>()

  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    server.unref()
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  /** The local URL of a passport's MCP endpoint on `internalUrl`. */
  url(internalUrl: string, passportId: string): string {
    let key = [...this.targets.entries()].find(([, v]) => v === internalUrl)?.[0]
    if (!key) {
      key = randomBytes(9).toString('base64url')
      this.targets.set(key, internalUrl.replace(/\/+$/, ''))
    }
    return `http://127.0.0.1:${this.port}/r/${key}/v1/passports/${encodeURIComponent(passportId)}/mcp`
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const m = /^\/r\/([A-Za-z0-9_-]+)(\/.*)$/.exec(req.url ?? '')
      const target = m ? this.targets.get(m[1]!) : undefined
      if (!m || !target || !MCP_PATH.test(m[2]!) || req.headers.origin) {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const c of req) {
        size += (c as Buffer).length
        if (size > 4 * 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
        chunks.push(c as Buffer)
      }
      const forward: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && /^(authorization|content-type|accept|mcp-[a-z-]+)$/i.test(k)) forward[k] = v
      const upstream = await fetch(`${target}${m[2]}`, { method: req.method, headers: forward, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks), redirect: 'error', signal: AbortSignal.timeout(60_000) })
      const out: Record<string, string> = {}
      upstream.headers.forEach((v, k) => {
        if (/^(content-type|mcp-[a-z-]+|www-authenticate)$/i.test(k)) out[k] = v
      })
      res.writeHead(upstream.status, out)
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }
}

export class CompanyGateways {
  private readonly services = new Map<string, GatewayService>()
  private readonly cipher = processCipher()
  readonly relay = new PassportRelay()

  constructor(private readonly o: CompanyGatewaysOptions) {
    // ciphertext from an earlier process cannot be read with this process's key: start clean
    rmSync(o.dir, { recursive: true, force: true })
    mkdirSync(o.dir, { recursive: true, mode: 0o700 })
    if (o.agentUser) chmodSync(o.dir, 0o711)
  }

  async start(): Promise<void> {
    await this.relay.start()
  }

  private service(companyId: string): GatewayService {
    let s = this.services.get(companyId)
    if (!s) {
      const userData = join(this.o.dir, companyId)
      mkdirSync(userData, { recursive: true, mode: 0o700 })
      s = new GatewayService({
        userData,
        mainDir: this.o.bundleDir,
        bridgePath: join(this.o.bundleDir, 'mcp-gateway.mjs'),
        cipher: this.cipher,
        vault: { addRedactions: (_name, value) => this.o.addSecret(value) },
        baseEnv: () => this.o.baseEnv(),
        fileOwner: this.o.agentUser ?? null
      })
      this.services.set(companyId, s)
    }
    return s
  }

  /** The passport connection as the gateway stores it (direct when https or loopback, else through the relay). */
  passportConnection(p: PassportMaterial): { url: string; credentials: Record<string, string> } {
    const direct = `${p.internalUrl.replace(/\/+$/, '')}/v1/passports/${encodeURIComponent(p.passportId)}/mcp`
    const u = new URL(direct)
    return { url: u.protocol === 'https:' || loopback(u) ? direct : this.relay.url(p.internalUrl, p.passportId), credentials: { Authorization: `Bearer ${p.token}` } }
  }

  /** Replaces the company's connections with these (and the built-in passport). Bad entries are skipped and returned. */
  sync(companyId: string, connections: ConnectionMaterial[], passport: PassportMaterial | null): string[] {
    const s = this.service(companyId)
    const root = this.o.companyDir(companyId)
    const keep = new Set<string>()
    const problems: string[] = []
    for (const c of connections) {
      if (c.id === PASSPORT_CONNECTION_ID) continue
      for (const v of Object.values(c.credentials ?? {})) this.o.addSecret(v)
      try {
        s.save({ id: c.id, name: c.name, transport: c.transport, ...(c.command ? { command: c.command } : {}), ...(c.args ? { args: c.args } : {}), ...(c.url ? { url: c.url } : {}), enabled: true, roots: [root], authentication: 'none', credentials: c.credentials ?? {} })
        keep.add(c.id)
      } catch (e) {
        problems.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (passport) {
      const pc = this.passportConnection(passport)
      this.o.addSecret(passport.token)
      s.save({ id: PASSPORT_CONNECTION_ID, name: 'Open Passport', transport: 'http', url: pc.url, enabled: true, roots: [root], authentication: 'none', credentials: pc.credentials })
      keep.add(PASSPORT_CONNECTION_ID)
    }
    for (const saved of s.list()) if (!keep.has(saved.id)) s.remove(saved.id)
    return problems
  }

  /** EngineContext.gateway.attachment: the bridge for a spawn in `cwd` of `companyId`, or null. */
  attachment(cwd: string, companyId?: string | null): McpServerSpec | null {
    if (!companyId) return null
    return this.services.get(companyId)?.attachment(cwd, companyId) ?? null
  }

  list(companyId: string) {
    return this.services.get(companyId)?.list() ?? []
  }

  remove(companyId: string): void {
    this.services.get(companyId)?.close()
    this.services.delete(companyId)
    rmSync(join(this.o.dir, companyId), { recursive: true, force: true })
  }

  async close(): Promise<void> {
    for (const s of this.services.values()) s.close()
    this.services.clear()
    await this.relay.stop()
  }
}
