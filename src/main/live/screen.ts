/**
 * REMOTE.md: what a terminal shows, as plain lines, from the tail of its PTY output. A TUI (Codex, Claude Code) draws
 * by moving the cursor, so stripping the escapes leaves words scattered one per line; this replays the few moves that
 * place text (cursor position, up/down/left/right, column, erase line/screen, carriage return, line feed, the
 * alternate screen) onto a grid and reads the grid back. Colours, modes and everything else are skipped. Pure.
 */

const MAX_ROWS = 2000
const MAX_COLS = 500

export function renderScreen(raw: string, maxLines = 60): string {
  let grid: string[][] = [[]]
  let r = 0
  let c = 0
  const row = (): string[] => {
    while (grid.length <= r) grid.push([])
    return grid[r]!
  }
  const clamp = (): void => {
    r = Math.max(0, Math.min(r, MAX_ROWS - 1))
    c = Math.max(0, Math.min(c, MAX_COLS - 1))
  }
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]!
    if (ch === '\x1b') {
      const next = raw[i + 1]
      if (next === '[') {
        const m = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(raw.slice(i, i + 64))
        if (!m) {
          i += 2
          continue
        }
        i += m[0].length
        const priv = m[1]!.startsWith('?')
        const ps = m[1]!.replace(/^[?>=<]/, '').split(';').map((x) => (x === '' ? NaN : Number(x)))
        const n = (k: number, d = 1): number => (Number.isFinite(ps[k]) && ps[k]! > 0 ? ps[k]! : d)
        switch (m[3]) {
          case 'H':
          case 'f':
            r = n(0) - 1
            c = n(1) - 1
            break
          case 'A':
            r -= n(0)
            break
          case 'B':
          case 'e':
            r += n(0)
            break
          case 'C':
          case 'a':
            c += n(0)
            break
          case 'D':
            c -= n(0)
            break
          case 'E':
            r += n(0)
            c = 0
            break
          case 'F':
            r -= n(0)
            c = 0
            break
          case 'G':
          case '`':
            c = n(0) - 1
            break
          case 'd':
            r = n(0) - 1
            break
          case 'J': {
            const mode = Number.isFinite(ps[0]) ? ps[0] : 0
            if (mode === 2 || mode === 3) grid = [[]]
            else if (mode === 0) {
              grid = grid.slice(0, r + 1)
              row().length = Math.min(row().length, c)
            } else for (let k = 0; k < r && k < grid.length; k++) grid[k] = []
            break
          }
          case 'K': {
            const mode = Number.isFinite(ps[0]) ? ps[0] : 0
            const line = row()
            if (mode === 2) grid[r] = []
            else if (mode === 1) for (let k = 0; k <= c && k < line.length; k++) line[k] = ' '
            else line.length = Math.min(line.length, c)
            break
          }
          case 'h':
          case 'l':
            // the alternate screen: a fresh page
            if (priv && (ps[0] === 1049 || ps[0] === 47 || ps[0] === 1047)) {
              grid = [[]]
              r = 0
              c = 0
            }
            break
          default:
            break
        }
        clamp()
        continue
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^') {
        // OSC / DCS / APC / PM: up to BEL or ST
        const end = raw.slice(i + 2).search(/\x07|\x1b\\/)
        i = end < 0 ? raw.length : i + 2 + end + (raw[i + 2 + end] === '\x07' ? 1 : 2)
        continue
      }
      if (next === 'c') grid = [[]]
      i += 2
      continue
    }
    i++
    if (ch === '\r') c = 0
    else if (ch === '\n') r++
    else if (ch === '\b') c = Math.max(0, c - 1)
    else if (ch === '\t') c = Math.min(MAX_COLS - 1, (Math.floor(c / 8) + 1) * 8)
    else if (ch >= ' ' && ch !== '\x7f') {
      const line = row()
      while (line.length < c) line.push(' ')
      line[c] = ch
      c++
    }
    clamp()
  }
  const lines = grid.map((l) => l.join('').replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  while (lines.length && !lines[0]) lines.shift()
  const out: string[] = []
  for (const l of lines) if (l || out[out.length - 1]) out.push(l)
  return out.slice(-maxLines).join('\n')
}
