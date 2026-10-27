/**
 * BROWSER.md §5: what the company browser may open, which permissions a page gets, and how downloads land. Pure.
 */
import path from 'node:path'

export interface OriginGuard {
  /** origins of Principia itself (the window's renderer, its localhost servers): never reachable from the browser */
  blockedOrigins: () => readonly string[]
}

export type UrlVerdict = { ok: true; url: string } | { ok: false; reason: string }

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:'])
/** Sub-requests may also open web sockets. */
const REQUEST_SCHEMES = new Set([...ALLOWED_SCHEMES, 'ws:', 'wss:'])

/** A URL the company browser may load: a page (navigation, the default) or a request a page makes. */
export function checkUrl(raw: string, guard: OriginGuard, kind: 'navigation' | 'request' = 'navigation'): UrlVerdict {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'That is not a web address.' }
  }
  if (!(kind === 'request' ? REQUEST_SCHEMES : ALLOWED_SCHEMES).has(u.protocol)) return { ok: false, reason: `${u.protocol.replace(':', '')}: addresses are blocked in the company browser (files and app pages stay private).` }
  if (u.protocol === 'about:' && u.href !== 'about:blank') return { ok: false, reason: 'Only about:blank is allowed.' }
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') {
    const origin = normOrigin(u)
    if (guard.blockedOrigins().some((o) => sameOrigin(o, origin))) return { ok: false, reason: "That address is Principia's own and is blocked in the company browser." }
  }
  return { ok: true, url: u.href }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'])
function normOrigin(u: URL): string {
  const host = LOOPBACK.has(u.hostname) ? 'loopback' : u.hostname.toLowerCase()
  const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80')
  const scheme = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
  return `${scheme}//${host}:${port}`
}
function sameOrigin(blocked: string, origin: string): boolean {
  try {
    const b = new URL(blocked)
    const bo = normOrigin(b)
    // a loopback port is Principia's whatever the scheme (http and ws of the same server)
    if (bo.includes('//loopback:')) return origin.endsWith(`//loopback:${b.port || (b.protocol === 'https:' ? '443' : '80')}`)
    return bo === origin
  } catch {
    return false
  }
}

/** Page permissions granted without asking: everything else is denied (camera, microphone, location, notifications…). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])
export const permissionAllowed = (permission: string): boolean => ALLOWED_PERMISSIONS.has(permission)

/** Downloads above this are cancelled. */
export const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024
/** Files that can run code on the Mac: the founder confirms each one. */
const EXECUTABLE = new Set([
  'app', 'dmg', 'pkg', 'mpkg', 'command', 'sh', 'bash', 'zsh', 'csh', 'tool', 'scpt', 'applescript', 'workflow', 'action', 'terminal', 'jar', 'exe', 'msi', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'py', 'pl', 'rb', 'js', 'mjs', 'cjs', 'jsx', 'php', 'bin', 'run', 'out', 'dylib', 'so', 'kext', 'plugin', 'prefpane', 'webloc', 'inetloc', 'fileloc', 'shortcut', 'scr', 'deb', 'rpm', 'apk', 'appimage', 'iso'
])
export function isExecutableName(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase()
  return !!ext && EXECUTABLE.has(ext)
}

/** A safe file name for the company's Downloads folder (no folders, no dot files, no control characters). */
export function safeDownloadName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f:/]+/g, '_').replace(/^\.+/, '').trim()
  return (base || 'download').slice(0, 180)
}

/** `report.pdf` → `report (2).pdf` while the name is taken. */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean): string {
  let p = path.join(dir, name)
  if (!exists(p)) return p
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; i < 1000; i++) {
    p = path.join(dir, `${stem} (${i})${ext}`)
    if (!exists(p)) return p
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

/** Partition of one company's browser: its own cookies, storage, cache and permissions. */
export const partitionFor = (companyId: string): string => `persist:company-${companyId.replace(/[^A-Za-z0-9_-]/g, '_')}`
