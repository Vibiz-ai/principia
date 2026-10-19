/**
 * SLACK.md §2.5: the connector core is cloud-movable. It may import only itself and src/shared/**, never electron,
 * better-sqlite3, node:fs or node:child_process (zod is the one allowed package: wire validation).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CORE = path.join(__dirname, '../core')
const SHARED = path.resolve(__dirname, '../../../../shared')
const ALLOWED_PACKAGES = new Set(['zod'])

describe('14: connector core purity', () => {
  it('core/** imports nothing outside core/ and src/shared/** (no electron, sqlite, fs, child_process)', () => {
    const files = fs.readdirSync(CORE).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(8)
    const bad: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(path.join(CORE, f), 'utf8')
      for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3]
        if (spec.startsWith('.')) {
          const abs = path.resolve(CORE, spec)
          if (!abs.startsWith(CORE) && !abs.startsWith(SHARED)) bad.push(`${f}: ${spec}`)
        } else if (!ALLOWED_PACKAGES.has(spec)) bad.push(`${f}: ${spec}`)
      }
      if (/\bprocess\.env\b/.test(src)) bad.push(`${f}: process.env`)
    }
    expect(bad).toEqual([])
  })

  it('production transport has no base-URL override and guards the socket host', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../transport/node.ts'), 'utf8')
    expect(src).toMatch(/export const API_BASE = 'https:\/\/slack\.com\/api\/'/)
    expect(src).not.toMatch(/process\.env/)
    const { assertSlackSocketUrl } = await import('../transport/node')
    expect(() => assertSlackSocketUrl('wss://wss-primary.slack.com/link/?ticket=1')).not.toThrow()
    expect(() => assertSlackSocketUrl('wss://evil.example.com/')).toThrow(/slack\.com/)
    expect(() => assertSlackSocketUrl('ws://wss-primary.slack.com/')).toThrow()
    expect(() => assertSlackSocketUrl('wss://slack.com.evil.io/')).toThrow()
  })
})
