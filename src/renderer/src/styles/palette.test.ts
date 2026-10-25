/**
 * Palette guard (VOICE.md §5.1, §5.2): the renderer never ships the retired material theme. Walks every .ts, .tsx and
 * .css file under src/renderer/src (tests excluded, since they may name the banned values to assert their absence) and
 * fails on the banned hex list, the removed stone/bronze/gold tokens, the material classes and noise textures.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..')

/** VOICE §5.2 "Banned everywhere" */
const BANNED_HEX = [
  '#b0773a', '#d9a066', '#7a4d22', '#d4a84b', '#8a6a22', '#b5532f', '#e8dfcf', '#f3efe7',
  '#cdbfa5', '#a8987c', '#4a3a28', '#5c5040', '#6b5a44', '#1b1712', '#c08447', '#c56a45'
]

const RULES: readonly { name: string; re: RegExp }[] = [
  // a banned hex, alone or with an alpha pair (#c56a45cc), but not as the prefix of some other 7+ digit token
  { name: 'banned colour', re: new RegExp(`(?:${BANNED_HEX.join('|')})(?:[0-9a-f]{2})?(?![0-9a-f])`, 'i') },
  { name: 'removed material token', re: /--rm-(travertine|marble|bronze|terracotta|gold|carve|stage)\b/ },
  { name: 'material class', re: /\brm-(stone|marble|bronze|carved|gilt)\b/ },
  { name: 'noise texture', re: /feTurbulence/i }
]

/**
 * "and their kin" (§5.2): on the Roman surfaces any saturated colour literal in the brown/orange/ochre/mustard/beige
 * band fails too, not only the listed hexes. App chrome (tokens.css, provider colours, border-beam's own variants) is
 * out of scope here; amber reaches a Roman surface only through the --status-needs token, never as a literal.
 */
const ROMAN_SURFACE = /(^|\/)(components\/roman\/|views\/onboarding\/|styles\/(roman|onboarding|rail|portfolio)\.css$|components\/home\/MilestoneStrip\.tsx$|views\/PortfolioView\.tsx$|shell\/CompanyRail\.tsx$)/

function rgbOf(lit: string): [number, number, number] | null {
  const hex = lit.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  }
  const fn = lit.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null
}

function isWarm(lit: string): boolean {
  const rgb = rgbOf(lit)
  if (!rgb) return false
  const [r, g, b] = rgb.map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return false
  const l = (max + min) / 2
  const sat = d / (1 - Math.abs(2 * l - 1))
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue = (hue * 60 + 360) % 360
  return hue >= 10 && hue <= 65 && (sat >= 0.25 || (l > 0.75 && sat >= 0.12)) && l > 0.08 && l < 0.97
}

const LITERAL = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\./.test(entry)) out.push(p)
  }
  return out
}

interface Hit { file: string; line: number; rule: string; text: string }

function scan(files: readonly string[], read: (f: string) => string = (f) => readFileSync(f, 'utf8')): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    read(file)
      .split('\n')
      .forEach((text, i) => {
        for (const { name, re } of RULES) if (re.test(text)) hits.push({ file, line: i + 1, rule: name, text: text.trim().slice(0, 120) })
        if (ROMAN_SURFACE.test(file.split('\\').join('/')))
          for (const [lit] of text.matchAll(LITERAL)) if (isWarm(lit)) hits.push({ file, line: i + 1, rule: 'warm colour on a Roman surface', text: lit })
      })
  }
  return hits
}

describe('renderer palette guard', () => {
  const files = walk(ROOT)

  it('walks the renderer sources (and skips tests)', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith('roman.css'))).toBe(true)
    expect(files.some((f) => f.endsWith('PassportTablet.tsx'))).toBe(true)
    expect(files.some((f) => /\.test\./.test(f))).toBe(false)
  })

  it('has no banned colours, material tokens, material classes or noise textures', () => {
    const hits = scan(files)
    expect(hits.map((h) => `${relative(ROOT, h.file)}:${h.line} [${h.rule}] ${h.text}`)).toEqual([])
  })

  it('catches each kind of violation (the guard is not vacuous)', () => {
    const fake: Record<string, string> = {
      'a.css': '.x { color: #B0773A; }',
      'b.css': '.x { background: #c56a45cc; }',
      'c.css': '.x { fill: var(--rm-bronze-hi); }',
      'd.tsx': '<div className="rm-stone rm-pp" />',
      'e.css': ".x { background: url(\"data:image/svg+xml,<filter><feTurbulence/></filter>\") }",
      'f.css': '.x { background: var(--rm-stage); color: var(--rm-gold); }',
      'g.tsx': 'const t = "rm-gilt"',
      ok: '.x { color: #b0773; fill: var(--rm-px-blue); stroke: var(--rm-ln-1); } .rm-stoneware-free {}'
    }
    const hits = scan(Object.keys(fake), (f) => fake[f])
    const flagged = new Set(hits.map((h) => h.file))
    for (const f of ['a.css', 'b.css', 'c.css', 'd.tsx', 'e.css', 'f.css', 'g.tsx']) expect(flagged, f).toContain(f)
    expect(flagged).not.toContain('ok')
  })

  it('status tokens are cool: Needs you and warnings are never amber (QA: the sidebar NEEDS YOU and its badges)', () => {
    const tokens = readFileSync(join(ROOT, 'styles', 'tokens.css'), 'utf8')
    for (const name of ['--status-needs', '--status-needs-soft', '--status-warning', '--status-warning-soft']) {
      const lit = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim() ?? ''
      expect(lit, name).not.toBe('')
      expect(isWarm(lit), `${name}: ${lit}`).toBe(false)
    }
    // the copies of the old amber in other style sheets went with it
    const amber = /rgba\(\s*(245,\s*165,\s*36|240,\s*181,\s*74)\b|#f5a524|#f0b54a|#d8bc85/i
    expect(files.filter((f) => amber.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f))).toEqual([])
  })

  it('company colours (rail avatars, departments) are cool or neutral, never warm or pink (QA: a pink-red avatar)', () => {
    const tokens = readFileSync(join(ROOT, 'styles', 'tokens.css'), 'utf8')
    const company = readFileSync(join(ROOT, '..', '..', 'main', 'onboarding', 'launch.ts'), 'utf8')
    const palette = /COMPANY_PALETTE = \[([^\]]+)\]/.exec(company)![1].match(/--[a-z0-9-]+/g)!
    for (const name of new Set([...palette, '--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-other'])) {
      const lit = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)?.[1] ?? ''
      expect(lit, name).not.toBe('')
      const [r, g, b] = rgbOf(lit)!.map((v) => v / 255)
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      if (d < 0.08) continue // a grey
      let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      hue = (hue * 60 + 360) % 360
      expect(hue >= 90 && hue <= 290, `${name}: ${lit} (hue ${Math.round(hue)})`).toBe(true)
    }
  })

  it('flags unlisted warm kin (ochre, mustard, beige, terracotta) on Roman surfaces only', () => {
    const fake: Record<string, string> = {
      'components/roman/A.tsx': '<rect fill="#c9a227" />',
      'styles/onboarding.css': '.ob-cer { background: radial-gradient(#3a2a1a, rgba(217, 119, 87, .4)); }',
      'views/onboarding/Ceremony.tsx': "const bg = '#e1c699'",
      'styles/roman.css': '.x { fill: #4c9cff; stroke: rgba(255, 255, 255, .5); background: #141517; color: #f25c5c; }',
      'styles/tokens.css': '--provider-claude: #d97757;'
    }
    const flagged = new Set(scan(Object.keys(fake), (f) => fake[f]).map((h) => h.file))
    for (const f of ['components/roman/A.tsx', 'styles/onboarding.css', 'views/onboarding/Ceremony.tsx']) expect(flagged, f).toContain(f)
    expect(flagged).not.toContain('styles/roman.css')
    expect(flagged).not.toContain('styles/tokens.css')
    for (const cool of ['#4c9cff', '#3ecf8e', '#5a3a8a', '#e6e6e9', '#26272b', 'rgb(40, 140, 255)']) expect(isWarm(cool), cool).toBe(false)
  })
})
