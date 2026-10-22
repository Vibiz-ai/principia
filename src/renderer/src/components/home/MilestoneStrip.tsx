/**
 * VOICE.md §7: milestones on Home and as toasts.
 * - MilestoneStrip: the Home "Milestones" strip of a focused company (header plain in both tones). Coins are engraved
 *   rims around a pixel-mosaic glyph (VOICE.md §5.9): earned = white tiles with one accent tile, label in
 *   --text-primary; locked = a dashed rim with empty tile outlines, label in --text-secondary (app.css .ms-coin).
 *   In playful only the freshest milestone (earned in
 *   the last week, featuredMilestone) carries its badge name (Latin, with the plain name under it); every other coin
 *   shows the plain name, so the strip never reads as a wall of Latin. Coins stay in both tones.
 * - MilestoneWatcher: mounted once in App. One toast per company per newly earned milestone, with the coin at 28 px
 *   (below 40 px the coin draws its line glyph, since 2 px tiles don't read).
 *   Seen state is saveJson(MILESTONES_KEY). On the very first run there is no record yet: what is already earned is
 *   recorded silently, so an existing company never gets a burst of eight toasts for its history.
 *
 * The task-done toast (VOICE.md §3.7 toast.task.done) is emitted by the inspector's Approve as done, through
 * lib/taskDoneToast.ts (Bene factum on the day's first, playful only).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Id } from '@shared/types'
import type { CompanyPassport } from '@shared/company'
import { MilestoneCoin } from '../roman'
import { SectionHeader } from '../ui'
import { MILESTONE_COPY, milestoneName, milestoneToast, t, useTone, type MilestoneKey, type Tone } from '../../lib/voice'
import { earned, featuredMilestone, markSeen, MILESTONE_KEYS, MILESTONES_KEY, newlyEarned, parseSeen, shownEarned, type MilestoneState, type SeenMap } from '../../lib/milestones'
import { loadJson, saveJson, useStore } from '../../state/store'

// ---------- seen state: localStorage plus a tiny subscription, so the strip updates when the watcher records ----------

const listeners = new Set<() => void>()
let seenCache: { raw: unknown; map: SeenMap } | null = null
function readRaw(): unknown {
  return loadJson<unknown>(MILESTONES_KEY, null)
}
export function getSeen(): SeenMap {
  const raw = readRaw()
  // loadJson parses a fresh object each call: cache on the serialized value so useSyncExternalStore sees a stable ref
  const key = JSON.stringify(raw ?? null)
  if (!seenCache || JSON.stringify(seenCache.raw ?? null) !== key) seenCache = { raw, map: parseSeen(raw) }
  return seenCache.map
}
function writeSeen(next: SeenMap): void {
  saveJson(MILESTONES_KEY, next)
  seenCache = { raw: next, map: next }
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
function useSeen(): SeenMap {
  return useSyncExternalStore(subscribe, getSeen, getSeen)
}

/** The store slices the milestone rules read (full company rows: the watcher needs names and flags too). */
function useMilestoneState(): Omit<MilestoneState, 'companies'> & { companies: CompanyPassport[] } {
  const companies = useStore((s) => s.companies)
  const tasks = useStore((s) => s.tasks)
  const companyAgents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const onboardingStatus = useStore((s) => s.onboardingStatus)
  const companyOverview = useStore((s) => s.companyOverview)
  return useMemo(
    () => ({ companies, tasks, companyAgents, departments, onboardingStatus, companyOverview }),
    [companies, tasks, companyAgents, departments, onboardingStatus, companyOverview]
  )
}

// ---------- the strip ----------

/**
 * The visible label under a coin. It is aria-hidden as a whole: the strip item carries a plain `rm-sr` line
 * ("First task done, earned"), so a screen reader hears each milestone once, never the Latin.
 */
export function MilestoneLabel({ k, got, tone }: { k: MilestoneKey; got: boolean; tone: Tone }): React.JSX.Element {
  const m = MILESTONE_COPY[k]
  if (tone !== 'playful')
    return (
      <span className="ms-coin__label" aria-hidden="true">
        <b className="ms-coin__name">{m.plain}</b>
        <span className="ms-coin__sub">{got ? 'Earned' : 'Locked'}</span>
      </span>
    )
  const name = milestoneName(k, tone)
  return (
    // the Latin badge keeps its literal translation at hand (VOICE.md §1: Latin always comes with its English)
    <span className="ms-coin__label" aria-hidden="true" title={name.latin ? `${name.latin.la} · ${name.latin.en}` : undefined}>
      <b className="ms-coin__name" lang={name.latin ? 'la' : undefined}>
        {name.text}
      </b>
      <span className="ms-coin__sub">
        {m.plain}
        {got ? '' : ' · locked'}
      </span>
    </span>
  )
}

export function MilestoneStrip({ companyId }: { companyId: Id }): React.JSX.Element | null {
  const tone = useTone()
  const state = useMilestoneState()
  const seen = useSeen()
  const got = useMemo(() => shownEarned(companyId, earned(companyId, state), seen), [companyId, state, seen])
  // one playful badge on the strip: the freshest milestone, for a week (VOICE.md §1); the other coins read plain
  const featured = useMemo(() => (tone === 'playful' ? featuredMilestone(companyId, got, seen) : null), [tone, companyId, got, seen])
  if (!state.companies.some((c) => c.id === companyId)) return null
  return (
    <section className="ms-strip" aria-label={t.sr('home.milestones')}>
      <SectionHeader title={t('home.milestones', undefined, tone)} count={<span className="text-tertiary">{`${got.size} of ${MILESTONE_KEYS.length}`}</span>} />
      <ul className="ms-strip__grid">
        {MILESTONE_KEYS.map((k) => {
          const on = got.has(k)
          return (
            <li key={k} className={`ms-coin ${on ? 'is-earned' : 'is-locked'}`}>
              <MilestoneCoin glyph={MILESTONE_COPY[k].glyph} earned={on} size={56} />
              <MilestoneLabel k={k} got={on} tone={k === featured ? tone : 'plain'} />
              {/* the accessible name: plain, with the state */}
              <span className="rm-sr">{`${MILESTONE_COPY[k].plain}, ${on ? 'earned' : 'locked'}`}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------- the toasts ----------

interface MilestoneToastItem {
  id: number
  companyId: Id
  key: MilestoneKey
}
const TOAST_MS = 6500
/** After boot, wait for the task, agent and onboarding loads before judging what is new. */
const SETTLE_MS = 4000
let toastSeq = 0

export function MilestoneToastView({ item, tone, company, onClose }: { item: MilestoneToastItem; tone: Tone; company?: string; onClose: () => void }): React.JSX.Element {
  const m = MILESTONE_COPY[item.key]
  const shown = milestoneToast(item.key, tone)
  const plain = milestoneToast(item.key, 'plain').text
  return (
    <div className="ms-toast">
      <MilestoneCoin glyph={m.glyph} earned size={28} />
      <div className="ms-toast__body">
        <div className="ms-toast__text" aria-hidden="true">
          {shown.latin && (
            <>
              <span className="rm-latin" lang="la">{`${shown.latin.la}.`}</span>{' '}
            </>
          )}
          {shown.text}
        </div>
        {company && <div className="ms-toast__co" aria-hidden="true">{company}</div>}
        <span className="rm-sr">{company ? `${plain} ${company}.` : plain}</span>
      </div>
      <button type="button" className="ms-toast__close" aria-label="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
  )
}

export function MilestoneWatcher(): React.JSX.Element | null {
  const ready = useStore((s) => s.ready && s.companiesLoaded)
  const tone = useTone()
  const state = useMilestoneState()
  const multi = state.companies.filter((c) => !c.system && !c.archivedAt).length > 1
  const [armed, setArmed] = useState(false)
  const [toasts, setToasts] = useState<MilestoneToastItem[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    if (!ready || armed) return
    const id = setTimeout(() => setArmed(true), SETTLE_MS)
    return () => clearTimeout(id)
  }, [ready, armed])
  useEffect(() => {
    const set = timers.current
    return () => {
      for (const id of set) clearTimeout(id)
      set.clear()
    }
  }, [])

  useEffect(() => {
    if (!armed) return
    const first = readRaw() === null
    let seen = getSeen()
    const at = new Date().toISOString()
    const fresh: MilestoneToastItem[] = []
    for (const c of state.companies) {
      if (c.system || c.archivedAt) continue
      const now = earned(c.id, state)
      const add = newlyEarned(c.id, now, seen)
      if (!add.length) continue
      if (!first) for (const key of add) fresh.push({ id: ++toastSeq, companyId: c.id, key })
      seen = markSeen(seen, c.id, add, at)
    }
    if (first || seen !== getSeen()) writeSeen(seen)
    if (!fresh.length) return
    setToasts((l) => [...l, ...fresh].slice(-4))
    for (const f of fresh) {
      const id = setTimeout(() => {
        timers.current.delete(id)
        setToasts((l) => l.filter((x) => x.id !== f.id))
      }, TOAST_MS)
      timers.current.add(id)
    }
  }, [armed, state])

  if (!toasts.length) return null
  return (
    <div className="ms-toasts" aria-live="polite">
      {toasts.map((item) => (
        <MilestoneToastView
          key={item.id}
          item={item}
          tone={tone}
          company={multi ? state.companies.find((c) => c.id === item.companyId)?.name : undefined}
          onClose={() => setToasts((l) => l.filter((x) => x.id !== item.id))}
        />
      ))}
    </div>
  )
}
