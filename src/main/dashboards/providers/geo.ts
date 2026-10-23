/**
 * DASHBOARDS.md §5.2: GEO, AI visibility. Each tracked prompt is asked once to every available answer engine (OpenAI
 * and Perplexity with the company's keys, the installed Claude CLI with none), and each answer is scored locally:
 *
 * - **named**: the brand (or an alias) appears as a whole word;
 * - **rank**: the brand's place among the tracked brands in order of first appearance (1 = named first);
 * - **cited**: the brand's domain is among the answer's citation URLs or links in its text;
 * - **share of voice**: answers naming the brand ÷ answers naming any tracked brand, summed over brands.
 *
 * Every run appends a point to the trend (the previous snapshot's series plus today), capped at 60 runs.
 */
import type { DashboardSnapshot, Series, TableRow } from '../../../shared/dashboards'
import { configList, configText } from '../../../shared/dashboards'
import { DashboardFetchError, getJson, type HttpFn } from '../http'
import type { DashboardProvider, GeoAnswer, GeoEngine, ProviderCtx } from './types'

export const GEO_MAX_PROMPTS = 10
export const GEO_TREND_MAX = 60
/** Model ids for the API engines. Small, cheap models: this runs prompts × engines times a day. */
export const OPENAI_GEO_MODEL = 'gpt-4o-mini'
export const PERPLEXITY_GEO_MODEL = 'sonar'

export interface BrandSpec {
  name: string
  aliases: string[]
  domain: string | null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The first index where any of `names` appears as a whole word (case-insensitive), or -1. */
export function firstMention(text: string, names: readonly string[]): number {
  let best = -1
  for (const n of names) {
    const term = n.trim()
    if (!term) continue
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(text)
    if (m) {
      const at = m.index + m[1].length
      if (best < 0 || at < best) best = at
    }
  }
  return best
}

/** Bare host of a domain or URL ("https://www.Acme.com/x" → acme.com). */
export function hostOf(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0]
}

export interface AnswerScore {
  named: boolean
  rank: number | null
  cited: boolean
  /** competitors named in this answer, in order of first appearance */
  competitors: string[]
}

/** Scores one answer for the brand against the competitors. */
export function scoreAnswer(answer: GeoAnswer, brand: BrandSpec, competitors: readonly string[]): AnswerScore {
  const brandAt = firstMention(answer.text, [brand.name, ...brand.aliases])
  const seen = competitors.map((c) => ({ c, at: firstMention(answer.text, [c]) })).filter((x) => x.at >= 0)
  const order = [...seen, ...(brandAt >= 0 ? [{ c: brand.name, at: brandAt }] : [])].sort((a, b) => a.at - b.at)
  const host = brand.domain ? hostOf(brand.domain) : null
  const urls = [...answer.citations, ...(answer.text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [])]
  const cited = !!host && urls.some((u) => {
    const h = hostOf(u)
    return h === host || h.endsWith(`.${host}`)
  })
  return {
    named: brandAt >= 0,
    rank: brandAt >= 0 ? order.findIndex((x) => x.c === brand.name) + 1 : null,
    cited,
    competitors: seen.sort((a, b) => a.at - b.at).map((x) => x.c)
  }
}

export interface GeoResult {
  prompt: string
  engine: string
  score: AnswerScore
}

export interface GeoAggregate {
  answers: number
  mentionRate: number | null
  shareOfVoice: number | null
  avgRank: number | null
  citationRate: number | null
  brands: { brand: string; mentions: number; share: number | null }[]
}

/** Totals over every (prompt, engine) answer. */
export function aggregateGeo(results: readonly GeoResult[], brand: string, competitors: readonly string[]): GeoAggregate {
  const n = results.length
  const named = results.filter((r) => r.score.named)
  const ranks = named.map((r) => r.score.rank!).filter((x) => x > 0)
  const counts = [brand, ...competitors].map((b) => ({ brand: b, mentions: b === brand ? named.length : results.filter((r) => r.score.competitors.includes(b)).length }))
  const all = counts.reduce((s, c) => s + c.mentions, 0)
  return {
    answers: n,
    mentionRate: n ? named.length / n : null,
    shareOfVoice: all ? named.length / all : null,
    avgRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
    citationRate: n ? results.filter((r) => r.score.cited).length / n : null,
    brands: counts.sort((a, b) => b.mentions - a.mentions).map((c) => ({ ...c, share: all ? c.mentions / all : null }))
  }
}

/** The previous run's series with today's point added (same day replaces), capped. */
export function appendTrend(prev: Series[] | undefined, label: string, t: string, v: number | null): Series {
  const old = prev?.find((s) => s.label === label)?.points ?? []
  const points = v == null ? old : [...old.filter((p) => p.t !== t), { t, v }]
  return { label, points: points.slice(-GEO_TREND_MAX) }
}

export function brandOf(ctx: Pick<ProviderCtx, 'config'>): BrandSpec {
  const name = configText(ctx.config.brand)
  if (!name) throw new DashboardFetchError('config', 'Set the brand name to look for.')
  const domain = configText(ctx.config.domain) || null
  return { name, aliases: configList(ctx.config.aliases), domain }
}

export function promptsOf(ctx: Pick<ProviderCtx, 'config'>): string[] {
  const prompts = configList(ctx.config.prompts).slice(0, GEO_MAX_PROMPTS)
  if (!prompts.length) throw new DashboardFetchError('config', 'Add at least one tracked prompt, like “What is the best tool for …?”.')
  return prompts
}

// ---------- API engines ----------

/** OpenAI Chat Completions (no web search: what the model knows). */
export function openAiEngine(http: HttpFn, key: string): GeoEngine {
  return {
    id: 'openai',
    label: 'ChatGPT',
    async ask(prompt) {
      const res = await getJson<{ choices?: { message?: { content?: string } }[] }>(
        http,
        { url: 'https://api.openai.com/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OPENAI_GEO_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 700 }), timeoutMs: 60_000 },
        { provider: 'OpenAI', secrets: [key] }
      )
      return { text: res.choices?.[0]?.message?.content ?? '', citations: [] }
    }
  }
}

/** Perplexity Sonar: searches the web and returns the URLs it cited. */
export function perplexityEngine(http: HttpFn, key: string): GeoEngine {
  return {
    id: 'perplexity',
    label: 'Perplexity',
    async ask(prompt) {
      const res = await getJson<{ choices?: { message?: { content?: string } }[]; citations?: unknown; search_results?: { url?: string }[] }>(
        http,
        { url: 'https://api.perplexity.ai/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: PERPLEXITY_GEO_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 700 }), timeoutMs: 60_000 },
        { provider: 'Perplexity', secrets: [key] }
      )
      const cites = Array.isArray(res.citations) ? res.citations.filter((c): c is string => typeof c === 'string') : (res.search_results ?? []).map((r) => r.url ?? '').filter(Boolean)
      return { text: res.choices?.[0]?.message?.content ?? '', citations: cites }
    }
  }
}

/** Key checks: OpenAI lists models (free); Perplexity has no free endpoint, so one 1-token completion. */
export async function validateGeoKeys(http: HttpFn, keys: Record<string, string>): Promise<void> {
  if (keys.OPENAI_API_KEY) {
    await getJson(http, { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${keys.OPENAI_API_KEY}` } }, { provider: 'OpenAI', secrets: [keys.OPENAI_API_KEY] })
  }
  if (keys.PERPLEXITY_API_KEY) {
    await getJson(
      http,
      { url: 'https://api.perplexity.ai/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${keys.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: PERPLEXITY_GEO_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }) },
      { provider: 'Perplexity', secrets: [keys.PERPLEXITY_API_KEY] }
    )
  }
}

/** Runs `fn` over `items` with at most `n` in flight, keeping order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export const geoProvider: DashboardProvider = {
  kind: 'geo',
  async validate(ctx) {
    brandOf(ctx)
    promptsOf(ctx)
    await validateGeoKeys(ctx.http, ctx.keys)
    if (!(ctx.geoEngines?.() ?? []).length) throw new DashboardFetchError('config', 'No answer engine is available. Add an OpenAI or Perplexity key, or install Claude Code on this Mac.')
  },
  async fetch(ctx) {
    const brand = brandOf(ctx)
    const prompts = promptsOf(ctx)
    const competitors = configList(ctx.config.competitors).slice(0, 8)
    const engines = ctx.geoEngines?.() ?? []
    if (!engines.length) throw new DashboardFetchError('config', 'No answer engine is available. Add an OpenAI or Perplexity key, or install Claude Code on this Mac.')
    const jobs = prompts.flatMap((prompt) => engines.map((engine) => ({ prompt, engine })))
    const failures: string[] = []
    let firstError: DashboardFetchError | null = null
    const settled = await pool(jobs, 3, async ({ prompt, engine }) => {
      try {
        return { prompt, engine: engine.label, score: scoreAnswer(await engine.ask(prompt), brand, competitors) }
      } catch (e) {
        if (e instanceof DashboardFetchError) firstError ??= e
        failures.push(engine.label)
        return null
      }
    })
    const results = settled.filter((r): r is GeoResult => !!r)
    if (!results.length) throw firstError ?? new DashboardFetchError('unavailable', 'None of the answer engines answered. Try again later.')
    const agg = aggregateGeo(results, brand.name, competitors)
    const day = ctx.now.toISOString().slice(0, 10)
    const prevTrend = ctx.previous?.series?.trend
    const prevK = ctx.previous?.kpis
    const promptRows: TableRow[] = prompts.map((prompt) => {
      const mine = results.filter((r) => r.prompt === prompt)
      const named = mine.filter((r) => r.score.named)
      const ranks = named.map((r) => r.score.rank!).filter(Boolean)
      const instead = [...new Set(mine.flatMap((r) => r.score.competitors))].slice(0, 3)
      return {
        prompt,
        named: named.length ? `${named.length}/${mine.length} · ${named.map((r) => r.engine).join(', ')}` : `0/${mine.length}`,
        rank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
        instead: instead.join(', ') || '—'
      }
    })
    const uniqueFailures = [...new Set(failures)]
    return {
      fetchedAt: ctx.now.toISOString(),
      period: `${prompts.length} prompt${prompts.length === 1 ? '' : 's'} × ${engines.map((e) => e.label).join(', ')} · vs the previous run`,
      kpis: {
        mentionRate: { value: agg.mentionRate, previous: prevK?.mentionRate?.value ?? null },
        shareOfVoice: { value: agg.shareOfVoice, previous: prevK?.shareOfVoice?.value ?? null },
        avgRank: { value: agg.avgRank, previous: prevK?.avgRank?.value ?? null },
        citationRate: { value: brand.domain ? agg.citationRate : null, previous: brand.domain ? (prevK?.citationRate?.value ?? null) : null }
      },
      series: {
        trend: [appendTrend(prevTrend, 'Mention rate', day, agg.mentionRate), appendTrend(prevTrend, 'Share of voice', day, agg.shareOfVoice)]
      },
      tables: { brands: agg.brands.map((b) => ({ brand: b.brand, mentions: b.mentions, share: b.share })), prompts: promptRows },
      ...(uniqueFailures.length ? { warnings: [`${uniqueFailures.join(', ')} did not answer every prompt; scores use the answers that came back (${results.length}/${jobs.length}).`] } : {})
    } satisfies DashboardSnapshot
  }
}

