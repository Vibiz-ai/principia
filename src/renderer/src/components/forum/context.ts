/** The Forum view's shared context: who is who, and the actions a message row can take (FORUM.md §8). */
import { createContext, useContext } from 'react'
import type { ForumChannel, ForumMember, ForumMessage, ForumRef } from '@shared/forum'
import type { MemberDisplay } from './Avatar'

export interface ForumCtx {
  companyId: string
  me: ForumMember | null
  members: ForumMember[]
  channels: ForumChannel[]
  display: (memberId: string) => MemberDisplay | null
  byHandle: (handle: string) => ForumMember | null
  /** member ids with a running step (busts get the blue tessera) */
  working: ReadonlySet<string>
  openThread: (m: ForumMessage) => void
  openChannel: (channelId: string) => void
  openRef: (ref: ForumRef, from: ForumMessage) => void
  react: (m: ForumMessage, emoji: string) => void
  edit: (m: ForumMessage) => void
  remove: (m: ForumMessage) => void
  toTask: (m: ForumMessage) => void
  answer: (m: ForumMessage, answer: string) => Promise<boolean>
  decide: (m: ForumMessage, decision: 'approve' | 'reject') => void
  copyRef: (m: ForumMessage) => void
}

export const ForumContext = createContext<ForumCtx | null>(null)
export function useForumCtx(): ForumCtx {
  const c = useContext(ForumContext)
  if (!c) throw new Error('ForumContext missing')
  return c
}
