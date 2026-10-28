/**
 * Onboarding site read (ONBOARDING.md §5.3). One GET of a public web page, only on an explicit Continue:
 *
 * - http(s) only, default ports only, no credentials in the URL, no Instagram (stored as a link, never fetched);
 * - the host is DNS-resolved and refused when any address is loopback, private, link-local, CGNAT, multicast or
 *   reserved (also `localhost`, `*.localhost`, `*.local`); the connection is pinned to the checked address, so a second
 *   DNS answer can't swap it;
 * - at most 3 redirects, each re-checked the same way; 5 s for the whole chain; 512 KB of (decoded) body; no cookies
 *   sent or kept; UA "Principia onboarding";
 * - title, meta description, og:title / og:description / og:site_name and the first h1 by regex on the capped buffer,
 *   entities decoded, credentials and vault values redacted.
 *
 * No Electron imports.
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { HiveError } from '../../shared/errors'
import { MAX_URL_LENGTH, type SiteSummary } from '../../shared/onboarding'
import { stripAll } from '../../shared/stripAll'
import { redactCredentials } from '../memory/screen'

export const SITE_TIMEOUT_MS = 5000
export const SITE_MAX_BYTES = 512 * 1024
export const SITE_MAX_REDIRECTS = 3
export const SITE_UA = 'Principia onboarding'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}
export interface SiteResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** Decoded (decompressed) body, at most `maxBytes`. */
  body: Buffer
}
/** One HTTP GET to `url`, connecting to `addr` (already checked). Must honour `signal` and `maxBytes`. */
export type SiteTransport = (url: URL, addr: ResolvedAddress, opts: { signal: AbortSignal; maxBytes: number; headers: Record<string, string> }) => Promise<SiteResponse>

export interface SiteDeps {
  resolve?: (host: string) => Promise<ResolvedAddress[]>
  transport?: SiteTransport
  /** Address policy (default isPublicAddress). Tests only. */
  allowAddress?: (ip: string) => boolean
  redact?: (text: string) => string
  timeoutMs?: number
  now?: () => Date
}

const refuse = (msg: string): HiveError => new HiveError('bad_request', msg)
const NOT_PUBLIC = "Principia only reads public websites. Check the link, or skip it."

// ---------- address policy ----------

const blocked = new net.BlockList()
for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blocked.addSubnet(net4, prefix, 'ipv4')
}
for (const [net6, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // IPv4-compatible (deprecated)
  ['100::', 64], // discard
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215): can reach private IPv4 behind the translator
  ['2001:db8::', 32], // documentation
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4 (embeds an IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8] // multicast
] as const) {
  blocked.addSubnet(net6, prefix, 'ipv6')
}

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address, else null. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase()
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (dotted) return dotted[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex) {
    const a = parseInt(hex[1], 16)
    const b = parseInt(hex[2], 16)
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
  }
  return null
}

/** True only for a globally routable unicast address. */
export function isPublicAddress(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) return !blocked.check(ip, 'ipv4') && ip !== '255.255.255.255'
  if (kind === 6) {
    const v4 = embeddedV4(ip)
    if (v4) return isPublicAddress(v4)
    if (/^::ffff:/i.test(ip) || /^64:ff9b::/i.test(ip)) return false
    return !blocked.check(ip, 'ipv6')
  }
  return false
}

/** Host names refused before DNS. */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || (!h.includes('.') && net.isIP(h) === 0)
}

const defaultResolve = async (host: string): Promise<ResolvedAddress[]> => {
  const rows = await dns.promises.lookup(host, { all: true, verbatim: true })
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))
}

// ---------- URL normalization ----------

/** `sundaybakery.com` → `https://sundaybakery.com/`. Refuses non-http(s), credentials, odd ports and Instagram. */
export function normalizeSiteUrl(input: string): URL {
  let s = input.trim()
  if (!s || s.length > MAX_URL_LENGTH) throw refuse('Paste a website link')
  if (s.startsWith('@')) throw refuse("Saved as a link. Principia can't read Instagram yet.")
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || /^[^:/]+:\d+(\/|$)/.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw refuse('That doesn’t look like a website link')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw refuse('Only http and https links can be read')
  if (u.username || u.password) throw refuse("Links with a username or password can't be read")
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) throw refuse(NOT_PUBLIC)
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (/(^|\.)instagram\.com$|(^|\.)instagr\.am$/.test(host)) throw refuse("Saved as a link. Principia can't read Instagram yet.")
  u.hash = ''
  return u
}

async function checkedAddress(u: URL, resolve: (h: string) => Promise<ResolvedAddress[]>, allow: (ip: string) => boolean): Promise<ResolvedAddress> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const literal = net.isIP(host)
  if (literal) {
    if (!allow(host)) throw refuse(NOT_PUBLIC)
    return { address: host, family: literal === 6 ? 6 : 4 }
  }
  if (isBlockedHostname(host)) throw refuse(NOT_PUBLIC)
  let addrs: ResolvedAddress[]
  try {
    addrs = await resolve(host)
  } catch {
    throw refuse(`Couldn't find ${host}. Check the link.`)
  }
  if (!addrs.length) throw refuse(`Couldn't find ${host}. Check the link.`)
  // every answer must be public: a mixed answer is how rebinding tricks start
  if (addrs.some((a) => !allow(a.address))) throw refuse(NOT_PUBLIC)
  return addrs[0]
}

// ---------- transport ----------

/** node:http(s) GET pinned to `addr` (SNI and Host stay the URL's host). No agent pooling, no cookies. */
export const defaultTransport: SiteTransport = (url, addr, opts) =>
  new Promise<SiteResponse>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: opts.headers,
        agent: false,
        signal: opts.signal,
        lookup: ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (options?.all) cb(null, [{ address: addr.address, family: addr.family }])
          else cb(null, addr.address, addr.family)
        }) as unknown as net.LookupFunction
      },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = res.headers as SiteResponse['headers']
        if (status >= 300 && status < 400) {
          res.resume()
          resolve({ status, headers, body: Buffer.alloc(0) })
          return
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim()
        let stream: NodeJS.ReadableStream = res
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip())
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())
        const chunks: Buffer[] = []
        let size = 0
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          resolve({ status, headers, body: Buffer.concat(chunks).subarray(0, opts.maxBytes) })
        }
        stream.on('data', (c: Buffer) => {
          if (done) return
          chunks.push(c)
          size += c.length
          if (size >= opts.maxBytes) {
            finish()
            res.destroy()
          }
        })
        stream.on('end', finish)
        stream.on('error', (e: Error) => (done ? undefined : (done = true, reject(e))))
        res.on('error', (e: Error) => (done ? undefined : (done = true, reject(e))))
      }
    )
    req.on('error', reject)
    req.end()
  })

// ---------- extraction ----------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', euro: '€',
  pound: '£', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', atilde: 'ã', otilde: 'õ', ecirc: 'ê', ocirc: 'ô', acirc: 'â'
}

/** Decodes named (common subset) and numeric entities. Pure. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

const text = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined
  const v = decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return v || undefined
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

export interface SiteFacts {
  title?: string
  description?: string
  ogTitle?: string
  ogDescription?: string
  siteName?: string
  h1?: string
}

/** Regex extraction from (capped) HTML. Pure. */
export function extractSiteFacts(html: string): SiteFacts {
  const clean = stripAll(html, /<!--[\s\S]*?-->/g).replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const out: SiteFacts = {}
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(clean)
  out.title = text(title?.[1])
  const metaRe = /<meta\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(clean))) {
    const a = attrs(m[0])
    const key = (a.property ?? a.name ?? '').toLowerCase()
    const content = text(a.content)
    if (!content) continue
    if (key === 'description' && !out.description) out.description = content
    else if (key === 'og:title' && !out.ogTitle) out.ogTitle = content
    else if (key === 'og:description' && !out.ogDescription) out.ogDescription = content
    else if (key === 'og:site_name' && !out.siteName) out.siteName = content
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(clean)
  out.h1 = text(h1?.[1])
  return out
}

function charsetOf(contentType: string, head: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
  return (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase()
}

function decodeBody(body: Buffer, contentType: string): string {
  const label = charsetOf(contentType, body.subarray(0, 2048).toString('latin1'))
  try {
    return new TextDecoder(label, { fatal: false }).decode(body)
  } catch {
    return body.toString('utf8')
  }
}

// ---------- fetchSite ----------

const cap = (s: string | undefined, n: number): string | undefined => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s)
const header = (h: SiteResponse['headers'], k: string): string => {
  const v = h[k]
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

/** Reads a public web page's title/description/og/h1. Throws a HiveError with copy for the founder. */
export async function fetchSite(input: string, deps: SiteDeps = {}): Promise<SiteSummary> {
  const resolve = deps.resolve ?? defaultResolve
  const transport = deps.transport ?? defaultTransport
  const allow = deps.allowAddress ?? isPublicAddress
  const redact = deps.redact ?? ((t: string) => t)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? SITE_TIMEOUT_MS)
  timer.unref?.()
  const timedOut = (): HiveError => refuse('The site took too long to answer. You can skip it and fill this in yourself.')
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      if (ac.signal.aborted) return rej(timedOut())
      const onAbort = (): void => rej(timedOut())
      ac.signal.addEventListener('abort', onAbort, { once: true })
      p.then(
        (v) => (ac.signal.removeEventListener('abort', onAbort), res(v)),
        (e: unknown) => (ac.signal.removeEventListener('abort', onAbort), rej(ac.signal.aborted ? timedOut() : e))
      )
    })
  try {
    let url = normalizeSiteUrl(input)
    let res: SiteResponse | null = null
    for (let hop = 0; ; hop++) {
      const addr = await withTimeout(checkedAddress(url, resolve, allow))
      try {
        res = await withTimeout(
          transport(url, addr, {
            signal: ac.signal,
            maxBytes: SITE_MAX_BYTES,
            headers: { 'User-Agent': SITE_UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' }
          })
        )
      } catch (e) {
        if (e instanceof HiveError) throw e
        throw refuse(`Couldn't read ${url.hostname}. You can skip it and fill this in yourself.`)
      }
      if (res.status >= 300 && res.status < 400 && header(res.headers, 'location')) {
        if (hop >= SITE_MAX_REDIRECTS) throw refuse('The site redirected too many times')
        let next: URL
        try {
          next = normalizeSiteUrl(new URL(header(res.headers, 'location'), url).toString())
        } catch (e) {
          throw e instanceof HiveError ? e : refuse(NOT_PUBLIC)
        }
        url = next
        continue
      }
      break
    }
    if (!res || res.status < 200 || res.status >= 300) throw refuse(`The site answered ${res?.status ?? 'nothing'}. You can skip it and fill this in yourself.`)
    const ct = header(res.headers, 'content-type').toLowerCase()
    if (ct && !/text\/html|application\/xhtml\+xml/.test(ct)) throw refuse("That link isn't a web page")
    const facts = extractSiteFacts(decodeBody(res.body.subarray(0, SITE_MAX_BYTES), ct))
    const r = (s: string | undefined, n: number): string | undefined => {
      if (!s) return undefined
      const v = redact(redactCredentials(s)).trim()
      return v ? cap(v, n) : undefined
    }
    const out: SiteSummary = {
      url: url.toString().slice(0, MAX_URL_LENGTH),
      title: r(facts.title, 300),
      description: r(facts.description, 500),
      ogTitle: r(facts.ogTitle, 300),
      ogDescription: r(facts.ogDescription, 500),
      siteName: r(facts.siteName, 200),
      h1: r(facts.h1, 300),
      fetchedAt: (deps.now ?? (() => new Date()))().toISOString()
    }
    for (const k of Object.keys(out) as (keyof SiteSummary)[]) if (out[k] === undefined) delete out[k]
    return out
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
}
