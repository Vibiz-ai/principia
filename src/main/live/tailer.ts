/**
 * JSONL tailer for <liveDir>/events.jsonl (docs/LIVE.md §5). fs.watch on the file plus a 500 ms poll fallback.
 * Reads from the saved byte offset, keeps a partial last line until the next read, skips blank lines, drops (and logs
 * once) non-JSON lines. No Electron imports.
 */
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

export interface TailerOptions {
  pollMs?: number
  onLine(line: unknown): void
  onBadLine?(text: string): void
}

export class JsonlTailer {
  private offset = 0
  private partial = ''
  private watcher: fs.FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private warned = false
  private reading = false
  private decoder = new StringDecoder('utf8')

  constructor(
    readonly file: string,
    private opts: TailerOptions
  ) {}

  start(): void {
    this.attachWatcher()
    this.timer = setInterval(() => this.read(), this.opts.pollMs ?? 500)
    this.timer.unref?.()
    this.read()
  }

  private attachWatcher(): void {
    if (this.watcher || this.closed) return
    try {
      this.watcher = fs.watch(this.file, { persistent: false }, () => this.read())
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      this.watcher = null // file not created yet: the poll picks it up and retries the watch
    }
  }

  /** Reads whatever was appended since the last read. Sync; safe to call any time. */
  read(): void {
    if (this.closed || this.reading) return
    this.reading = true
    try {
      let fd: number
      try {
        fd = fs.openSync(this.file, 'r')
      } catch {
        return
      }
      try {
        const size = fs.fstatSync(fd).size
        if (size < this.offset) {
          // truncated / replaced: start over
          this.offset = 0
          this.partial = ''
          this.decoder = new StringDecoder('utf8')
        }
        if (size === this.offset) return
        const buf = Buffer.alloc(size - this.offset)
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset)
        this.offset += n
        this.consume(this.decoder.write(buf.subarray(0, n)))
      } finally {
        fs.closeSync(fd)
      }
      if (!this.watcher) this.attachWatcher()
    } finally {
      this.reading = false
    }
  }

  private consume(text: string): void {
    const all = this.partial + text
    const lines = all.split('\n')
    this.partial = lines.pop() ?? ''
    for (const raw of lines) {
      const t = raw.trim()
      if (!t) continue
      let v: unknown
      try {
        v = JSON.parse(t)
      } catch {
        if (!this.warned) {
          this.warned = true
          this.opts.onBadLine?.(t.slice(0, 200))
        }
        continue
      }
      try {
        this.opts.onLine(v)
      } catch {
        /* a consumer error never stops the tail */
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.read()
    this.closed = true
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
