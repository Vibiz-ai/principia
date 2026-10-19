/** Pure .env parsing for the Keys vault import (SPEC 9.4). Comments/blank lines ignored, `export ` and quotes stripped. */
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface ParsedEnvLine {
  name: string
  value: string
  valid: boolean
  error: string | null
}

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1)
  // unquoted: strip trailing " # comment"
  const hash = v.search(/\s#/)
  return (hash >= 0 ? v.slice(0, hash) : v).trim()
}

export function parseEnvText(text: string): ParsedEnvLine[] {
  const out = new Map<string, ParsedEnvLine>()
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const name = line.slice(0, eq).trim()
    let rawValue = line.slice(eq + 1)
    // multi-line double-quoted value
    const t = rawValue.trim()
    if (t.startsWith('"') && !(t.length >= 2 && t.endsWith('"'))) {
      while (i + 1 < lines.length) {
        i++
        rawValue += `\n${lines[i]}`
        if (lines[i].trimEnd().endsWith('"')) break
      }
    }
    const value = unquote(rawValue)
    let error: string | null = null
    if (!SECRET_NAME_RE.test(name)) error = 'Name must be UPPER_SNAKE_CASE (A-Z, 0-9, _)'
    else if (!value) error = 'Empty value'
    out.set(name, { name, value, valid: !error, error })
  }
  return [...out.values()]
}

/** "sk-…a1b2" style mask; never reveals more than the last 4 characters. */
export function maskSecret(value: string): string {
  const v = value.trim()
  if (v.length <= 8) return '••••'
  const prefix = /^[a-zA-Z]{1,4}[-_]/.exec(v)?.[0] ?? ''
  return `${prefix}…${v.slice(-4)}`
}
