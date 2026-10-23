import { describe, expect, it } from 'vitest'
import { localDay, taskDoneToast } from './taskDoneToast'

const NOW = new Date(2026, 9, 21, 14, 5)

describe('taskDoneToast (VOICE.md §3.7)', () => {
  it('names the persona and the task; the Latin rides only the first toast of the day, in playful', () => {
    const first = taskDoneToast({ persona: 'Marcus', task: 'Draft 3 launch posts', identifier: 'PRN-14' }, 'playful', null, NOW)
    expect(first.text).toBe('Marcus finished “Draft 3 launch posts”.')
    expect(first.latin).toEqual({ la: 'Bene factum', en: 'Well done' })
    expect(first.shownDay).toBe('2026-10-21')
    const later = taskDoneToast({ persona: 'Marcus', task: 'Next', identifier: 'PRN-15' }, 'playful', first.shownDay!, NOW)
    expect(later.latin).toBeUndefined()
    expect(later.shownDay).toBeUndefined()
    // a new day brings it back
    expect(taskDoneToast({ persona: 'Ovid', task: 'X', identifier: 'PRN-16' }, 'playful', '2026-10-20', NOW).latin).toBeTruthy()
  })

  it('plain: same sentence, never Latin', () => {
    const r = taskDoneToast({ persona: 'Copywriter', task: 'Draft posts', identifier: 'PRN-14' }, 'plain', null, NOW)
    expect(r).toEqual({ text: 'Copywriter finished “Draft posts”.' })
  })

  it('no agent (or an empty title): the plain identifier line', () => {
    expect(taskDoneToast({ persona: null, task: 'Draft', identifier: 'PRN-14' }, 'playful', null, NOW)).toEqual({ text: 'PRN-14 is done' })
    expect(taskDoneToast({ persona: '  ', task: 'Draft', identifier: 'PRN-14' }, 'playful', null, NOW)).toEqual({ text: 'PRN-14 is done' })
    expect(taskDoneToast({ persona: 'Marcus', task: ' ', identifier: 'PRN-14' }, 'playful', null, NOW)).toEqual({ text: 'PRN-14 is done' })
  })

  it('localDay is the local calendar day', () => {
    expect(localDay(new Date(2026, 0, 3, 23, 59))).toBe('2026-01-03')
  })
})
