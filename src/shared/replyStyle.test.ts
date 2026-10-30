import { describe, expect, it } from 'vitest'
import { agentChatBrief } from './agentChat'
import { NEXT_STEP, REPLY_STYLE, isNextStepLabel } from './replyStyle'

describe('REPLY_STYLE', () => {
  it('asks for the answer first, blank lines between paragraphs and the next step last', () => {
    expect(REPLY_STYLE).toContain('Answer first')
    expect(REPLY_STYLE).toContain('blank line between paragraphs')
    expect(REPLY_STYLE).toContain(`**${NEXT_STEP}**`)
  })

  it('is in the agent chat brief', () => {
    expect(agentChatBrief({ name: 'Decimus', role: 'Repo auditor', company: 'Acme', department: null, instructions: '', auto: false })).toContain(REPLY_STYLE)
  })
})

describe('isNextStepLabel', () => {
  it('takes the label the rules ask for, however the agent cased it', () => {
    for (const label of [NEXT_STEP, 'Next step', 'next steps:', ' NEXT STEP: ']) expect(isNextStepLabel(label)).toBe(true)
  })

  it('leaves other bold leads alone', () => {
    for (const label of ['Note:', 'Next', 'Next step for me:']) expect(isNextStepLabel(label)).toBe(false)
  })
})
