import fs from 'node:fs'
import type { EngineLogger } from '../shared/engine'

const MAX_LOG_BYTES = 10 * 1024 * 1024

let stream: fs.WriteStream | null = null
let redactFn: (s: string) => string = (s) => s

/** Opens logs/main.log (rotated to main.log.1 when > 10 MB). Safe to call once at boot. */
export function initLog(file: string): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
  } catch {
    stream = null
  }
}

/** Secret redaction for everything we log (vault installs it once loaded). */
export function setLogRedactor(fn: (s: string) => string): void {
  redactFn = fn
}

function write(level: string, msg: string, meta?: Record<string, unknown>): void {
  let line = `${new Date().toISOString()} ${level} ${msg}`
  if (meta && Object.keys(meta).length) {
    try {
      line += ` ${JSON.stringify(meta)}`
    } catch {
      /* unserializable meta */
    }
  }
  line = redactFn(line)
  if (level === 'ERROR') console.error(line)
  else if (!process.env.VITEST) console.log(line)
  stream?.write(`${line}\n`)
}

export const log: EngineLogger = {
  info: (m, meta) => write('INFO', m, meta),
  warn: (m, meta) => write('WARN', m, meta),
  error: (m, meta) => write('ERROR', m, meta)
}

export function closeLog(): void {
  stream?.end()
  stream = null
}
