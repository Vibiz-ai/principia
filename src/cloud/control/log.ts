/** Process logs (CLOUD.md §9): JSON lines on stdout, redacted at the sink. Request bodies are never logged. */

/** Token shapes redacted even when the value is unknown to the vault (CLOUD.md §7.3). */
export const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:pdt|pll|pss|whk|opk|prt)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g
]

export type Redactor = (text: string) => string

export function createRedactor(secrets: () => string[]): Redactor {
  return text => {
    let out = text
    const list = secrets().filter(s => s.length >= 8).sort((a, b) => b.length - a.length)
    for (const s of list) if (out.includes(s)) out = out.split(s).join('[redacted]')
    for (const p of TOKEN_PATTERNS) out = out.replace(p, '[redacted]')
    return out
  }
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  /** a human line (not JSON), still redacted: the connect link a person must read */
  plain(line: string): void
}

export function createLogger(redact: Redactor, write: (line: string) => void = l => process.stdout.write(l + '\n'), now: () => Date = () => new Date()): Logger {
  const emit = (level: string, msg: string, meta?: Record<string, unknown>) => {
    let line: string
    try { line = JSON.stringify({ level, msg, at: now().toISOString(), ...meta }) } catch { line = JSON.stringify({ level, msg, at: now().toISOString() }) }
    write(redact(line))
  }
  return { info: (m, meta) => emit('info', m, meta), warn: (m, meta) => emit('warn', m, meta), error: (m, meta) => emit('error', m, meta), plain: line => write(redact(line)) }
}
