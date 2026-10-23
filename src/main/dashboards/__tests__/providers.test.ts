import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DashboardFetchError, codeForStatus, getJson, providerMessage, scrub, type HttpFn, type HttpReq } from '../http'
import { fixtureGeoEngines, fixtureHttp, SAMPLE_CONFIG } from '../fixtures'
import { gscProvider, gscTotals, homeUrl, parseServiceAccount, serviceAccountJwt } from '../providers/gsc'
import { aggregateGeo, appendTrend, firstMention, geoProvider, hostOf, scoreAnswer, GEO_TREND_MAX } from '../providers/geo'
import { ciSuccess, ghStatus, githubProvider, median, mergeHours, repoOf, weeklyMerged } from '../providers/github'
import { hostOf as analyticsHost, plausibleProvider, posthogProvider } from '../providers/analytics'
import type { ProviderCtx } from '../providers/types'

const NOW = new Date('2026-10-23T12:00:00Z')
const ctx = (over: Partial<ProviderCtx>): ProviderCtx => ({ http: fixtureHttp(() => NOW), keys: {}, config: {}, now: NOW, previous: null, ...over })
const status = (code: number, body: unknown = null): HttpFn => async () => ({ status: code, body, retryAfter: null })

describe('http', () => {
  it('maps statuses to fixed codes', () => {
    expect(codeForStatus(200)).toBeNull()
    expect(codeForStatus(401)).toBe('invalid_key')
    expect(codeForStatus(403)).toBe('forbidden')
    expect(codeForStatus(429)).toBe('rate_limited')
    expect(codeForStatus(404)).toBe('config')
    expect(codeForStatus(502)).toBe('unavailable')
  })

  it('scrubs secrets and token shapes from anything quoted', () => {
    const secret = 'pplx-supersecretvalue123'
    expect(scrub(`bad key ${secret}`, [secret])).toBe('bad key ••••')
    expect(scrub('Authorization: Bearer abc.def-ghi', [])).toBe('Authorization: Bearer ••••')
    expect(scrub('key rk_live_ABCdef123 failed', [])).toBe('key rk_live_•••• failed')
    expect(scrub('used ghp_abcdef0123', [])).toBe('used ghp_••••')
    expect(providerMessage({ error: { message: `nope ${secret}` } }, [secret])).toBe('nope ••••')
    expect(providerMessage({ error: 'invalid_grant', error_description: 'Invalid JWT' }, [])).toBe('Invalid JWT')
    expect(providerMessage(null, [])).toBeNull()
  })

  it('throws a DashboardFetchError whose message never carries the key', async () => {
    const key = 'phx_0123456789abcdef'
    const err = await getJson<Error>(status(401, { detail: `Invalid key ${key}` }), { url: 'https://x' }, { provider: 'PostHog', secrets: [key] }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(DashboardFetchError)
    expect(err.message).toMatch(/PostHog rejected the key/)
    expect(err.message).not.toContain(key)
  })
})

describe('Search Console', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const sa = { type: 'service_account', client_email: 'seo@acme.iam.gserviceaccount.com', private_key: privateKey }
  const SA = JSON.stringify(sa)

  it('parses a service account key and rejects anything else', () => {
    expect(parseServiceAccount(SA).client_email).toBe(sa.client_email)
    expect(() => parseServiceAccount('not json')).toThrow(/not valid JSON/)
    expect(() => parseServiceAccount('{"api_key":"x"}')).toThrow(/not a service account/)
  })

  it('signs a verifiable RS256 JWT for the read-only scope', () => {
    const jwt = serviceAccountJwt(parseServiceAccount(SA), NOW)
    const [h, c, sig] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
    expect(claims).toMatchObject({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token' })
    expect(claims.exp - claims.iat).toBe(3600)
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(publicKey), Buffer.from(sig, 'base64url'))).toBe(true)
  })

  it('totals clicks and weights position by impressions', () => {
    const t = gscTotals([
      { clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { clicks: 0, impressions: 300, ctr: 0, position: 10 }
    ])
    expect(t).toEqual({ clicks: 10, impressions: 400, ctr: 0.025, position: 8 })
    expect(gscTotals([]).ctr).toBeNull()
    expect(homeUrl('sc-domain:acme.com')).toBe('https://acme.com/')
    expect(homeUrl('https://acme.com/blog/')).toBe('https://acme.com/blog/')
  })

  it('a refused token exchange is an invalid key; a 403 on the site names the account to add', async () => {
    const refused = await gscProvider.validate(ctx({ http: status(400, { error: 'invalid_grant' }), keys: { GSC_SERVICE_ACCOUNT_JSON: SA }, config: { siteUrl: 'sc-domain:acme.com' } })).catch((e) => e)
    expect(refused.code).toBe('invalid_key')
    const calls: HttpReq[] = []
    const http: HttpFn = async (req) => {
      calls.push(req)
      return req.url.startsWith('https://oauth2') ? { status: 200, body: { access_token: 'tok' }, retryAfter: null } : { status: 403, body: { error: { message: 'User does not have sufficient permission' } }, retryAfter: null }
    }
    const err = await gscProvider.validate(ctx({ http, keys: { GSC_SERVICE_ACCOUNT_JSON: SA }, config: { siteUrl: 'sc-domain:acme.com' } })).catch((e) => e)
    expect(err.code).toBe('forbidden')
    expect(err.message).toContain(sa.client_email)
    expect(err.message).not.toContain('PRIVATE KEY')
    expect(calls[1].url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.com')
    expect(calls[1].headers?.Authorization).toBe('Bearer tok')
  })

  it('fetches KPIs, a daily series, top queries and PageSpeed from the sample property', async () => {
    const snap = await gscProvider.fetch(ctx({ keys: { GSC_SERVICE_ACCOUNT_JSON: SA }, config: SAMPLE_CONFIG.gsc }))
    expect(snap.kpis.clicks.value).toBeGreaterThan(0)
    expect(snap.kpis.ctr.value).toBeGreaterThan(0)
    expect(snap.kpis.position.value).toBeGreaterThan(1)
    expect(snap.kpis.pagespeed.value).toBe(82)
    expect(snap.kpis.lcp.value).toBeCloseTo(2.48)
    expect(snap.series.daily[0].points).toHaveLength(28)
    expect(snap.tables.queries).toHaveLength(10)
  })
})

describe('GEO', () => {
  const brand = { name: 'Acme', aliases: ['Acme AI'], domain: 'acme.com' }

  it('matches whole words only', () => {
    expect(firstMention('We like Acme a lot', ['Acme'])).toBe(8)
    expect(firstMention('Acmesoft is different', ['Acme'])).toBe(-1)
    expect(firstMention('(acme) works', ['Acme'])).toBe(1)
    expect(hostOf('https://www.Acme.com/pricing?x=1')).toBe('acme.com')
  })

  it('scores mention, rank among competitors and citations', () => {
    const s = scoreAnswer({ text: '1. Globex 2. Acme AI 3. Initech. See https://docs.acme.com/x', citations: [] }, brand, ['Globex', 'Initech', 'Umbrella'])
    expect(s).toEqual({ named: true, rank: 2, cited: true, competitors: ['Globex', 'Initech'] })
    const miss = scoreAnswer({ text: 'Try Globex.', citations: ['https://globex.com'] }, brand, ['Globex'])
    expect(miss).toEqual({ named: false, rank: null, cited: false, competitors: ['Globex'] })
    expect(scoreAnswer({ text: 'Acme', citations: ['https://notacme.com'] }, brand, []).cited).toBe(false)
  })

  it('aggregates mention rate, share of voice and average rank', () => {
    const r = (named: boolean, rank: number | null, competitors: string[], cited = false) => ({ prompt: 'p', engine: 'e', score: { named, rank, cited, competitors } })
    const agg = aggregateGeo([r(true, 1, ['Globex']), r(false, null, ['Globex', 'Initech']), r(true, 3, ['Globex', 'Initech'], true), r(false, null, [])], 'Acme', ['Globex', 'Initech'])
    expect(agg.mentionRate).toBe(0.5)
    expect(agg.shareOfVoice).toBeCloseTo(2 / 7)
    expect(agg.avgRank).toBe(2)
    expect(agg.citationRate).toBe(0.25)
    expect(agg.brands[0]).toEqual({ brand: 'Globex', mentions: 3, share: 3 / 7 })
  })

  it('appends one point per day to the trend, capped', () => {
    let s = appendTrend(undefined, 'Mention rate', '2026-10-01', 0.2)
    s = appendTrend([s], 'Mention rate', '2026-10-01', 0.3)
    expect(s.points).toEqual([{ t: '2026-10-01', v: 0.3 }])
    for (let i = 0; i < GEO_TREND_MAX + 5; i++) s = appendTrend([s], 'Mention rate', `d${i}`, i)
    expect(s.points).toHaveLength(GEO_TREND_MAX)
  })

  it('needs a brand, a prompt and at least one engine', async () => {
    await expect(geoProvider.validate(ctx({ config: { prompts: ['x'] }, geoEngines: () => fixtureGeoEngines({}) }))).rejects.toThrow(/brand/)
    await expect(geoProvider.validate(ctx({ config: { brand: 'Acme' }, geoEngines: () => fixtureGeoEngines({}) }))).rejects.toThrow(/prompt/)
    await expect(geoProvider.validate(ctx({ config: { brand: 'Acme', prompts: ['x'] }, geoEngines: () => [] }))).rejects.toThrow(/No answer engine/)
  })

  it('checks an OpenAI key against the models list (a 401 is an invalid key)', async () => {
    const err = await geoProvider.validate(ctx({ http: status(401), keys: { OPENAI_API_KEY: 'sk-bad' }, config: { brand: 'Acme', prompts: ['x'] }, geoEngines: () => fixtureGeoEngines({}) })).catch((e) => e)
    expect(err.code).toBe('invalid_key')
    expect(err.message).toMatch(/OpenAI/)
  })

  it('runs every prompt on every engine and keeps the answers that came back', async () => {
    const engines = fixtureGeoEngines(SAMPLE_CONFIG.geo)
    const flaky = { ...engines[0], ask: async () => { throw new DashboardFetchError('rate_limited', 'slow down') } }
    const snap = await geoProvider.fetch(ctx({ config: SAMPLE_CONFIG.geo, geoEngines: () => [flaky, engines[1]] }))
    expect(snap.tables.prompts).toHaveLength(4)
    expect(snap.kpis.mentionRate.value).not.toBeNull()
    expect(snap.series.trend[0].points).toHaveLength(1)
    expect(snap.warnings?.[0]).toMatch(/ChatGPT did not answer/)
    const all = await geoProvider.fetch(ctx({ config: SAMPLE_CONFIG.geo, geoEngines: () => [flaky] })).catch((e) => e)
    expect(all.code).toBe('rate_limited')
  })
})

describe('GitHub', () => {
  it('reads owner/name from a name or a URL', () => {
    expect(repoOf({ config: { repo: 'https://github.com/acme/app.git' } })).toBe('acme/app')
    expect(() => repoOf({ config: { repo: 'acme' } })).toThrow(/owner\/name/)
    expect(() => repoOf({ config: { repo: '../etc' } })).toThrow()
  })

  it('computes median merge time, weekly merges and CI success', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
    const item = (createdH: number, mergedH: number) => ({ title: 't', created_at: new Date(NOW.getTime() - createdH * 3_600_000).toISOString(), closed_at: null, pull_request: { merged_at: new Date(NOW.getTime() - mergedH * 3_600_000).toISOString() } })
    expect(mergeHours([item(30, 10), item(100, 99)], NOW.getTime() - 50 * 3_600_000, NOW.getTime())).toEqual([20])
    const weeks = weeklyMerged([item(30, 10), item(400, 200)], NOW)
    expect(weeks).toHaveLength(12)
    expect(weeks.at(-1)!.v).toBe(1)
    expect(weeks.at(-2)!.v).toBe(1)
    const run = (conclusion: string | null, status = 'completed') => ({ status, conclusion, created_at: NOW.toISOString() })
    expect(ciSuccess([run('success'), run('failure'), run('cancelled'), run(null, 'in_progress'), run('success')])).toBeCloseTo(2 / 3)
    expect(ciSuccess([])).toBeNull()
  })

  it('reads gh CLI failures as HTTP statuses', () => {
    expect(ghStatus('gh: Not Found (HTTP 404)')).toBe(404)
    expect(ghStatus('API rate limit exceeded')).toBe(429)
    expect(ghStatus('To get started with GitHub CLI, please run:  gh auth login')).toBe(401)
    expect(ghStatus('connection reset')).toBe(0)
  })

  it('without a token or gh it asks for one; with gh it uses gh', async () => {
    await expect(githubProvider.validate(ctx({ config: { repo: 'acme/app' } }))).rejects.toThrow(/gh auth login/)
    const calls: HttpReq[] = []
    const gh: HttpFn = async (req) => (calls.push(req), { status: 200, body: { default_branch: 'main' }, retryAfter: null })
    await githubProvider.validate(ctx({ config: { repo: 'acme/app' }, gh }))
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app')
    expect(calls[0].headers?.Authorization).toBeUndefined()
  })

  it('fetches the sample repository', async () => {
    const snap = await githubProvider.fetch(ctx({ keys: { GITHUB_TOKEN: 'sample' }, config: SAMPLE_CONFIG.github }))
    expect(snap.kpis.openPrs.value).toBe(14)
    expect(snap.kpis.mergedPrs).toEqual({ value: 23, previous: 19 })
    expect(snap.kpis.ciSuccess.value).toBeGreaterThan(0.5)
    expect(snap.kpis.timeToMerge.value).toBeGreaterThan(0)
    expect(snap.tables.waiting).toHaveLength(8)
    expect(snap.tables.runs[0].result).toBe('in_progress')
  })
})

describe('web analytics', () => {
  it('accepts only https hosts', () => {
    expect(analyticsHost(undefined, 'https://plausible.io')).toBe('https://plausible.io')
    expect(analyticsHost('https://stats.acme.com/path', 'x')).toBe('https://stats.acme.com')
    expect(() => analyticsHost('http://stats.acme.com', 'x')).toThrow(/https/)
    expect(() => analyticsHost('not a url', 'x')).toThrow(/not a URL/)
  })

  it('Plausible: bounce rate becomes a ratio and the series is per day', async () => {
    const snap = await plausibleProvider.fetch(ctx({ keys: { PLAUSIBLE_API_KEY: 'k' }, config: SAMPLE_CONFIG.plausible }))
    expect(snap.kpis.visitors).toEqual({ value: 18420, previous: Math.round(18420 * 0.86) })
    expect(snap.kpis.bounceRate.value).toBe(0.54)
    expect(snap.series.daily[0].points).toHaveLength(28)
    expect(snap.tables.sources[1].source).toBe('Direct / None')
  })

  it('Plausible: a 401 is an invalid key', async () => {
    const err = await plausibleProvider.validate(ctx({ keys: { PLAUSIBLE_API_KEY: 'invalid-key' }, config: { siteId: 'acme.com' } })).catch((e) => e)
    expect(err.code).toBe('invalid_key')
  })

  it('PostHog: needs a numeric project id and reads HogQL rows', async () => {
    await expect(posthogProvider.validate(ctx({ keys: { POSTHOG_PERSONAL_API_KEY: 'phx_x' }, config: { projectId: 'abc' } }))).rejects.toThrow(/project ID/)
    const snap = await posthogProvider.fetch(ctx({ keys: { POSTHOG_PERSONAL_API_KEY: 'phx_x' }, config: SAMPLE_CONFIG.posthog }))
    expect(snap.kpis.users).toEqual({ value: 9120, previous: 8030 })
    expect(snap.kpis.viewsPerUser.value).toBeCloseTo(52310 / 9120)
    expect(snap.tables.referrers[0].referrer).toBe('Direct')
  })
})
