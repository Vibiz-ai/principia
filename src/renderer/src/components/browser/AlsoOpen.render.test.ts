import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AlsoOpen } from './AlsoOpen'

describe('the panel\'s "Also open" row', () => {
  it('says whose tabs they are and what is open', () => {
    const html = renderToStaticMarkup(createElement(AlsoOpen, { scopes: [{ scope: 'task:t1', label: 'PR-92', title: 'Verify your email', tabs: 2 }], onPick: vi.fn() }))
    expect(html).toContain('Also open')
    expect(html).toContain('PR-92')
    expect(html).toContain('Verify your email')
    expect(html).toContain('and 1 more')
  })

  it('takes no room when nothing else is open', () => {
    expect(renderToStaticMarkup(createElement(AlsoOpen, { scopes: [], onPick: vi.fn() }))).toBe('')
  })
})
