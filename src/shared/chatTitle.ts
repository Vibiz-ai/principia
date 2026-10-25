/** CHAT-UI.md: a chat is titled by the first thing the user said, so Chats and ⌘K find it again. Pure. */

/** A chat's first message titles its session (unless the user named it): Chats and ⌘K can find it again. */
export function chatTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? `${one.slice(0, 59).replace(/\s+\S*$/, '') || one.slice(0, 59)}…` : one
}
/** Titles SessionManager generates: "Chat · Claude", "<folder> · Claude", "<department> · Claude". */
export function isDefaultTitle(title: string, cwd: string): boolean {
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? ''
  return /^Chat · /.test(title) || (!!base && title.startsWith(`${base} · `)) || /^Claude in /.test(title)
}
