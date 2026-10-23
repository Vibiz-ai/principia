import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, CompanyTask, Department } from '@shared/company'

// server markup needs a server snapshot; the store passes only the client one
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
// Settings toggles: record what they ask the store to save
const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
vi.mock('../../state/store', async (orig) => ({ ...(await orig<typeof import('../../state/store')>()), updateSettings: (p: Record<string, unknown>) => updateSettings(p) }))
// the renderer modules read window.hive at import; markup rendering never calls it
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const SINCE = '2026-10-20T00:00:00Z'
const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id, identifier: `PRN-${id}`, title: `Task ${id}`, description: '', companyId: 'co_a', repoId: null, status: 'todo', blockReason: null, priority: 3, source: 'manual', sourceUrl: null, externalId: null,
    assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, agentId: null, createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-20T08:00:00Z', ...p }) as CompanyTask
const company = (id: string, name: string, p: Partial<CompanyPassport> = {}): CompanyPassport =>
  ({ id, name, slug: id, color: '#5b8def', sortOrder: 0, system: null, archivedAt: null, repoIds: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '', mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', ...p }) as CompanyPassport
const marketing = { id: 'dep_m', companyId: 'co_a', key: 'marketing', name: 'Marketing', color: '#d97757', icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} } as unknown as Department
const agentData = { instructions: '', capabilities: '', autonomy: 'auto', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } }
const copywriter = { id: 'agt_copy', companyId: 'co_a', departmentId: 'dep_m', kind: 'profile', refId: 'p1', name: 'Copywriter', archivedAt: null, pausedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '', data: agentData } as unknown as CompanyAgent
const builder = { ...copywriter, id: 'agt_site', name: 'Site builder', createdAt: '2026-10-02T00:00:00Z' } as CompanyAgent
const asking = (id: string, agentId = 'agt_copy'): CompanyTask => task(id, { status: 'blocked', blockReason: 'needs_input', agentId, departmentId: 'dep_m', title: `Pick a draft ${id}`, ask: { kind: 'confirm', prompt: 'Publish on Friday?' } })

async function withState(p: { tone?: 'playful' | 'plain'; personas?: boolean; tasks?: CompanyTask[]; companies?: CompanyPassport[]; extra?: Record<string, unknown> } = {}): Promise<void> {
  const { setState } = await import('../../state/store')
  setState({
    settings: { experimental: { companies: true, departments: true }, tone: p.tone, personas: p.personas } as never,
    companies: p.companies ?? [company('co_a', 'Sunday Bakery'), company('co_personal', 'Personal', { system: 'personal' })],
    companiesLoaded: true, activeCompanyId: 'co_a', view: { name: 'home' }, asks: {},
    tasks: p.tasks ?? [],
    departments: [marketing], companyAgents: [copywriter, builder],
    ...p.extra
  })
}
const html = (el: ReactElement): string => renderToStaticMarkup(el)
const MORNING = new Date(2026, 9, 21, 9, 0, 0)

describe('Home: the Senate briefing (VOICE.md §3.5)', () => {
  beforeEach(() => vi.resetModules())
  const overnightTasks = [task('14', { status: 'done', agentId: 'agt_copy', departmentId: 'dep_m', title: 'Launch posts' }), task('15', { status: 'in_review', agentId: 'agt_site', departmentId: 'dep_m', title: 'One-page site' })]

  it('playful: "The Senate briefing", greeting, grouped by agent with bust, persona and role', async () => {
    await withState({ tasks: overnightTasks })
    const { SenateBriefing } = await import('./DashboardParts')
    const out = html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING }))
    expect(out).toContain('The Senate briefing')
    // line-art system (VOICE.md §5): the title is plain Cinzel in --text-primary, never gilded
    expect(out).toContain('<h2 class="briefing__title">')
    expect(out).not.toContain('rm-gilt')
    // the greeting sprig is white line art, no tone fill
    expect(out).toMatch(/<svg[^>]*class="rm-la rm-laurel-svg rm-laurel-svg--sprig"[^>]*stroke="#fff"/)
    // list avatars at 20 px wear the faint ring (VOICE.md §5.4)
    expect(out).toContain('rm-bust__ring')
    expect(out).toContain('Since you were last here')
    expect(out).toContain('Good morning')
    // the playful title is hidden from screen readers, which hear only the plain "Overnight" (VOICE.md §9)
    expect(out).toContain('<span aria-hidden="true">The Senate briefing</span><span class="rm-sr">Overnight</span>')
    expect(out.replace('<span class="rm-sr">Overnight</span>', '')).not.toContain('>Overnight<')
    // grouped by agent: Marcus (first marketing persona) and Vitruvius, each with the role label
    expect(out).toMatch(/Marcus<\/b><span class="briefing__role">Copywriter/)
    expect(out).toContain('Site builder')
    expect(out).toContain('rm-bust')
    expect(out).toContain('1 done')
    expect(out).toContain('1 to review')
    expect(out).toContain('PRN-14')
  })

  it('plain: "Overnight", same structure, no wink', async () => {
    await withState({ tone: 'plain', tasks: overnightTasks })
    const { SenateBriefing } = await import('./DashboardParts')
    const out = html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING }))
    expect(out).toContain('Overnight')
    expect(out).not.toContain('Senate')
    expect(out).not.toContain('rm-gilt')
    expect(out).toContain('<h2 class="briefing__title">Overnight</h2>')
    // the craft stays: busts and personas
    expect(out).toContain('rm-bust')
    expect(out).toContain('Marcus')
  })

  it('personas off: role label and initials instead of the bust', async () => {
    await withState({ personas: false, tasks: overnightTasks })
    const { SenateBriefing } = await import('./DashboardParts')
    const out = html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING }))
    expect(out).not.toContain('Marcus')
    expect(out).not.toContain('rm-bust')
    expect(out).toContain('seat-avatar')
    expect(out).toContain('Copywriter')
  })

  it('empty: home.digest.empty over the lamp mosaic, Latin only in playful', async () => {
    await withState()
    const { SenateBriefing } = await import('./DashboardParts')
    const playful = html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING }))
    expect(playful).toContain('rm-mosaic--lamp')
    expect(playful).toContain('Quid novi?')
    expect(playful).toContain('Nothing since you left.')
    await withState({ tone: 'plain' })
    const plain = html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING }))
    expect(plain).toContain('rm-mosaic--lamp')
    expect(plain).toContain('Nothing new since you were last here.')
    expect(plain).not.toContain('lang="la"')
    // Home passes latin={false} under an empty Needs you (Otium is already on screen): no second Latin phrase
    await withState()
    const quiet = html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING, latin: false }))
    expect(quiet).not.toContain('Quid novi?')
    expect(quiet).toContain('Nothing new since you were last here.')
  })

  it('renders nothing with departments off', async () => {
    await withState({ tasks: overnightTasks, extra: { settings: { experimental: { companies: true, departments: false } } } })
    const { SenateBriefing } = await import('./DashboardParts')
    expect(html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE }))).toBe('')
  })

  it('greeting by the hour', async () => {
    const { greetingFor } = await import('./DashboardParts')
    expect(greetingFor(new Date(2026, 9, 21, 8), 'playful')).toBe('Good morning')
    expect(greetingFor(new Date(2026, 9, 21, 20), 'plain')).toBe('Good evening')
    expect(greetingFor(new Date(2026, 9, 21, 14), 'plain')).toBe('Good afternoon')
  })
})

describe('Needs you (VOICE.md §3.6)', () => {
  beforeEach(() => vi.resetModules())

  it('the header says "Needs you" in both tones', async () => {
    for (const tone of ['playful', 'plain'] as const) {
      await withState({ tone, tasks: [asking('1')] })
      const { NeedsYouHeader } = await import('./DashboardParts')
      const { NeedsYouTasksSlot } = await import('../../shell/DepartmentGroup')
      expect(html(createElement(NeedsYouHeader, { count: 1 }))).toContain('<span class="section-header__title">Needs you</span>')
      expect(html(createElement(NeedsYouTasksSlot, { companyId: 'co_a', heading: true }))).toContain('Needs you')
    }
  })

  it('playful: only the top ask gets "Ave!"; lines name the agent with bust 24 and role; the detail line stays', async () => {
    await withState({ tasks: [asking('1'), asking('2', 'agt_site'), task('4', { status: 'in_review', agentId: 'agt_site', departmentId: 'dep_m' })] })
    const { NeedsYouTasks } = await import('../board/NeedsYouTasks')
    const out = html(createElement(NeedsYouTasks, { companyId: 'co_a' }))
    expect(out).toContain('Ave! Marcus awaits your decree')
    expect(out.match(/Ave!/g)).toHaveLength(1)
    // the second Marketing agent resolves to Ovid
    expect(out).toContain('Ovid needs your answer')
    expect(out).toContain('Ovid needs your review')
    expect(out).toContain(' · Copywriter')
    expect(out).toMatch(/<svg[^>]*class="rm-la rm-bust[^"]*"[^>]*width="24"/)
    // list avatars (16 to 28 px) carry the faint --rm-ln-3 ring (VOICE.md §5.4)
    expect(out).toMatch(/<circle class="rm-bust__ring"[^>]*stroke-opacity="0.2"/)
    // the detail line: reason chip, identifier, title
    expect(out).toContain('Question')
    expect(out).toContain('PRN-1')
    expect(out).toContain('Pick a draft 1')
    // aria-labels are plain
    expect(out).toContain('aria-label="Marcus, Copywriter, needs you: Pick a draft 1 · Question · PRN-1"')
    expect(out).not.toMatch(/aria-label="[^"]*Ave/)
  })

  it('plain: no flavour; parked and unassigned lines', async () => {
    await withState({
      tone: 'plain',
      tasks: [asking('1'), task('5', { status: 'blocked', blockReason: 'agent', agentId: 'agt_site', departmentId: 'dep_m', report: { outcome: 'blocked', summary: 'No help docs folder yet', evidence: [], at: '' } }), task('6', { status: 'todo', departmentId: 'dep_m' })],
      extra: { companyAgents: [copywriter, builder] }
    })
    const { NeedsYouTasks } = await import('../board/NeedsYouTasks')
    const out = html(createElement(NeedsYouTasks, { companyId: 'co_a' }))
    expect(out).toContain('Marcus needs your answer')
    expect(out).not.toContain('Ave')
    expect(out).toContain('Ovid is stuck: no help docs folder yet')
    expect(out).toContain('No one is assigned to this task')
  })

  it('personas off: the role label names the agent', async () => {
    await withState({ personas: false, tasks: [asking('1')] })
    const { NeedsYouTasks } = await import('../board/NeedsYouTasks')
    const out = html(createElement(NeedsYouTasks, { companyId: 'co_a' }))
    expect(out).toContain('Ave! Copywriter awaits your decree')
    expect(out).not.toContain('Marcus')
    expect(out).toContain('seat-avatar')
  })

  it('playfulTop=false (live asks listed above): no "Ave!" on the first board row', async () => {
    await withState({ tasks: [asking('1')] })
    const { NeedsYouTasks } = await import('../board/NeedsYouTasks')
    const out = html(createElement(NeedsYouTasks, { companyId: 'co_a', playfulTop: false }))
    expect(out).not.toContain('Ave')
    expect(out).toContain('Marcus needs your answer')
  })

  it('a top ask with no agent reads plain, never "Ave! This task"', async () => {
    await withState({ tasks: [task('9', { status: 'blocked', blockReason: 'needs_input', departmentId: 'dep_m', ask: { kind: 'confirm', prompt: 'Go?' } })] })
    const { NeedsYouTasks } = await import('../board/NeedsYouTasks')
    const out = html(createElement(NeedsYouTasks, { companyId: 'co_a' }))
    expect(out).not.toContain('Ave')
    expect(out).toContain('needs your answer')
  })

  it('legacy agents (no stored persona, sparse data) still get a name and a bust', async () => {
    const legacy = { id: 'agt_old', companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p9', name: 'Helper', archivedAt: null, pausedAt: null, createdAt: '2025-01-01T00:00:00Z', updatedAt: '', data: {} } as unknown as CompanyAgent
    await withState({ tasks: [asking('1', 'agt_old')], extra: { companyAgents: [legacy] } })
    const { NeedsYouTasks } = await import('../board/NeedsYouTasks')
    const out = html(createElement(NeedsYouTasks, { companyId: 'co_a' }))
    expect(out).toContain(' · Helper')
    expect(out).toContain('rm-bust')
    const { SenateBriefing } = await import('./DashboardParts')
    await withState({ tasks: [task('2', { status: 'done', agentId: 'agt_old' })], extra: { companyAgents: [legacy] } })
    expect(html(createElement(SenateBriefing, { companyId: 'co_a', since: SINCE, now: MORNING }))).toContain('Helper')
  })

  it('empty: ny.empty over the laurel mosaic, Otium only in playful', async () => {
    const { NeedsYouEmpty } = await import('./DashboardParts')
    const playful = html(createElement(NeedsYouEmpty, { tone: 'playful' }))
    expect(playful).toContain('rm-mosaic--laurel')
    expect(playful).toContain('Nothing needs you.')
    expect(playful).toContain('Otium cum dignitate')
    const plain = html(createElement(NeedsYouEmpty, { tone: 'plain' }))
    expect(plain).toContain('rm-mosaic--laurel')
    expect(plain).toContain('Nothing needs you.')
    expect(plain).not.toContain('Otium')
  })
})

describe('Milestones strip and toast (VOICE.md §7)', () => {
  beforeEach(() => {
    vi.resetModules()
    mem.clear()
  })

  it('playful shows one Latin badge name (the freshest milestone) over its plain name; plain shows plain names; coins in both', async () => {
    await withState({ tasks: [task('1', { status: 'done', agentId: 'agt_copy' })], extra: { onboardingStatus: { journal: { status: 'done', companyId: 'co_a' } } } })
    const { MilestoneStrip } = await import('./MilestoneStrip')
    const playful = html(createElement(MilestoneStrip, { companyId: 'co_a' }))
    expect(playful).toContain('<span class="section-header__title">Milestones</span>')
    // VOICE.md §1: in a list only the top item gets the playful line, so the strip is never a wall of Latin
    // all stamped "now" here, so the last earned coin in strip order (Calm week) is the featured one
    expect(playful).toContain('<b class="ms-coin__name" lang="la">Pax</b>')
    expect(playful.match(/lang="la"/g)).toHaveLength(1)
    expect(playful).not.toContain('Primus lapis')
    expect(playful).not.toContain('Veni, vidi, vici')
    expect(playful).not.toContain('Concordia')
    expect(playful).toContain('Company launched')
    expect(playful).toContain('Full team</b><span class="ms-coin__sub">Locked')
    expect(playful.match(/rm-coin--earned/g)?.length).toBeGreaterThanOrEqual(3) // launched, firstTask, firstPost
    expect(playful.match(/rm-coin--locked/g)?.length).toBeGreaterThanOrEqual(1)
    await withState({ tone: 'plain', tasks: [task('1', { status: 'done', agentId: 'agt_copy' })], extra: { onboardingStatus: { journal: { status: 'done', companyId: 'co_a' } } } })
    const plain = html(createElement(MilestoneStrip, { companyId: 'co_a' }))
    expect(plain).toContain('Milestones')
    expect(plain).toContain('Company launched')
    expect(plain).not.toContain('Primus')
    expect(plain).not.toContain('lang="la"')
    expect(plain).toContain('rm-coin--earned')
  })

  it('screen readers hear each milestone once, plainly; the Latin badge keeps its translation', async () => {
    await withState({ tasks: [task('1', { status: 'done', agentId: 'agt_copy' })] })
    const { MilestoneStrip } = await import('./MilestoneStrip')
    const out = html(createElement(MilestoneStrip, { companyId: 'co_a' }))
    // every visible label is hidden from readers; the rm-sr line is the accessible text
    expect(out.match(/class="ms-coin__label" aria-hidden="true"/g)).toHaveLength(8)
    expect(out).toContain('<span class="rm-sr">First task done, earned</span>')
    // the one featured Latin badge keeps its literal translation at hand
    expect(out).toMatch(/title="[^"]+ · [^"]+"><b class="ms-coin__name" lang="la">/)
  })

  it('after a week the strip reads plain in playful too: no Latin badge on old milestones', async () => {
    mem.set('principia.milestones.v1', JSON.stringify({ co_a: { hundred: '2020-01-01T00:00:00Z' } }))
    await withState({ tone: 'playful' })
    const { MilestoneStrip } = await import('./MilestoneStrip')
    const out = html(createElement(MilestoneStrip, { companyId: 'co_a' }))
    expect(out).toContain('100 tasks</b><span class="ms-coin__sub">Earned')
    expect(out).not.toContain('Centuria')
  })

  it('a seen milestone stays earned in the strip', async () => {
    mem.set('principia.milestones.v1', JSON.stringify({ co_a: { hundred: '2026-10-01T00:00:00Z' } }))
    await withState({ tone: 'plain' })
    const { MilestoneStrip } = await import('./MilestoneStrip')
    expect(html(createElement(MilestoneStrip, { companyId: 'co_a' }))).toContain('100 tasks</b><span class="ms-coin__sub">Earned')
  })

  it('the toast: Latin plus meaning in playful, "Milestone: …" in plain, coin at 28 px, plain for screen readers', async () => {
    const { MilestoneToastView } = await import('./MilestoneStrip')
    const item = { id: 1, companyId: 'co_a', key: 'firstPost' as const }
    const playful = html(createElement(MilestoneToastView, { item, tone: 'playful', onClose: () => {} }))
    expect(playful).toContain('Veni, vidi, vici.')
    expect(playful).toContain('width="28"')
    expect(playful).toContain('<span class="rm-sr">Milestone: first post approved.</span>')
    const plain = html(createElement(MilestoneToastView, { item, tone: 'plain', company: 'Sunday Bakery', onClose: () => {} }))
    expect(plain).toContain('Milestone: first post approved.')
    expect(plain).not.toContain('Veni')
    expect(plain).toContain('width="28"')
    expect(plain).toContain('Sunday Bakery')
  })
})

/** Every element in a rendered tree (function components with no hooks are expanded by calling them). */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out)
    return out
  }
  if (!isValidElement(node)) return out
  out.push(node)
  const props = node.props as { children?: ReactNode }
  walk(props.children, out)
  return out
}

describe('Settings → General: Tone and Agent names and busts (VOICE.md §3.8)', () => {
  beforeEach(() => updateSettings.mockClear())

  it('renders the rows with the §3.8 copy', async () => {
    const { VoiceRows } = await import('../../views/SettingsView')
    const out = html(createElement(VoiceRows, { tone: 'playful', personas: true }))
    expect(out).toContain('Tone')
    expect(out).toContain('Playful adds warm copy, Latin with translations and a short launch ceremony.')
    expect(out).toMatch(/aria-checked="true"[^>]*>Playful</)
    expect(out).toContain('>Plain<')
    expect(out).toContain('Agent names and busts')
    expect(out).toContain('Give each agent a Roman name and a bust. The role is always shown.')
    expect(out).toContain('role="switch" aria-checked="true"')
  })

  it('the toggles call updateSettings with tone and personas', async () => {
    const { VoiceRows } = await import('../../views/SettingsView')
    const { Segmented, Switch } = await import('../ui')
    const tree = (VoiceRows as (p: { tone: 'playful' | 'plain'; personas: boolean }) => ReactElement)({ tone: 'playful', personas: true })
    const els = walk(tree)
    const seg = els.find((e) => e.type === Segmented)!.props as { onChange: (v: string) => void }
    const sw = els.find((e) => e.type === Switch)!.props as { onChange: (v: boolean) => void; checked: boolean }
    seg.onChange('plain')
    expect(updateSettings).toHaveBeenLastCalledWith({ tone: 'plain' })
    seg.onChange('playful')
    expect(updateSettings).toHaveBeenLastCalledWith({ tone: 'playful' })
    expect(sw.checked).toBe(true)
    sw.onChange(false)
    expect(updateSettings).toHaveBeenLastCalledWith({ personas: false })
  })
})

describe('Portfolio (VOICE.md §3.8, §5.3, §5.6, §5.8)', () => {
  beforeEach(() => vi.resetModules())

  it('a cloud ask shows in All mode too (CLOUD.md §0.1: one inbox), counted with the rest, and no "Nothing needs you" above it', async () => {
    await withState({ companies: [company('co_a', 'Sunday Bakery'), company('co_b', 'Acme Studio')], extra: { activeCompanyId: 'all' } })
    const { resetCloud } = await import('../../state/cloud')
    resetCloud({
      state: { linked: true, url: 'https://cloud.example.com', workspace: { id: 'ws', name: 'cloud' }, deviceId: 'd', encryption: true, online: true, offlineSince: null, lastSyncAt: null, error: null, cloudCompanyIds: ['co_a'], cloudScheduleIds: [], openAsks: 1, login: null },
      asks: [{ id: 'cask_1', companyId: 'co_a', runId: 'crun_1', agentName: 'Marcus · Copywriter', question: 'Ship the launch post today or Thursday?', options: ['Today', 'Thursday'], createdAt: '2026-10-21T06:12:00Z', status: 'open', answer: null }]
    })
    const { PortfolioView } = await import('../../views/PortfolioView')
    const out = html(createElement(PortfolioView))
    expect(out).toContain('From your cloud')
    expect(out).toContain('Ship the launch post today or Thursday?')
    expect(out).toContain('>Thursday<')
    expect(out).not.toContain('Nothing needs you.')
    resetCloud()
  })

  it('no business yet: the coin mosaic, portfolio.empty and the CTA', async () => {
    await withState({ companies: [company('co_personal', 'Personal', { system: 'personal' })], extra: { activeCompanyId: 'all' } })
    const { PortfolioView } = await import('../../views/PortfolioView')
    const out = html(createElement(PortfolioView))
    expect(out).toContain('rm-mosaic--coin')
    expect(out).toContain('Run agents for each of your businesses, each with its own keys, repos and Passport.')
    expect(out).toContain('Set up your first business')
  })

  it('several businesses: cards with the card tablet (seal 36) and a medallion; section header unchanged', async () => {
    await withState({ companies: [company('co_a', 'Sunday Bakery'), company('co_b', 'Acme Studio'), company('co_personal', 'Personal', { system: 'personal' })], extra: { activeCompanyId: 'all' } })
    const { PortfolioView } = await import('../../views/PortfolioView')
    const out = html(createElement(PortfolioView))
    expect(out).toContain('rm-pp--card') // the line-art passport (VOICE.md §5.3; was the travertine rm-tablet)
    // interpuncts are their own --rm-ln-2 span now (VOICE.md §5.3 item 4)
    expect(out).toContain('SVNDAY<span class="rm-pp__dot">·</span>')
    expect(out).toContain('rm-medallion')
    expect(out).toContain('Needs you across companies')
    expect(out).toContain('Nothing needs you.')
    await withState({ tone: 'plain', companies: [company('co_a', 'Sunday Bakery'), company('co_b', 'Acme Studio')], extra: { activeCompanyId: 'all' } })
    const plain = html(createElement(PortfolioView))
    expect(plain).toContain('SUNDAY<span class="rm-pp__dot">·</span>')
    expect(plain).toContain('rm-medallion')
    expect(plain).not.toContain('Otium')
  })

  it('a healthy company: the card medallion wears the laurel, with the meaning in text', async () => {
    await withState({
      companies: [company('co_a', 'Sunday Bakery'), company('co_b', 'Acme Studio')],
      tasks: [task('1', { status: 'done', agentId: 'agt_copy' })],
      extra: { activeCompanyId: 'all', companyAgents: [copywriter] }
    })
    const { PortfolioView } = await import('../../views/PortfolioView')
    const out = html(createElement(PortfolioView))
    expect(out).toContain('<span class="rm-sr">All agents healthy</span>')
    // a paused agent: not healthy, no laurel
    await withState({
      companies: [company('co_a', 'Sunday Bakery'), company('co_b', 'Acme Studio')],
      extra: { activeCompanyId: 'all', companyAgents: [{ ...copywriter, pausedAt: '2026-10-20T00:00:00Z' }] }
    })
    expect(html(createElement(PortfolioView))).not.toContain('All agents healthy')
  })
})
