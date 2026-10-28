/**
 * Repo metadata read straight from disk (no git binary): origin's URL with credentials stripped and the README's first
 * meaningful line. Used by Slack-started work (SLACK.md §11.4) and the onboarding scan (ONBOARDING.md). Never throws.
 * No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './pathGuard'
import { stripTags } from '../shared/stripAll'

export interface RepoMeta {
  remote: string | null
  readme: string | null
}

const README_NAMES = ['README.md', 'readme.md', 'README', 'README.txt', 'Readme.md']
const README_LINE_MAX = 200
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Removes credentials from a remote URL (https://user:token@host/... -> https://host/..., and any ?query / #fragment).
 * Any URL scheme, including compound ones like git+ssh:// and git+https://.
 */
export function cleanRemote(url: string): string {
  const noUser = url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/\s]+@/, '$1')
  // a query or fragment (`?access_token=…`) is never part of where the repo lives, and may carry a token
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(noUser) ? noUser.replace(/[?#].*$/, '') : noUser
}

/**
 * A git config value as git reads it: double-quoted parts unquoted (with \\ \" \n \t escapes), an unquoted `#` or `;`
 * starting a comment. A quoted `url = "https://user:token@host/..."` must not reach cleanRemote with its quote first.
 */
function gitConfigValue(raw: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i]
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n
    } else if (c === '"') quoted = !quoted
    else if (!quoted && (c === '#' || c === ';')) break
    else out += c
  }
  return out.trim()
}

/**
 * Up to `cap` bytes of `<root>/<rel>`, only when it resolves (through symlinks) to a regular file inside `root`. Opened
 * non-blocking and re-checked after the open, so a FIFO or device (or one swapped in after the stat) never hangs the
 * main process. null otherwise. Never throws.
 */
function readInside(root: string, rel: string, cap: number): string | null {
  let fd: number | null = null
  try {
    const real = fs.realpathSync(path.join(root, rel))
    if (!isInside(real, root) || !fs.statSync(real).isFile()) return null
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    if (!fs.fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(cap)
    const n = fs.readSync(fd, buf, 0, cap, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* closed */
      }
    }
  }
}

const CONFIG_CAP = 64 * 1024

/** origin's URL from .git/config and the README's first meaningful line. Never throws. */
export function fsRepoMeta(repoPath: string): RepoMeta {
  let root: string
  try {
    root = fs.realpathSync(repoPath)
  } catch {
    return { remote: null, readme: null }
  }
  let remote: string | null = null
  const cfg = readInside(root, path.join('.git', 'config'), CONFIG_CAP)
  if (cfg) {
    const sections = cfg.split(/^\[/m)
    const pick = sections.find((s) => /^remote "origin"\]/.test(s)) ?? sections.find((s) => /^remote "/.test(s))
    const m = pick ? /^\s*url\s*=\s*(.+)$/m.exec(pick) : null
    if (m) {
      const v = gitConfigValue(m[1])
      remote = v ? cleanRemote(v) : null
    }
  }
  let readme: string | null = null
  for (const name of README_NAMES) {
    const text = readInside(root, name, 4096)
    if (text === null) continue
    const line = text
      .split('\n')
      .map((l) => stripTags(l.replace(/^#+\s*/, '')).trim())
      .find((l) => l && /[\p{L}\p{N}]/u.test(l))
    if (line) {
      readme = cap(line, README_LINE_MAX)
      break
    }
  }
  return { remote, readme }
}
