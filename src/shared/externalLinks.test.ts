import { describe, expect, it } from 'vitest'
import { isWebLink } from './externalLinks'

describe('browser links', () => {
  it.each(['http://127.0.0.1:3344/paid-opportunities.html', 'http://localhost:3000', 'http://[::1]:8080', 'https://example.com/report'])('opens web URL %s', (url) => {
    expect(isWebLink(url)).toBe(true)
  })
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'vscode://file/test', 'not a url'])('rejects non-web URL %s', (url) => {
    expect(isWebLink(url)).toBe(false)
  })
})
