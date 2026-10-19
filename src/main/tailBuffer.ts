/** Bounded in-memory tail of terminal output (attach replay). Measured in UTF-16 code units (~bytes for ASCII). */
export class TailBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private readonly max: number) {}
  append(s: string): void {
    if (!s) return
    this.chunks.push(s)
    this.size += s.length
    if (this.size > this.max * 1.5) this.compact()
  }
  private compact(): void {
    let joined = this.chunks.join('')
    if (joined.length > this.max) joined = trimToLineStart(joined.slice(joined.length - this.max))
    this.chunks = [joined]
    this.size = joined.length
  }
  toString(): string {
    this.compact()
    return this.chunks[0] ?? ''
  }
  get length(): number {
    return this.size
  }
}

/** After cutting mid-stream, drop the partial first line so replay does not start inside an escape sequence. */
export function trimToLineStart(s: string): string {
  const nl = s.indexOf('\n')
  return nl >= 0 && nl < 4096 ? s.slice(nl + 1) : s
}
