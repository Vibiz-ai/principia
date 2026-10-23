/**
 * FORUM.md §2: who may do what in a company's Forum. Pure (no db): the store passes the rows, these functions answer.
 * Every refusal is a one-line message the caller shows as is (agents get it as their tool result).
 */
import type { ForumChannel, ForumInviteRole, ForumMember, ForumProposal } from '../../shared/forum'

export type ChannelLike = Pick<ForumChannel, 'id' | 'kind' | 'system' | 'archivedAt' | 'createdBy'> & { companyId: string }
export type MemberLike = Pick<ForumMember, 'id' | 'kind' | 'role' | 'status'> & { companyId: string }

const isAdmin = (m: MemberLike) => m.role === 'owner' || m.role === 'admin'
const active = (m: MemberLike) => m.status === 'active'

export type Verdict = { ok: true } | { ok: false; reason: string }
const yes: Verdict = { ok: true }
const no = (reason: string): Verdict => ({ ok: false, reason })

/** Same company and active, or the refusal. */
function base(m: MemberLike, c: { companyId: string }): Verdict {
  if (m.companyId !== c.companyId) return no('That channel is not in your company')
  if (!active(m)) return no(m.status === 'removed' ? 'You were removed from this Forum' : 'Accept your invite first')
  return yes
}

/** §2.1 read: public for everyone but guests; private, DM and group only when joined. */
export function canRead(m: MemberLike, c: ChannelLike, joined: boolean): Verdict {
  const b = base(m, c)
  if (!b.ok) return b
  if (joined) return yes
  if (c.kind === 'public' && m.kind !== 'guest') return yes
  return no(c.kind === 'public' ? 'Guests only see the channels they were invited to' : 'That conversation is private')
}

/** §2.1 post: where it can read; agents and humans auto-join a public channel they post in. Archived = read-only. */
export function canPost(m: MemberLike, c: ChannelLike, joined: boolean): Verdict {
  const r = canRead(m, c, joined)
  if (!r.ok) return r
  if (c.archivedAt) return no('This channel is archived')
  return yes
}

export function canCreateChannel(m: MemberLike, kind: 'public' | 'private'): Verdict {
  if (!active(m)) return no('You cannot create channels')
  if (m.kind === 'guest') return no('Guests cannot create channels')
  if (m.kind === 'agent' && kind !== 'public') return no('Agents create public channels only; ask a human for a private one')
  return yes
}

/** §2.1 DMs. Agents never DM guests (guests are outside the company); guests only DM people they share a channel with. */
export function canDm(from: MemberLike, to: MemberLike, shareChannel: boolean): Verdict {
  if (from.companyId !== to.companyId) return no('That person is not in your company')
  if (!active(from)) return no('You cannot send messages')
  if (to.status === 'removed') return no('That member was removed')
  if (from.kind === 'agent' && to.kind === 'guest') return no('Agents do not message guests; ask a human to')
  if (from.kind === 'guest' && !shareChannel) return no('Guests can only message people in their channels')
  if (to.kind === 'guest' && from.kind !== 'agent' && !shareChannel && !isAdmin(from)) return no('You share no channel with that guest')
  return yes
}

/** §2.2: owner invites any role, admins invite members and guests, nobody else; agents never. */
export function canInvite(m: MemberLike, role: ForumInviteRole): Verdict {
  if (m.kind === 'agent') return no('Agents cannot invite people; ask a human')
  if (!active(m)) return no('You cannot invite people')
  if (m.role === 'owner') return yes
  if (m.role === 'admin' && role !== 'admin') return yes
  return no(m.role === 'admin' ? 'Only the owner can invite admins' : 'Only the owner and admins can invite people')
}

/** Adding members to a channel: humans (not guests); agents and guests never. */
export function canAddMembers(m: MemberLike, c: ChannelLike, joined: boolean): Verdict {
  if (m.kind === 'agent') return no('Agents cannot add members; mention the person instead')
  if (m.kind === 'guest') return no('Guests cannot add members')
  if (c.kind === 'dm') return no('Start a group message instead')
  if (c.kind !== 'public' && !joined && !isAdmin(m)) return no('Join the channel first')
  return canPost(m, c, true)
}

export function canDecide(m: MemberLike, p: Pick<ForumProposal, 'status'>): Verdict {
  if (!isAdmin(m)) return no(m.kind === 'agent' ? 'Agents propose; a human decides' : 'Only the owner and admins decide proposals')
  if (p.status !== 'open') return no(`This proposal was already ${p.status}`)
  return yes
}

export function canAnswer(m: MemberLike, ask: { status: string; to: string[] }): Verdict {
  if (!active(m)) return no('You cannot answer')
  if (ask.status !== 'open') return no('This ask was already answered')
  if (isAdmin(m) || ask.to.includes(m.id)) return yes
  return no('This ask is for someone else')
}

/** Archive / edit topic: owner and admins; the human who created it. #general never archives. */
export function canManageChannel(m: MemberLike, c: ChannelLike, action: 'archive' | 'edit'): Verdict {
  if (m.kind === 'agent') return no('Agents cannot change channels')
  if (action === 'archive' && c.system === 'general') return no('#general cannot be archived')
  if (action === 'archive' && c.system === 'department') return no('Archive the department instead')
  if (isAdmin(m) || c.createdBy === m.id) return yes
  return no('Only the owner, admins or the creator can change this channel')
}

/** @here / @channel: humans that are not guests. */
export function canBroadcast(m: MemberLike): boolean {
  return m.kind === 'human' && active(m)
}

export function canRemoveMember(by: MemberLike, target: MemberLike): Verdict {
  if (!isAdmin(by)) return no('Only the owner and admins remove members')
  if (target.role === 'owner') return no('The owner cannot be removed')
  if (target.kind === 'agent') return no('Archive the agent seat instead')
  if (by.role === 'admin' && target.role === 'admin') return no('Only the owner removes admins')
  return yes
}
