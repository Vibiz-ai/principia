/** Fenced blocks and tool chatter never go into an automatic post or a team_activity summary. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function stepSummary(output: string, max: number): string {
  const text = output
    .replace(/```[a-z-]*\n[\s\S]*?```/gi, ' ')
    .replace(/<\/?principia-[^>]*>/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return clip(text, max)
}
