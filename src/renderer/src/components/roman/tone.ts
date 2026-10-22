/**
 * The Roman components take an explicit `tone` when the caller has one (tests, previews); otherwise they follow
 * Settings → Tone through the copy module. One switch, VOICE.md promise 2.
 */
import { useTone, type Tone } from '../../lib/voice'

export function useToneProp(tone?: Tone): Tone {
  const current = useTone()
  return tone ?? current
}
