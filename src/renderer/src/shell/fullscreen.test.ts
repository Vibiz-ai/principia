import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = ['app.css', 'shell.css', 'rail.css']
  .map((f) => readFileSync(join(__dirname, '../styles', f), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('full screen top bands', () => {
  it('collapses the empty traffic-light bands to 12px', () => {
    expect(css).toMatch(/:root\.is-fullscreen \.sidebar__drag \{ height: 12px; \}/)
    expect(css).toMatch(/:root\.is-fullscreen \.rail__drag \{ height: 12px; \}/)
  })

  it('lets the sidebar band grow when it holds the company switcher, so it is not clipped', () => {
    const rule = css.match(/:root\.is-fullscreen \.sidebar__drag\.has-switcher \{([^}]*)\}/)
    expect(rule?.[1]).toMatch(/height: auto/)
  })

  it('marks the band with has-switcher whenever the switcher renders', () => {
    const tsx = readFileSync(join(__dirname, 'Sidebar.tsx'), 'utf8')
    // five doors: the company header sits in the band whenever the rail does (focused and All companies)
    expect(tsx).toMatch(/sidebar__drag drag \$\{multi \? 'has-rail has-switcher' : ''\}`\}>\{multi && <CompanyHeader/)
  })
})
