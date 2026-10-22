/**
 * §5.1 prefill: turns a (redacted) repo scan and site read into About-step answers. Pure and shared. The renderer only
 * fills fields the founder left empty, and shows the source as a pill ("From README", "From your site").
 */
import type { OnboardingAnswers, RepoScanSummary, ScanSummary, SiteSummary } from './onboarding'

export type PrefillField = 'name' | 'oneLiner' | 'products' | 'siteUrl'
export type PrefillSource = 'package' | 'folder' | 'github' | 'readme' | 'cname' | 'site'
export interface PrefillResult {
  answers: Partial<Pick<OnboardingAnswers, PrefillField>>
  sources: Partial<Record<PrefillField, PrefillSource>>
}

/** Pill copy per source. */
export const PREFILL_SOURCE_LABEL: Record<PrefillSource, string> = {
  package: 'From package.json',
  folder: 'From the folder name',
  github: 'From GitHub',
  readme: 'From README',
  cname: 'From CNAME',
  site: 'From your site'
}

const MAX = { name: 80, oneLiner: 200, products: 500, siteUrl: 2048 } as const

/** Hosts that are never the business's own site (repo hosts, badges, registries, CI). */
/** Suffixes of hosts that are never the business's own site. */
const NOT_A_SITE_SUFFIXES = ['.githubusercontent.com', '.shields.io', '.npmjs.com', '.travis-ci.com', '.circleci.com', '.codecov.io']
const NOT_A_SITE_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'img.shields.io',
  'shields.io',
  'badge.fury.io',
  'npmjs.com',
  'www.npmjs.com',
  'npmjs.org',
  'pypi.org',
  'crates.io',
  'docs.rs',
  'travis-ci.org',
  'travis-ci.com',
  'circleci.com',
  'codecov.io',
  'coveralls.io',
  'opensource.org',
  'creativecommons.org',
  'choosealicense.com',
  'vercel.com',
  'netlify.com',
  'app.netlify.com',
  'deploy.workers.cloudflare.com',
  'localhost'
])

function hostOf(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/?#\s]*@)?([^/?#:\s]+)/i.exec(url.trim())
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null
}

/** An http(s) link that plausibly is the business's own site. */
function siteLink(url: string | undefined): string | null {
  if (!url) return null
  const u = url.trim()
  // No credentials in the link (`user:pw@`) and no `\` / `@` host tricks.
  if (/[@\\]/.test(/^https?:\/\/([^/?#]*)/i.exec(u)?.[1] ?? '')) return null
  const host = hostOf(u)
  if (!host || !host.includes('.')) return null
  if (NOT_A_SITE_HOSTS.has(host) || NOT_A_SITE_SUFFIXES.some((x) => host.endsWith(x)) || /^(\d+\.){3}\d+$/.test(host)) return null
  return u.length <= MAX.siteUrl ? u : null
}

/** "acme-web" / "sunday_bakery" / "@acme/web-app" → "Acme Web" / "Sunday Bakery" / "Web App". */
export function titleCase(raw: string): string {
  const base = raw.trim().replace(/^@[^/]+\//, '').replace(/\.git$/i, '')
  return base
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function oneLine(s: string | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

/** The site's own name: og:site_name, else the first part of the title ("Sunday Bakery – Fresh sourdough"). */
function siteName(site: SiteSummary): string {
  if (site.siteName?.trim()) return site.siteName
  const title = site.ogTitle?.trim() || site.title?.trim() || ''
  return title.split(/\s+[–—|·:-]\s+/)[0] ?? ''
}

function repoName(r: RepoScanSummary): { value: string; source: PrefillSource } | null {
  if (r.packageName?.trim()) {
    const v = titleCase(r.packageName)
    if (v) return { value: v, source: 'package' }
  }
  const label = r.source === 'github' ? (r.fullName ?? r.label).split('/').pop() ?? '' : r.label
  const v = titleCase(label)
  return v ? { value: v, source: r.source === 'github' ? 'github' : 'folder' } : null
}

/** §5.1: answers inferred from the scan and site read, with where each came from. */
export function prefillWithSources(scan?: ScanSummary | null, site?: SiteSummary | null): PrefillResult {
  const out: PrefillResult = { answers: {}, sources: {} }
  const set = (field: PrefillField, value: string, source: PrefillSource): void => {
    const v = oneLine(value, MAX[field])
    if (!v || out.answers[field] !== undefined) return
    out.answers[field] = v
    out.sources[field] = source
  }
  const repos = scan?.repos ?? []
  const descSource = (r: RepoScanSummary): PrefillSource => (r.source === 'github' ? 'github' : 'package')

  // Name: package name or folder (title-cased), else the site's name.
  for (const r of repos) {
    const n = repoName(r)
    if (n) {
      set('name', n.value, n.source)
      break
    }
  }
  if (site) set('name', siteName(site), 'site')

  // One line: description, else the README's first meaningful line, else the site description.
  const withDesc = repos.find((r) => r.description?.trim())
  if (withDesc) set('oneLiner', withDesc.description!, descSource(withDesc))
  const withLine = repos.find((r) => r.readmeLine?.trim())
  if (withLine) set('oneLiner', withLine.readmeLine!, 'readme')
  if (site) set('oneLiner', site.description || site.ogDescription || '', 'site')

  // Website: homepage → CNAME → first README https link → the site that was read.
  for (const r of repos) {
    const u = siteLink(r.homepage)
    if (u) {
      set('siteUrl', u, descSource(r))
      break
    }
  }
  for (const r of repos) {
    const c = r.cname?.trim().toLowerCase()
    if (c && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(c)) {
      set('siteUrl', `https://${c}`, 'cname')
      break
    }
  }
  for (const r of repos) {
    const u = r.readmeLink && /^https:\/\//i.test(r.readmeLink) ? siteLink(r.readmeLink) : null
    if (u) {
      set('siteUrl', u, 'readme')
      break
    }
  }
  if (site) set('siteUrl', site.url, 'site')

  // What you sell: the site's description when it isn't already the one-liner, else the repo description.
  const siteDesc = site ? site.ogDescription || site.description || '' : ''
  if (siteDesc && oneLine(siteDesc, MAX.oneLiner) !== out.answers.oneLiner) set('products', siteDesc, 'site')
  if (withDesc) set('products', withDesc.description!, descSource(withDesc))

  return out
}

/** §5.1 `prefill(scan) → Partial<answers>`. */
export function prefill(scan?: ScanSummary | null, site?: SiteSummary | null): Partial<OnboardingAnswers> {
  return prefillWithSources(scan, site).answers
}
