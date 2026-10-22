import fs from 'node:fs'
import crypto from 'node:crypto'

/** Open once and validate that descriptor, avoiding lstat/read symlink races. */
export function readPrivateJson(file: string, limit: number): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid gateway message')
    // Read at most limit + 1 bytes even if the peer grows the file after fstat.
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!n) break
      offset += n
    }
    if (offset > limit) throw new Error('Gateway message too large')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally { fs.closeSync(fd) }
}

/**
 * A peer cannot preplant a predictable temporary symlink to redirect writes. `owner` (Principia Cloud, CLOUD.md §7.8):
 * the file belongs to that user before it appears under its name, so a bridge running as the agent can read it.
 */
export function writePrivateJson(file: string, value: unknown, owner?: { uid: number; gid: number } | null): void {
  const temp = `${file}.${crypto.randomBytes(16).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    if (owner) fs.fchownSync(fd, owner.uid, owner.gid)
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch {}
  }
}
