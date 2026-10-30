import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })

describe('replies', () => {
  it('a **Next step:** line is drawn apart; other bold leads and mid-sentence mentions are not', async () => {
    const { MarkdownLite } = await import('./MarkdownLite')
    const html = renderToStaticMarkup(createElement(MarkdownLite, { text: 'Done.\n\n**Note:** nothing else changed.\n\nThe **next step:** is mine.\n\n**Next step:** merge PR #110.' }))
    expect(html.match(/dgm-md__next/g)).toHaveLength(1)
    expect(html).toContain('<p class="dgm-md__next"><strong><span>Next step:</span></strong><span> merge PR #110.</span></p>')
  })
})

describe('principia:// links in agent text', () => {
  it('a bare link becomes an in-app button in plain words; https stays a web link', async () => {
    const { MarkdownLite } = await import('./MarkdownLite')
    const html = renderToStaticMarkup(
      createElement(MarkdownLite, { text: 'Stripe is not connected yet. Connect it here: principia://connect/stripe (Settings > Connections). Docs: https://docs.stripe.com/mcp.' })
    )
    expect(html).toContain('class="dl-link"')
    expect(html).toContain('href="principia://connect/stripe"')
    expect(html).toContain('Connect Stripe')
    expect(html).toContain('href="https://docs.stripe.com/mcp"')
    expect(html).not.toContain('class="dl-link" href="https')
  })

  it('a labelled link keeps its label; an unknown principia:// link is plain text (opens nothing)', async () => {
    const { MarkdownLite } = await import('./MarkdownLite')
    const html = renderToStaticMarkup(createElement(MarkdownLite, { text: '[Add Instagram](principia://connect/instagram) and principia://delete/all' }))
    expect(html).toContain('>Add Instagram<')
    expect(html).not.toContain('href="principia://delete')
    expect(html).toContain('principia://delete/all')
  })

  it('Board text: links in a report become buttons, trailing punctuation stays text, previews read in plain words', async () => {
    const { TextWithLinks, plainLinks, splitDeepLinks } = await import('../DeepLinkButton')
    expect(splitDeepLinks('Connect it here: principia://connect/instagram?company=co_abc. Thanks')).toEqual([
      { t: 'text', v: 'Connect it here: ' }, { t: 'link', v: 'principia://connect/instagram?company=co_abc' }, { t: 'text', v: '. Thanks' }
    ])
    expect(plainLinks('connect Instagram: principia://connect/instagram?company=co_abc')).toBe('connect Instagram: Connect Instagram')
    expect(plainLinks('principia://approve/all')).toBe('principia://approve/all')
    const html = renderToStaticMarkup(createElement(TextWithLinks, { text: 'Report: principia://connect/stripe then principia://approve/all' }))
    expect(html).toContain('class="dl-link"')
    expect(html).toContain('Connect Stripe')
    expect(html).not.toContain('href="principia://approve')
  })

  it('the Forum tokenizer keeps a principia:// link whole', async () => {
    const { tokenize } = await import('../../lib/forum')
    expect(tokenize('see principia://board?task=NC-12.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'url', v: 'principia://board?task=NC-12' },
      { t: 'text', v: '.' }
    ])
  })
})
