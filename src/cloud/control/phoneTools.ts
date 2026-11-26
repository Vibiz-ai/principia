/**
 * A cloud chat's folder on the phone (docs/CLOUD-PHONE.md): its files, its changes (git), a shell in it, and a preview
 * of a server it started. Only for chats this cloud owns (phoneChats.ts), only for a paired phone, and only inside
 * that chat's own folder:
 *
 * - Paths come from the phone relative to the chat's folder. Each one is resolved, its real path (symlinks followed)
 *   must stay inside the folder, and on Linux the opened descriptor is checked again (/proc/self/fd), so a link that
 *   is swapped in between leads nowhere.
 * - git and the shell run as the agent user with the chat's own environment (ChatProcs.workspace), with timeouts and
 *   output caps. The shell is line mode (bash on pipes, no pty): node-pty is not part of the cloud build.
 * - A preview is `/preview/<chatId>/<port>/<token>/…`, proxied to 127.0.0.1:<port>. A browser tab sends no bearer, so
 *   an authenticated call mints the token (8 hours, bound to the phone, the chat and the port; a revoked phone's
 *   tokens stop at once). The page is served sandboxed (CSP `sandbox` without same-origin): it runs on this cloud's
 *   origin, and must never read the phone's token or this cloud's cookies. Cookies go neither way.
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ChatWorkspace } from '../contract'
import type { PhoneChanges, PhoneDir, PhoneFile, PhonePorts, PhoneShellClientMsg, PhoneShellServerMsg } from '../../shared/remote'
import { REMOTE_WS_AUTH_MS } from '../../shared/remote'
import type { Ctx } from './context'
import { ApiError } from './http'
import type { PhoneChats } from './phoneChats'

/** a file shown on the phone: up to 256 KB of it; bigger than 2 MB is refused outright */
export const FILE_SHOW_BYTES = 256 * 1024
export const FILE_MAX_BYTES = 2 * 1024 * 1024
const DIR_MAX = 2000
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BYTES = 1024 * 1024
/** the shell's scrollback kept for a phone that comes back */
export const SHELL_KEEP_CHARS = 200_000
/** nobody watches the shell for this long: it ends */
export const SHELL_GRACE_MS = 5 * 60_000
const SHELL_LINE_MAX = 8000
export const PREVIEW_TTL_MS = 8 * 3600_000
const PREVIEW_RE = /^\/preview\/([0-9A-Za-z_-]{1,96})\/(\d{1,5})\/([0-9A-Za-z_-]{1,64}\.\d{1,15}\.[0-9a-f]{32})(\/.*)?$/
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization', 'origin', 'referer'])
/** the page runs scripts and forms, as an opaque origin: never this cloud's own */
export const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox'
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g

export interface PhoneToolsDeps {
  ctx: Ctx
  chats: PhoneChats
  /** the chat's folder and environment (runtime.chats.workspace with the workspace keys); null: none on this machine */
  workspace(id: string): ChatWorkspace | null
  /** something happened that keeps a managed machine awake (activity.ts) */
  touched(): void
  /** a device token -> the phone, or null */
  device(token: string | null): { id: string; name: string } | null
  /** this server's own port: never previewed */
  ownPort(): number | null
  /** tests: where /proc is (null: no procfs, ports unknown and any port in range may be previewed) */
  procRoot?: string | null
  shellGraceMs?: number
  /** tests: the shell (default /bin/bash) */
  shell?: string
}

// ---------- paths ----------

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/** A path from the phone ('' = the folder itself) -> its real path inside root. Throws 404 / 400 in plain words. */
export function confinePath(root: string, rel: unknown): string {
  const r = typeof rel === 'string' ? rel : ''
  if (r.length > 4096 || r.includes('\0')) throw new ApiError('bad_request', 'That path is not valid.')
  const target = resolve(root, r.replace(/^\/+/, ''))
  if (!inside(root, target)) throw new ApiError('bad_request', 'That is outside the chat\'s folder.')
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    throw new ApiError('not_found', 'It is not there any more.')
  }
  if (!inside(root, real)) throw new ApiError('bad_request', 'That leads outside the chat\'s folder.')
  return real
}

/** Opens a confined path; on Linux the descriptor itself must still be inside (a link swapped in meanwhile). */
function openConfined(root: string, real: string, dir: boolean): number {
  let fd: number
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (dir ? (constants.O_DIRECTORY ?? 0) : 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    throw new ApiError('not_found', dir ? 'That folder can not be opened.' : 'That file can not be opened.')
  }
  try {
    const via = readlinkSync(`/proc/self/fd/${fd}`)
    if (!inside(root, via)) {
      closeSync(fd)
      throw new ApiError('bad_request', 'That leads outside the chat\'s folder.')
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    /* no procfs (a Mac in development): the real path was checked */
  }
  return fd
}

const relOf = (root: string, real: string): string => relative(root, real).split(sep).join('/')

export function listDir(w: ChatWorkspace, rel: unknown): PhoneDir {
  const real = confinePath(w.root, rel)
  if (!statSync(real).isDirectory()) throw new ApiError('bad_request', 'That is a file, not a folder.')
  const fd = openConfined(w.root, real, true)
  try {
    const base = existsProc(fd) ? `/proc/self/fd/${fd}` : real
    const names = readdirSync(base)
    const entries: PhoneDir['entries'] = []
    for (const name of names) {
      let kind: PhoneDir['entries'][number]['kind'] = 'other'
      let size: number | null = null
      try {
        const st = lstatSync(join(base, name))
        if (st.isDirectory()) kind = 'dir'
        else if (st.isFile()) {
          kind = 'file'
          size = st.size
        } else if (st.isSymbolicLink()) {
          // a link is shown as what it leads to, when that is inside the folder
          try {
            const to = realpathSync(join(real, name))
            const ts = statSync(to)
            kind = inside(w.root, to) ? (ts.isDirectory() ? 'dir' : ts.isFile() ? 'file' : 'other') : 'link'
            if (kind === 'file') size = ts.size
          } catch {
            kind = 'link'
          }
        }
      } catch {
        continue
      }
      entries.push({ name, kind, size })
    }
    entries.sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
    return { path: relOf(w.root, real), entries: entries.slice(0, DIR_MAX), more: Math.max(0, entries.length - DIR_MAX) }
  } finally {
    closeSync(fd)
  }
}

function existsProc(fd: number): boolean {
  try {
    readlinkSync(`/proc/self/fd/${fd}`)
    return true
  } catch {
    return false
  }
}

/** a text file (up to FILE_SHOW_BYTES of it); a binary file or one over FILE_MAX_BYTES is refused */
export function readText(w: ChatWorkspace, rel: unknown): PhoneFile {
  const real = confinePath(w.root, rel)
  const fd = openConfined(w.root, real, false)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new ApiError('bad_request', 'That is not a file.')
    if (st.size > FILE_MAX_BYTES) throw new ApiError('bad_request', `That file is ${Math.round(st.size / 1024 / 1024)} MB: too big to show on a phone.`)
    const buf = Buffer.alloc(Math.min(st.size, FILE_SHOW_BYTES))
    let n = 0
    while (n < buf.length) {
      const k = readSync(fd, buf, n, buf.length - n, n)
      if (!k) break
      n += k
    }
    const bytes = buf.subarray(0, n)
    if (isBinary(bytes)) throw new ApiError('bad_request', 'That is a binary file: it can not be shown as text.')
    // a cut in the middle of a character loses only that character
    return { path: relOf(w.root, real), size: st.size, text: bytes.toString('utf8'), truncated: st.size > n }
  } finally {
    closeSync(fd)
  }
}

export function isBinary(b: Buffer): boolean {
  const head = b.subarray(0, 8192)
  if (head.includes(0)) return true
  let odd = 0
  for (const c of head) if (c < 7 || (c > 13 && c < 32 && c !== 27)) odd++
  return head.length > 0 && odd / head.length > 0.1
}

// ---------- git ----------

interface RunOut { code: number | null; out: string; err: string; truncated: boolean; timedOut: boolean }

/** A process as the chat's own (its user, its env), with a timeout and an output cap. Never a shell. */
export function runIn(w: ChatWorkspace, file: string, args: string[], o: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<RunOut> {
  const max = o.maxBytes ?? GIT_MAX_BYTES
  return new Promise((done) => {
    let child
    try {
      child = spawn(file, args, { cwd: o.cwd ?? w.cwd, env: { ...w.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...(w.user ? { uid: w.user.uid, gid: w.user.gid } : {}) })
    } catch (e) {
      return done({ code: null, out: '', err: (e as Error).message, truncated: false, timedOut: false })
    }
    const out: Buffer[] = []
    let n = 0
    let truncated = false
    let err = ''
    let timedOut = false
    const kill = (): void => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, o.timeoutMs ?? GIT_TIMEOUT_MS)
    child.stdout!.on('data', (d: Buffer) => {
      if (truncated) return
      if (n + d.length > max) {
        out.push(d.subarray(0, max - n))
        n = max
        truncated = true
        kill()
        return
      }
      out.push(d)
      n += d.length
    })
    child.stderr!.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ code: null, out: '', err: e.message, truncated: false, timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: truncated ? 0 : code, out: Buffer.concat(out).toString('utf8'), err, truncated, timedOut })
    })
  })
}

const GIT_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'diff.external=', '--no-pager']

/** git status and diff of the chat's clone: the working tree against HEAD, and the branch against the default branch. */
export async function changesOf(w: ChatWorkspace, git = 'git'): Promise<PhoneChanges> {
  const g = (args: string[], max?: number) => runIn(w, git, [...GIT_FLAGS, ...args], max ? { maxBytes: max } : {})
  const top = await g(['rev-parse', '--show-toplevel'])
  let topReal: string | null
  try {
    topReal = top.code === 0 ? realpathSync(top.out.trim()) : null
  } catch {
    topReal = null
  }
  // no clone in this chat (or git found one above its folder): nothing to show
  if (!topReal || !inside(w.root, topReal)) return { repo: null, branch: null, base: null, status: [], diff: '', diffTruncated: false, commits: [], branchDiff: '', branchDiffTruncated: false, ahead: null }
  const status = await g(['status', '--porcelain=v1', '--branch', '--untracked-files=all'], 256 * 1024)
  const lines = status.out.split('\n').filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : ''
  const branch = head.replace(/^No commits yet on /, '').split('...')[0]!.trim() || null
  const files = lines.slice(0, 500).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }))
  const hasHead = (await g(['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0
  const diff = hasHead ? await g(['diff', 'HEAD', '--no-color', '--no-ext-diff', '-M']) : await g(['diff', '--cached', '--no-color', '--no-ext-diff'])
  // the branch against where it will merge: the remote's default branch, else its upstream
  let base: string | null = null
  const def = await g(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (def.code === 0 && def.out.trim()) base = def.out.trim()
  const up = await g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const upstream = up.code === 0 && up.out.trim() ? up.out.trim() : null
  base ??= upstream
  let commits: PhoneChanges['commits'] = []
  let branchDiff = ''
  let branchDiffTruncated = false
  if (base && hasHead && /^[A-Za-z0-9._/-]{1,200}$/.test(base)) {
    const log = await g(['log', '--no-color', '--format=%h%x09%s', '-n', '50', `${base}..HEAD`, '--'])
    commits = log.out.split('\n').filter(Boolean).map((l) => ({ sha: l.split('\t')[0]!, subject: l.split('\t').slice(1).join('\t') }))
    if (commits.length) {
      const bd = await g(['diff', '--no-color', '--no-ext-diff', '-M', `${base}...HEAD`, '--'])
      branchDiff = bd.out
      branchDiffTruncated = bd.truncated
    }
  }
  let ahead: number | null = null
  if (upstream && hasHead) {
    const c = await g(['rev-list', '--count', `${upstream}..HEAD`, '--'])
    ahead = c.code === 0 ? Number(c.out.trim()) || 0 : null
  }
  return { repo: relOf(w.root, topReal), branch, base, status: files, diff: diff.out, diffTruncated: diff.truncated, commits, branchDiff, branchDiffTruncated, ahead }
}

// ---------- listening ports ----------

/** /proc/net/tcp{,6} -> listening sockets: port, owner uid, inode */
export function parseProcNet(text: string): { port: number; uid: number; inode: string; address: string }[] {
  const out: { port: number; uid: number; inode: string; address: string }[] = []
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '0A') continue
    const [addr, port] = f[1]!.split(':')
    const zero = /^0+$/.test(addr!)
    const loop = addr === '0100007F' || addr === '00000000000000000000000001000000'
    out.push({ port: parseInt(port!, 16), uid: Number(f[7]), inode: f[9]!, address: zero ? 'all' : loop ? 'loopback' : 'other' })
  }
  return out
}

/** Ports listened on by the agent's processes (or this process's user, without one), the chat's own marked. null: no procfs. */
export function listeningPorts(procRoot: string | null, uid: number, chatRoot: string, ownPort: number | null): PhonePorts['ports'] | null {
  if (!procRoot) return null
  let socks: ReturnType<typeof parseProcNet>
  try {
    socks = [...parseProcNet(readFileSync(join(procRoot, 'net/tcp'), 'utf8')), ...(() => {
      try {
        return parseProcNet(readFileSync(join(procRoot, 'net/tcp6'), 'utf8'))
      } catch {
        return []
      }
    })()]
  } catch {
    return null
  }
  socks = socks.filter((s) => s.uid === uid && s.port >= 1024 && s.port !== ownPort)
  if (!socks.length) return []
  // which of them a process working in this chat's folder holds (best effort: root reads /proc/<pid>/fd)
  const mine = new Set<string>()
  try {
    const want = new Set(socks.map((s) => `socket:[${s.inode}]`))
    for (const pid of readdirSync(procRoot)) {
      if (!/^\d+$/.test(pid)) continue
      try {
        const cwd = realpathSync(join(procRoot, pid, 'cwd'))
        if (!inside(chatRoot, cwd)) continue
        for (const fd of readdirSync(join(procRoot, pid, 'fd'))) {
          try {
            const l = readlinkSync(join(procRoot, pid, 'fd', fd))
            if (want.has(l)) mine.add(l.slice(8, -1))
          } catch {
            /* closed meanwhile */
          }
        }
      } catch {
        /* another user's, or gone */
      }
    }
  } catch {
    /* no process list */
  }
  const seen = new Map<number, PhonePorts['ports'][number]>()
  for (const s of socks) {
    const cur = seen.get(s.port)
    const chat = mine.has(s.inode)
    if (!cur) seen.set(s.port, { port: s.port, chat, address: s.address === 'all' ? 'all' : s.address === 'loopback' ? 'loopback' : 'other' })
    else if (chat) cur.chat = true
  }
  return [...seen.values()].sort((a, b) => Number(b.chat) - Number(a.chat) || a.port - b.port)
}

// ---------- the module ----------

export function createPhoneTools(d: PhoneToolsDeps) {
  const { ctx } = d
  const procRoot = d.procRoot === undefined ? (process.platform === 'linux' ? '/proc' : null) : d.procRoot
  const key = randomBytes(32)

  const ws = (id: string): ChatWorkspace => {
    if (!d.chats.get(id)) throw new ApiError('not_found', 'That chat is not on your cloud.')
    const w = d.workspace(id)
    if (!w) throw new ApiError('not_found', 'This chat has no folder yet. It gets one when it starts.')
    return w
  }

  const portsOf = (w: ChatWorkspace): PhonePorts['ports'] | null => listeningPorts(procRoot, w.user?.uid ?? process.getuid?.() ?? 0, w.root, d.ownPort())

  // ---------- preview ----------

  const sign = (dev: string, chat: string, port: number, exp: number): string => createHmac('sha256', key).update(`preview|${dev}|${chat}|${port}|${exp}`).digest('hex').slice(0, 32)

  function checkPort(port: number, w: ChatWorkspace | null): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ApiError('bad_request', 'A preview is for a port from 1024 to 65535.')
    if (port === d.ownPort()) throw new ApiError('bad_request', 'That port is your cloud itself.')
    if (!w) return
    const listening = portsOf(w)
    if (listening && !listening.some((p) => p.port === port)) throw new ApiError('not_found', `Nothing in your cloud listens on port ${port}. Start the server first.`)
  }

  /** an authenticated call: a link to the preview, good for PREVIEW_TTL_MS, for this phone only */
  function previewLink(dev: { id: string }, chatId: string, port: number): { url: string; expiresAt: string } {
    const w = ws(chatId)
    checkPort(port, w)
    const exp = Math.floor((ctx.now().getTime() + PREVIEW_TTL_MS) / 1000)
    const base = ctx.config.publicUrl.replace(/\/+$/, '')
    return { url: `${base}/preview/${chatId}/${port}/${dev.id}.${exp}.${sign(dev.id, chatId, port, exp)}/`, expiresAt: new Date(exp * 1000).toISOString() }
  }

  /** a preview path -> where it goes, or an error in plain words (never which part was wrong) */
  function previewTarget(pathname: string): { chatId: string; port: number; prefix: string; rest: string } | { error: number; message: string } {
    const m = PREVIEW_RE.exec(pathname)
    if (!m) return { error: 404, message: 'This preview link is not valid. Open it again from the chat on your phone.' }
    const [, chatId, portS, tok, rest] = m
    const port = Number(portS)
    const [dev, expS, sig] = tok!.split('.') as [string, string, string]
    const exp = Number(expS)
    const want = Buffer.from(sign(dev, chatId!, port, exp))
    const fail = { error: 403, message: 'This preview link has expired. Open it again from the chat on your phone.' }
    if (!timingSafeEqual(want, Buffer.from(sig)) || exp * 1000 < ctx.now().getTime()) return fail
    // a revoked phone's links stop with it
    if (!ctx.db.get("SELECT id FROM devices WHERE id = ? AND platform = 'phone' AND revoked_at IS NULL", dev)) return fail
    if (!d.chats.get(chatId!)) return { error: 404, message: 'That chat is not on your cloud.' }
    if (port < 1024 || port > 65535 || port === d.ownPort()) return { error: 400, message: 'That port can not be previewed.' }
    return { chatId: chatId!, port, prefix: `/preview/${chatId}/${port}/${tok}`, rest: rest || '/' }
  }

  const fwdHeaders = (h: IncomingHttpHeaders, port: number): OutgoingHttpHeaders => {
    const out: OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k) && !k.startsWith('x-forwarded-') && k !== 'x-real-ip' && k !== 'forwarded') out[k] = v
    // dev servers check Host (Vite's allowedHosts): it is theirs
    out.host = `localhost:${port}`
    return out
  }

  /** true when the request was a preview (answered here) */
  function preview(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith('/preview/')) return false
    const t = previewTarget(url.pathname)
    if ('error' in t) {
      res.writeHead(t.error, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(t.message)
      return true
    }
    d.touched()
    const cors = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }
    // the page is an opaque origin: its own calls back are cross-origin, so their preflights are answered here
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': String(req.headers['access-control-request-method']).slice(0, 200), 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '').slice(0, 1000), 'access-control-max-age': '600' })
      res.end()
      return true
    }
    const up = httpRequest({ host: '127.0.0.1', port: t.port, method: req.method, path: t.rest + url.search, headers: fwdHeaders(req.headers, t.port) }, (r) => {
      const h: OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(r.headers)) {
        if (v === undefined || HOP.has(k) || k === 'set-cookie' || k.startsWith('access-control-') || k === 'cross-origin-resource-policy' || k === 'service-worker-allowed' || k === 'clear-site-data') continue
        h[k] = v
      }
      // a redirect inside the server stays inside the preview
      const loc = typeof r.headers.location === 'string' ? r.headers.location : null
      if (loc) {
        const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(\/.*)?$/i.exec(loc)
        if (local) h.location = t.prefix + (local[1] ?? '/')
        else if (loc.startsWith('/') && !loc.startsWith('//')) h.location = t.prefix + loc
      }
      const csp = r.headers['content-security-policy']
      // two policies (theirs, then ours), both enforced: theirs can only narrow it further
      h['content-security-policy'] = csp ? `${csp}, ${PREVIEW_CSP}` : PREVIEW_CSP
      h['x-content-type-options'] = 'nosniff'
      h['referrer-policy'] = 'no-referrer'
      Object.assign(h, cors)
      res.writeHead(r.statusCode ?? 502, h)
      r.pipe(res)
    })
    up.setTimeout(120_000, () => up.destroy(new Error('timeout')))
    up.on('error', () => {
      if (res.headersSent) return void res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...cors })
      res.end(`Nothing answers on port ${t.port} in your cloud. Is the server still running?`)
    })
    req.pipe(up)
    return true
  }

  /** a WebSocket to a preview (a dev server's live reload): piped to 127.0.0.1:<port> */
  function previewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname: string
    let search: string
    try {
      const u = new URL(req.url ?? '/', 'http://cloud.local')
      pathname = u.pathname
      search = u.search
    } catch {
      return void socket.destroy()
    }
    const t = previewTarget(pathname)
    if ('error' in t) {
      socket.write(`HTTP/1.1 ${t.error} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return void socket.destroy()
    }
    d.touched()
    const up = connect(t.port, '127.0.0.1', () => {
      const h = fwdHeaders(req.headers, t.port)
      h.connection = 'Upgrade'
      h.upgrade = req.headers.upgrade ?? 'websocket'
      const lines = [`${req.method ?? 'GET'} ${t.rest}${search} HTTP/1.1`]
      for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && !/[\r\n]/.test(String(x))) lines.push(`${k}: ${x}`)
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const end = (): void => {
      up.destroy()
      socket.destroy()
    }
    up.on('error', end)
    socket.on('error', end)
    up.on('close', end)
    socket.on('close', end)
  }

  // ---------- the shell ----------

  interface Shell { chatId: string; child: ReturnType<typeof spawn>; buf: string; socks: Set<WebSocket>; grace: NodeJS.Timeout | null; cwd: string; ended: boolean }
  const shells = new Map<string, Shell>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const tell = (s: WebSocket, m: PhoneShellServerMsg): void => {
    if (s.readyState === s.OPEN) s.send(JSON.stringify(m))
  }
  const put = (sh: Shell, text: string): void => {
    if (!text) return
    sh.buf += text
    if (sh.buf.length > SHELL_KEEP_CHARS) sh.buf = sh.buf.slice(sh.buf.indexOf('\n', sh.buf.length - SHELL_KEEP_CHARS) + 1)
    for (const s of sh.socks) tell(s, { t: 'out', text })
  }
  const killShell = (sh: Shell): void => {
    if (sh.ended) return
    try {
      process.kill(-sh.child.pid!, 'SIGKILL')
    } catch {
      sh.child.kill('SIGKILL')
    }
  }
  const watchGrace = (sh: Shell): void => {
    if (sh.grace) clearTimeout(sh.grace)
    sh.grace = null
    if (sh.socks.size) return
    sh.grace = setTimeout(() => killShell(sh), d.shellGraceMs ?? SHELL_GRACE_MS)
    sh.grace.unref?.()
  }

  function openShell(chatId: string): Shell {
    const cur = shells.get(chatId)
    if (cur && !cur.ended) return cur
    const w = ws(chatId)
    const child = spawn(d.shell ?? '/bin/bash', ['--noprofile', '--norc'], { cwd: w.cwd, env: { ...w.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', PS1: '' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...(w.user ? { uid: w.user.uid, gid: w.user.gid } : {}) })
    const sh: Shell = { chatId, child, buf: '', socks: new Set(), grace: null, cwd: w.cwd, ended: false }
    shells.set(chatId, sh)
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    const onOut = (t: string): void => put(sh, ctx.redact(t.replace(ANSI, (c) => (c === '\n' || c === '\t' ? c : ''))))
    child.stdout!.on('data', onOut)
    child.stderr!.on('data', onOut)
    child.stdin!.on('error', () => undefined)
    child.on('error', (e) => put(sh, `The shell could not start: ${e.message}\n`))
    child.on('close', (code) => {
      sh.ended = true
      if (sh.grace) clearTimeout(sh.grace)
      for (const s of sh.socks) tell(s, { t: 'exit', code })
      if (shells.get(chatId) === sh) shells.delete(chatId)
    })
    // Ctrl-C stops the command running in front, not the shell (a trapped signal resets to default in its children)
    child.stdin!.write(`trap 'printf "^C\\n"' INT\n`)
    put(sh, `Shell in ${relOf(w.root, w.cwd) || 'the chat\'s folder'}. Each line runs as you send it.\n`)
    return sh
  }

  function shellUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (sock) => {
      let dev: { id: string } | null = null
      let sh: Shell | null = null
      const authWait = setTimeout(() => dev || sock.close(4401, 'Who are you?'), REMOTE_WS_AUTH_MS)
      sock.on('error', () => undefined)
      sock.on('message', (raw) => {
        let m: PhoneShellClientMsg
        try {
          m = JSON.parse(String(raw)) as PhoneShellClientMsg
        } catch {
          return
        }
        if (!dev) {
          dev = m.t === 'auth' ? d.device(m.token) : null
          if (!dev) return sock.close(4401, 'Pair this phone again.')
          clearTimeout(authWait)
          return tell(sock, { t: 'hello' })
        }
        if (m.t === 'ping') return tell(sock, { t: 'pong' })
        if (m.t === 'open') {
          try {
            if (sh) {
              sh.socks.delete(sock)
              watchGrace(sh)
            }
            sh = openShell(String(m.sessionId))
            sh.socks.add(sock)
            watchGrace(sh)
            d.touched()
            return tell(sock, { t: 'ready', sessionId: sh.chatId, text: sh.buf })
          } catch (e) {
            return tell(sock, { t: 'error', message: e instanceof ApiError ? e.message : 'The shell could not start.' })
          }
        }
        if (!sh || sh.ended) return tell(sock, { t: 'error', message: 'The shell ended. Open it again.' })
        if (m.t === 'line') {
          const line = String(m.text ?? '').replace(/[\r\n]+/g, ' ').slice(0, SHELL_LINE_MAX)
          put(sh, `$ ${line}\n`)
          sh.child.stdin!.write(`${line}\n`)
          d.touched()
        } else if (m.t === 'int') {
          try {
            process.kill(-sh.child.pid!, 'SIGINT')
          } catch {
            /* gone */
          }
        }
      })
      sock.on('close', () => {
        clearTimeout(authWait)
        if (sh) {
          sh.socks.delete(sock)
          watchGrace(sh)
        }
      })
    })
  }

  return {
    files: (chatId: string, path: unknown): PhoneDir => listDir(ws(chatId), path),
    file: (chatId: string, path: unknown): PhoneFile => readText(ws(chatId), path),
    changes: (chatId: string): Promise<PhoneChanges> => changesOf(ws(chatId)),
    ports: (chatId: string): PhonePorts => {
      const list = portsOf(ws(chatId))
      return { known: list !== null, ports: list ?? [] }
    },
    previewLink,
    preview,
    previewUpgrade,
    shellUpgrade,
    /** shells running: a machine never sleeps under one */
    shells: (): number => [...shells.values()].filter((s) => !s.ended).length,
    close(): void {
      for (const sh of shells.values()) killShell(sh)
      wss.close()
    }
  }
}
export type PhoneTools = ReturnType<typeof createPhoneTools>
