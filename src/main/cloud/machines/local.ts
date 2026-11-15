/** docs/MACHINES.md: what making a machine needs from this Mac itself: its SSH key, and ssh. No Electron. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** This Mac's SSH public key, the first of the usual names. */
export function sshPublicKey(home = os.homedir()): string | null {
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    try {
      const k = fs.readFileSync(path.join(home, '.ssh', name), 'utf8').trim()
      if (/^(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa) [A-Za-z0-9+/=]+/.test(k)) return k
    } catch {
      /* not there */
    }
  }
  return null
}

/** Runs the bootstrap as root over SSH (BatchMode: the Mac's own keys and agent; new hosts are trusted on first use). */
export const runSsh = (t: { host: string; user: string; port: number }, script: string, line: (l: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; tail: string }> =>
  new Promise((resolve) => {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-p', String(t.port), `${t.user}@${t.host}`, t.user === 'root' ? 'bash -s' : 'sudo -n bash -s']
    const p = spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let tail = ''
    let buf = ''
    const take = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) {
        tail = `${tail}\n${l}`.slice(-2000)
        line(l)
      }
    }
    p.stdout.on('data', take)
    p.stderr.on('data', take)
    const timer = setTimeout(() => p.kill('SIGTERM'), 45 * 60_000)
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, tail: e.message })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, tail: tail.trim().split('\n').slice(-4).join(' ') })
    })
    p.stdin.end(script)
  })
