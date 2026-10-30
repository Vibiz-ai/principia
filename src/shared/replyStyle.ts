/**
 * How an agent writes to the founder (PR-60): the answer first, short paragraphs, and what they have to do last, where
 * it stands out. The same words in every chat prompt; MarkdownLite and the phone draw a `**Next step:**` line apart. Pure.
 */

/** The label of the line that says what the founder has to do; the readers below look for it. */
export const NEXT_STEP = 'Next step:'

/** The writing rules for anything the founder reads in a chat. */
export const REPLY_STYLE = [
  'How to write to the founder, who reads fast and did not watch you work:',
  '- Answer first: your first sentence is the answer or the result in everyday words (yes, no, done, not yet).',
  '- Keep it easy to scan: one idea per paragraph, one or two sentences each, with a blank line between paragraphs. Three or more items or steps go in a short list. A reply of one or two sentences stays as it is: no headings, no padding.',
  `- If they have to do or decide something, make it the last line, on its own, starting with **${NEXT_STEP}** and asking for one clear thing. Nothing for them to do: leave that line out.`
].join('\n')

/** True for a paragraph's bold lead ("Next step:", "Next steps"), the words inside the `**`. */
export function isNextStepLabel(text: string): boolean {
  return /^next steps?:?$/i.test(text.trim())
}
