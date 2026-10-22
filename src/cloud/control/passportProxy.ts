/**
 * PRINCIPIA_PASSPORT=embedded (CLOUD.md §12.1, the one-click hosts): the Open Passport host runs inside this
 * container on 127.0.0.1, and its public paths are served on the cloud's own https origin. ChatGPT and Claude.ai then
 * reach `<cloud>/v1/passports/<id>/mcp` with the host's own OAuth 2.1 consent, and there is one URL, not two.
 * Only the host's paths are forwarded; everything else is the control plane's.
 */
import { request, type IncomingMessage, type ServerResponse } from 'node:http'

/** The Open Passport host's public paths (packages/server/src/app.ts), minus the control plane's own `/oauth/connectors`. */
export function isPassportPath(path: string): boolean {
  if (path === '/v1/passports' || path.startsWith('/v1/passports/')) return true
  if (path.startsWith('/v1/grants/')) return true
  if (path === '/oauth' || path.startsWith('/oauth/')) return !(path === '/oauth/connectors' || path.startsWith('/oauth/connectors/'))
  if (/^\/\.well-known\/(oauth-authorization-server|openid-configuration|oauth-protected-resource)(\/|$)/.test(path)) return true
  if (path.startsWith('/p/')) return true
  return false
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])

/** Streams the request to the embedded host and its answer back. The host sees the public origin in X-Forwarded-*. */
export function proxyToPassport(req: IncomingMessage, res: ServerResponse, target: string, publicUrl: string): Promise<void> {
  const t = new URL(target)
  const pub = new URL(publicUrl)
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v
  headers['x-forwarded-proto'] = pub.protocol.replace(':', '')
  headers['x-forwarded-host'] = pub.host
  return new Promise((resolve) => {
    const up = request({ host: t.hostname, port: t.port, method: req.method, path: req.url ?? '/', headers, timeout: 120_000 }, (r) => {
      const out: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) out[k] = v
      res.writeHead(r.statusCode ?? 502, out)
      r.pipe(res)
      r.on('end', () => resolve())
      r.on('error', () => { res.end(); resolve() })
    })
    up.on('timeout', () => up.destroy(new Error('timeout')))
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unavailable', message: 'The passport host is not answering.' }))
      resolve()
    })
    req.pipe(up)
  })
}
