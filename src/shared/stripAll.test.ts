import { describe, expect, it } from 'vitest'
import { stripAll, stripTags } from './stripAll'

describe('stripAll / stripTags', () => {
  it('removes tags until none is left, so removing one cannot splice a new tag', () => {
    // `<[^>]+>` matches `<scr<b>` as one tag, so what is left has no `<` at all
    expect(stripTags('<scr<b>ipt>alert(1)</scr<i>ipt>')).toBe('ipt>alert(1)ipt>')
    expect(stripTags('<<b>script>x')).not.toMatch(/<script/i)
    expect(stripTags('<h1>Hello <em>there</em></h1>')).toBe('Hello there')
  })

  it('keeps text that only looks like a bracket', () => {
    expect(stripTags('a < b')).toBe('a < b')
    expect(stripTags('x > 1')).toBe('x > 1')
    expect(stripTags('')).toBe('')
  })

  it('removes nested html comments completely', () => {
    const re = /<!--[\s\S]*?-->/g
    expect(stripAll('a<!-<!-- x -->- y -->b', re)).not.toContain('<!--')
    expect(stripAll('keep <!-- drop --> this', re)).toBe('keep  this')
  })
})
