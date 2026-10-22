/**
 * VOICE.md §8: the launch ceremony, *Alea iacta est*. Playful tone only, after Start now resolved (actions.ts start()
 * sets `ceremony`), before the flow closes. Plain tone and "I'll review first" never get here.
 *
 * Two tools only, on the flat near-black layer (rgba(20, 21, 23, .96), no warm gradient): line art drawing in, and a
 * pixel-mosaic laurel assembling in white and blue tiles.
 * F0 stage (0–500 ms): the layer fades in; the line-art arch (ArchFrame at .2) draws itself behind the centre.
 * F1 mosaic (300–1100 ms): the pixel wreath (pixelWreath(), through the same Mosaic as the empty states) appears tile
 *   by tile around each branch from the ribbon up, 28 ms apart (`steps(1)` opacity, no flying, no scaling).
 * F2 seal (900–1600 ms): the company's line laurel roundel (96 px) draws: rings, beads, leaves, initial, accent tessera.
 * F3 words (1500–2300 ms): "Alea iacta est." in Cinzel (--text-primary), then the English sub line.
 * F4 team (2300 ms + 450 ms × n): line busts (80) on drawn plinths rise one by one: lettered name, role, first task.
 * F5 enter: "Go to {name}" (↵), and the autopilot line. Never auto-advances.
 *
 * Skippable at any time: Skip (top right, focused first), Esc (the flow's key handler) or the CTA, all through
 * finishCeremony() (close + enterCompany). role="dialog"; a polite live region reads the plain lines (t.sr); the Latin is
 * aria-hidden and its translation is the visible sub line. With reduced motion every frame shows at once, static: no
 * animation classes are rendered at all.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '../../components/ui'
import { ArchFrame, Mosaic, Seal, pixelWreath } from '../../components/roman'
import { latinLine, t, useCopy, usePersonasOn } from '../../lib/voice'
import { useStore } from '../../state/store'
import { finishCeremony, installedAdapters, useFlowLocal } from './actions'
import { TeamPlinth, useReducedMotion } from './bits'
import { ceremonyLabel, ceremonyLines, ceremonyTeam, launchFacts, presetFor } from './model'

/** §8 timings (ms). `tileStep` is the pixel wreath's per-tile stagger (roman.css `.rm-tile`, 28 ms). */
export const CER = { arch: 0, tiles: 300, tileStep: 28, seal: 900, words: 1500, sub: 1800, team: 2300, perAgent: 450 } as const

/** The F1 pixel-mosaic wreath (white outer and blue inner leaves, open at the top) and its reveal order. */
export const WREATH = pixelWreath()
/** Rendered width of the wreath (px); the seal sits in its open centre. */
export const WREATH_PX = 196
/** The seal inside the wreath (px). */
export const SEAL_PX = 96

const deptColorOf = (key: Parameters<typeof presetFor>[0] | null): string | null => (key ? (presetFor(key)?.color ?? null) : null)

const delay = (ms: number): CSSProperties => ({ ['--rm-delay' as string]: `${ms}ms` })

export function Ceremony({ color }: { color?: string }): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const status = useStore((s) => s.onboardingStatus)
  const result = useFlowLocal((s) => s.result)
  const copy = useCopy()
  const personasOn = usePersonasOn()
  const reduced = useReducedMotion()
  const [anim] = useState(() => !reduced)
  const skipRef = useRef<HTMLButtonElement>(null)
  // the live region fills just after mount, so screen readers announce it (content present at insertion often isn't)
  const [say, setSay] = useState(false)
  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true })
    const id = setTimeout(() => setSay(true), 120)
    return () => clearTimeout(id)
  }, [])

  const plan = d?.plan?.value
  if (!d || !plan) return null
  const name = d.answers.name.trim() || 'your business'
  const journal = status?.journal && status.journal.id === d.journalId ? status.journal : null
  // what the launch really made (as on Ready): no agents created means no plinths and no autopilot line
  const team = ceremonyTeam(plan, personasOn, launchFacts(result?.steps ?? journal?.steps))
  // with no agent CLI installed Start now leaves Autopilot off (main), so there is no autopilot line to show
  const autoCount = installedAdapters(status).length ? team.filter((m) => m.auto).length : 0
  const alea = latinLine('cer.title', 'playful')
  const lines = ceremonyLines(team, name)
  const enterAt = CER.team + CER.perAgent * team.length + 150
  const cls = (base: string, motion: string): string => (anim ? `${base} ${motion}` : base)

  return (
    <div className={anim ? 'ob-cer ob-cer--anim' : 'ob-cer'} role="dialog" aria-modal="true" aria-label={ceremonyLabel(name, team.length === 0)}>
      <button ref={skipRef} type="button" className="ob-cer__skip" onClick={() => void finishCeremony()} title="Skip (Esc)">
        {copy('cer.skip')}
      </button>
      <div className="ob-sr" aria-live="polite">
        {say ? lines.join(' ') : ''}
      </div>

      {/* F0: the line-art arch frames the centre, drawing itself (columns first, then the arch and keystone) */}
      <ArchFrame className="ob-cer__arch" opacity={0.2} draw={anim} style={anim ? delay(CER.arch) : undefined} />

      <div className="ob-cer__in">
        {/* F1–F2: the pixel-mosaic wreath assembling, the line roundel drawing inside it */}
        <div className="ob-cer__medal" aria-hidden>
          <Mosaic
            className="ob-cer__wreath"
            tiles={WREATH.tiles}
            order={WREATH.order}
            anim={anim}
            width={WREATH_PX}
            viewWidth={WREATH.cols * WREATH.pitch}
            viewHeight={WREATH.rows * WREATH.pitch}
            style={anim ? delay(CER.tiles) : undefined}
          />
          <Seal className="ob-cer__seal" name={d.answers.name} color={color} size={SEAL_PX} pressed draw={anim} />
        </div>

        {/* F3: the words */}
        {alea && (
          <div className={cls('ob-cer__alea', 'rm-letters-in')} lang="la" aria-hidden style={anim ? delay(CER.words) : undefined}>
            {alea.la}.
          </div>
        )}
        <div className={cls('ob-cer__sub', 'rm-rise')} style={anim ? delay(CER.sub) : undefined}>
          {team.length ? copy('cer.sub') : copy('cer.sub.none', { name })}
        </div>

        {/* F4: the team */}
        {team.length > 0 && (
          <div className="ob-cer__team" aria-hidden>
            {team.map((m, i) => (
              <TeamPlinth
                key={m.ref}
                member={m}
                color={deptColorOf(plan.agents.find((a) => a.ref === m.ref)?.departmentKey ?? null)}
                size={80}
                role={m.role}
                className={cls('ob-cer__plinth', 'rm-rise')}
                style={anim ? delay(CER.team + i * CER.perAgent) : undefined}
              >
                {m.firstTask && (
                  <div className="rm-plinth__task" title={m.firstTask}>
                    {t('ob.plan.agent.firstTask', { task: m.firstTask })}
                  </div>
                )}
              </TeamPlinth>
            ))}
          </div>
        )}

        {/* F5: enter */}
        <div className={cls('ob-cer__enter', 'rm-rise')} style={anim ? delay(enterAt) : undefined}>
          <Button variant="primary" kbd="↵" onClick={() => void finishCeremony()}>
            {copy('cer.cta', { name })}
          </Button>
          {autoCount > 1 && <div className="ob-cer__auto">{copy('cer.autopilot', { count: autoCount })}</div>}
        </div>
      </div>
    </div>
  )
}
