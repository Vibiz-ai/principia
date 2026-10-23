import { describe, expect, it } from 'vitest'
import type { RepoScanSummary, ScanSummary, SiteSummary } from './onboarding'
import { prefill, prefillWithSources, titleCase } from './onboardingPrefill'

const repo = (o: Partial<RepoScanSummary> = {}): RepoScanSummary => ({ source: 'local', label: 'acme-web', stack: [], ...o })
const scan = (...repos: RepoScanSummary[]): ScanSummary => ({ repos, stack: [] })
const site = (o: Partial<SiteSummary> = {}): SiteSummary => ({ url: 'https://sundaybakery.com/', fetchedAt: '2026-10-21T00:00:00Z', ...o })

describe('titleCase', () => {
  it.each([
    ['acme-web', 'Acme Web'],
    ['sunday_bakery', 'Sunday Bakery'],
    ['@acme/web-app', 'Web App'],
    ['my  repo', 'My Repo'],
    ['iOS-app', 'IOS App'],
    ['acme.git', 'Acme'],
    ['', '']
  ])('%s → %s', (raw, want) => expect(titleCase(raw)).toBe(want))
})

describe('prefill', () => {
  it('returns nothing for nothing', () => {
    expect(prefill()).toEqual({})
    expect(prefill(scan())).toEqual({})
  })

  it('name: package name, else folder, else GitHub repo, else the site', () => {
    expect(prefillWithSources(scan(repo({ packageName: 'sunday-bakery' }))).answers.name).toBe('Sunday Bakery')
    expect(prefillWithSources(scan(repo({ packageName: 'sunday-bakery' }))).sources.name).toBe('package')
    expect(prefillWithSources(scan(repo())).answers.name).toBe('Acme Web')
    expect(prefillWithSources(scan(repo())).sources.name).toBe('folder')
    const gh = prefillWithSources(scan(repo({ source: 'github', label: 'acme/shop_front', fullName: 'acme/shop_front' })))
    expect(gh.answers.name).toBe('Shop Front')
    expect(gh.sources.name).toBe('github')
    expect(prefill(null, site({ siteName: 'Sunday Bakery' })).name).toBe('Sunday Bakery')
    expect(prefill(null, site({ title: 'Sunday Bakery – Fresh sourdough' })).name).toBe('Sunday Bakery')
    expect(prefill(null, site({ title: 'Sunday Bakery | Lisbon' })).name).toBe('Sunday Bakery')
    // the repo wins over the site
    expect(prefill(scan(repo()), site({ siteName: 'Other' })).name).toBe('Acme Web')
  })

  it('oneLiner: description, else README line, else the site', () => {
    expect(prefill(scan(repo({ description: 'Sourdough for offices', readmeLine: 'A bakery app' }))).oneLiner).toBe('Sourdough for offices')
    const r = prefillWithSources(scan(repo({ readmeLine: 'A bakery app' })))
    expect(r.answers.oneLiner).toBe('A bakery app')
    expect(r.sources.oneLiner).toBe('readme')
    expect(prefillWithSources(null, site({ description: 'Fresh sourdough' })).sources.oneLiner).toBe('site')
    // a later repo's description is still found
    expect(prefill(scan(repo(), repo({ label: 'b', description: 'From B' }))).oneLiner).toBe('From B')
  })

  it('oneLiner is single-line and clipped to 200', () => {
    const v = prefill(scan(repo({ description: `Line one\nline two ${'word '.repeat(80)}` }))).oneLiner!
    expect(v.length).toBeLessThanOrEqual(200)
    expect(v).not.toContain('\n')
    expect(v.endsWith('…')).toBe(true)
  })

  it('siteUrl priority: homepage → CNAME → README link → site', () => {
    const all = repo({ homepage: 'https://acme.com', cname: 'www.acme.io', readmeLink: 'https://acme.dev' })
    expect(prefillWithSources(scan(all)).answers.siteUrl).toBe('https://acme.com')
    expect(prefillWithSources(scan(repo({ cname: 'www.acme.io', readmeLink: 'https://acme.dev' }))).answers).toMatchObject({ siteUrl: 'https://www.acme.io' })
    expect(prefillWithSources(scan(repo({ cname: 'www.acme.io' }))).sources.siteUrl).toBe('cname')
    expect(prefillWithSources(scan(repo({ readmeLink: 'https://acme.dev' }))).sources.siteUrl).toBe('readme')
    expect(prefill(scan(repo()), site()).siteUrl).toBe('https://sundaybakery.com/')
    expect(prefill(scan(repo({ homepage: 'https://acme.com' })), site()).siteUrl).toBe('https://acme.com')
  })

  it('siteUrl skips repo hosts, badges, registries and junk', () => {
    expect(prefill(scan(repo({ homepage: 'https://github.com/acme/web#readme' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ readmeLink: 'https://img.shields.io/badge/x' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ readmeLink: 'https://www.npmjs.com/package/x' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ readmeLink: 'http://acme.com' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ homepage: 'not a url' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ homepage: 'http://127.0.0.1:3000' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ cname: 'bad host!' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ homepage: 'https://user:tok@acme.com' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ homepage: 'https://evil.com\\@acme.com' }))).siteUrl).toBeUndefined()
    expect(prefill(scan(repo({ homepage: 'https://github.com/x', readmeLink: 'https://acme.shop' }))).siteUrl).toBe('https://acme.shop')
  })

  it('products: the site description when it differs from the one-liner, else the repo description', () => {
    expect(prefill(scan(repo({ description: 'Sourdough for offices' }))).products).toBe('Sourdough for offices')
    const both = prefillWithSources(scan(repo({ description: 'Sourdough for offices' })), site({ description: 'Loaves, pastries and coffee' }))
    expect(both.answers).toMatchObject({ oneLiner: 'Sourdough for offices', products: 'Loaves, pastries and coffee' })
    expect(both.sources.products).toBe('site')
    expect(prefill(null, site({ description: 'Fresh sourdough' })).products).toBeUndefined()
    expect(prefill(scan(repo({ readmeLine: 'Only a readme' }))).products).toBeUndefined()
  })

  it('every field fits the answers schema', () => {
    const long = 'x'.repeat(5000)
    const p = prefill(scan(repo({ packageName: long, description: long })), site({ siteName: long, description: long }))
    expect(p.name!.length).toBeLessThanOrEqual(80)
    expect(p.oneLiner!.length).toBeLessThanOrEqual(200)
    expect(p.products!.length).toBeLessThanOrEqual(500)
  })
})
