import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const OUTPUT_CAP = 50 * 1024
export const FEEDBACK_TAIL = 8 * 1024

export const uuid = (): string => randomUUID()

/** Keeps the LAST `max` bytes-ish (chars) of text. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/** Keeps the first `max` chars, with a marker when truncated. */
export function cap(text: string, max = OUTPUT_CAP): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

/** Resolves a bare command name against a PATH string (like `which`). Absolute paths are checked as-is. */
export function which(bin: string, pathVar: string | undefined): string | null {
  const isExec = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK)
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (isAbsolute(bin)) return isExec(bin) ? bin : null
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, bin)
    if (isExec(p)) return p
  }
  return null
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Splits a stream into complete lines; `flush()` returns the trailing partial line. */
export class LineBuffer {
  private buf = ''
  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split('\n')
    this.buf = parts.pop() ?? ''
    return parts
  }
  flush(): string | null {
    const rest = this.buf
    this.buf = ''
    return rest.length ? rest : null
  }
}

/** settings.concurrency as a limit: 1..16 if the founder set one, else (0, the default) no limit. */
export const concurrencyLimit = (setting: unknown): number => {
  const c = Number(setting)
  return Number.isFinite(c) && c >= 1 ? Math.min(16, c) : Infinity
}

/** Counting semaphore with a dynamic limit (settings.concurrency can change at runtime; Infinity = no limit). */
export class Semaphore {
  private active = 0
  private waiters: (() => void)[] = []
  constructor(private limit: () => number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= Math.max(1, this.limit())) await new Promise<void>((r) => this.waiters.push(r))
    else this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.active--
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
