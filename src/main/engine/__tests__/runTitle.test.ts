/** QA: board task runs were titled by their raw `<principia-role …>` frame on the canvas and in the Memory run filter. */
import { describe, expect, it } from 'vitest'
import { framedPromptTitle } from '../index'
import { buildResumePrompt, buildTaskPrompt } from '../../company/taskPrompt'
import { buildReplyPrompt } from '../../forum/responder'

describe('framedPromptTitle', () => {
  it('a plain prompt is its own title source', () => {
    expect(framedPromptTitle('  Write the weekly report  ')).toBe('Write the weekly report')
  })
  it('a task turn is named by its task title, never the frame', () => {
    const prompt = buildTaskPrompt({
      companyId: 'co_a', department: { name: 'Development' } as never, agent: { name: 'Engineer', instructions: 'Build things.' } as never,
      task: { identifier: 'PRN-3', title: 'Add search', source: 'manual', sourceUrl: null, description: 'Find notes' } as never,
      deps: [], activity: [], wake: ['Start'], running: []
    } as never)
    expect(prompt.startsWith('<principia-role')).toBe(true)
    expect(framedPromptTitle(prompt)).toBe('Add search')
  })
  it('a framed prompt without a task block takes the first text outside the frames', () => {
    expect(framedPromptTitle('<principia-role agent="Scout">\nYou scout.\n</principia-role>\n\nThe message for you:\n- m1 @ana: hi')).toBe('The message for you:')
    expect(framedPromptTitle(buildResumePrompt(['go on'])).startsWith('<principia')).toBe(false)
  })
  it('a Forum reply (one plain line, then frames) is named by that line, never its role frame', () => {
    const p = buildReplyPrompt({ seat: { name: 'Copywriter', instructions: 'Write.' }, department: 'Marketing', me: 'marcus', channel: '#general', messages: [{ ref: 'm1', author: 'you', text: 'hi' }], thread: [], replyTo: 'm1' })
    expect(framedPromptTitle(p)).toBe('Forum reply in #general')
    expect(framedPromptTitle('Line one\nline two')).toBe('Line one\nline two')
  })
})
