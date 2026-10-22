/**
 * origin's URL from `<repo>/.git/config`, read the safe way for onboarding intake: the config must resolve (through any
 * symlinks) to a regular file inside the repo, and at most 64 KB is read. Unlike repoMeta.fsRepoMeta it never opens a
 * README, never blocks on a FIFO/device, and never reads a file outside the repo. Credentials are stripped.
 *
 * No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from '../pathGuard'
import { cleanRemote } from '../repoMeta'

const CONFIG_CAP = 64 * 1024

/** A git config value as git reads it: quotes removed (with \\ \" \n \t escapes), an unquoted `#`/`;` starts a comment. */
export function gitConfigValue(raw: string): string {
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

/** origin's (else the first remote's) URL from git config text, credentials stripped. Pure. */
export function originFromConfig(cfg: string): string | null {
  const sections = cfg.split(/^\s*\[/m)
  const pick = sections.find((s) => /^remote\s+"origin"\s*\]/.test(s)) ?? sections.find((s) => /^remote\s+"/.test(s))
  const m = pick ? /^\s*url\s*=\s*(.+)$/m.exec(pick) : null
  if (!m) return null
  const v = gitConfigValue(m[1])
  return v ? cleanRemote(v) : null
}

/** `root` must be a realpath. null when there is no readable regular `.git/config` inside the repo. Never throws. */
export function readOriginRemote(root: string): string | null {
  const p = path.join(root, '.git', 'config')
  let fd: number | null = null
  try {
    const real = fs.realpathSync(p)
    if (!isInside(real, root) || !fs.statSync(real).isFile()) return null
    // O_NONBLOCK: a file swapped for a FIFO between the stat and the open can't hang the main process
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    if (!fs.fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(CONFIG_CAP)
    const n = fs.readSync(fd, buf, 0, CONFIG_CAP, 0)
    return originFromConfig(buf.subarray(0, n).toString('utf8'))
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
