/**
 * SOUNDS.md: the three sounds, synthesized with WebAudio (no audio files). Main decides when one plays
 * (src/main/chime.ts, chime:play); Settings › Notifications previews them through playChime too.
 * - done: a soft rising fifth (E5 → B5), ~550 ms;
 * - needs: two gentle taps on one bell tone (A5, A5), ~450 ms;
 * - problem: a low, muted falling third (E4 → C4), ~600 ms.
 * Sine voices with a faint overtone, a 6–10 ms attack and an exponential tail, through a low-pass: soft, never a beep.
 * The OS volume and mute apply as for any sound.
 */
import type { ChimeKind } from '@shared/types'

interface Note {
  /** Hz */
  f: number
  /** start, seconds after now */
  at: number
  /** tail length, seconds */
  decay: number
  /** relative loudness */
  gain: number
}
interface Voice {
  notes: Note[]
  /** overtone ratio and its loudness relative to the note */
  overtone: [number, number]
  /** low-pass cutoff, Hz */
  cutoff: number
}

export const CHIME_VOICES: Record<ChimeKind, Voice> = {
  done: {
    notes: [
      { f: 659.25, at: 0, decay: 0.32, gain: 0.8 },
      { f: 987.77, at: 0.11, decay: 0.44, gain: 1 }
    ],
    overtone: [2, 0.12],
    cutoff: 5200
  },
  needs: {
    notes: [
      { f: 880, at: 0, decay: 0.2, gain: 0.85 },
      { f: 880, at: 0.16, decay: 0.3, gain: 0.7 }
    ],
    overtone: [2.76, 0.08],
    cutoff: 4200
  },
  problem: {
    notes: [
      { f: 329.63, at: 0, decay: 0.3, gain: 0.9 },
      { f: 261.63, at: 0.16, decay: 0.44, gain: 1 }
    ],
    overtone: [2, 0.06],
    cutoff: 1600
  }
}
/** The loudest a sound gets at volume 1 (modest: these sit under music and calls). */
const PEAK = 0.32

let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** Plays one sound now. volume 0..1 (perceptual: squared). Returns false when audio is unavailable. */
export function playChime(kind: ChimeKind, volume: number): boolean {
  const v = CHIME_VOICES[kind]
  const a = audio()
  if (!v || !a) return false
  const level = PEAK * Math.min(1, Math.max(0, volume)) ** 2
  if (level <= 0) return true
  const t0 = a.currentTime + 0.01
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = v.cutoff
  lp.connect(a.destination)
  let end = t0
  for (const n of v.notes) {
    const start = t0 + n.at
    const stop = start + n.decay + 0.05
    end = Math.max(end, stop)
    for (const [ratio, rel] of [[1, 1], v.overtone] as const) {
      const osc = a.createOscillator()
      const g = a.createGain()
      osc.type = 'sine'
      osc.frequency.value = n.f * ratio
      g.gain.setValueAtTime(0, start)
      g.gain.linearRampToValueAtTime(level * n.gain * rel, start + (ratio === 1 ? 0.008 : 0.006))
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.decay)
      osc.connect(g)
      g.connect(lp)
      osc.start(start)
      osc.stop(stop)
    }
  }
  setTimeout(() => lp.disconnect(), Math.ceil((end - a.currentTime) * 1000) + 100)
  // dev only (the dev server is http, a packaged app is file:): lets a QA run see that the sound really went out
  if (location.protocol.startsWith('http')) console.info(`[chime] played ${kind} volume=${volume} audio=${a.state}`)
  return true
}
