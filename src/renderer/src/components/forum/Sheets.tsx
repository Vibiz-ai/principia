/**
 * FORUM.md §2, §6, §8: the Forum's sheets. New channel; Invite people (role, guest channels, expiry; the code is shown
 * once) with the members and pending invites; Approve a proposal (prefilled, editable); Propose; Edit a message.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ForumChannel, ForumInvite, ForumInviteRole, ForumMember, ForumMessage } from '@shared/forum'
import { channelSlug } from '@shared/forum'
import { Button, Field, Segmented, Sheet } from '../ui'
import { MemberAvatar, type MemberDisplay } from './Avatar'
import { attempt, toast, useStore } from '../../state/store'
import { hive } from '../../lib/hive'

export function NewChannelSheet({ companyId, members, display, onDone, onCancel }: { companyId: string; members: ForumMember[]; display: (id: string) => MemberDisplay | null; onDone: (c: ForumChannel) => void; onCancel: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const slug = channelSlug(name)
  const valid = /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)
  const create = async () => {
    const c = await attempt(() => hive.forum.createChannel({ companyId, name: slug, kind, purpose: purpose.trim() || undefined, memberIds: [...picked] }), 'Create channel')
    if (c) onDone(c)
  }
  return (
    <Sheet title="New channel" onCancel={onCancel} onPrimary={() => void create()} primaryLabel="Create" primaryDisabled={!valid} width={520}>
      <Field label="Name" hint={name && slug !== name ? `Will be #${slug}` : 'Lowercase, dashes; e.g. launch-week'} error={name && !valid ? '2-40 letters, digits or dashes' : undefined}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="launch-week" data-autofocus />
      </Field>
      <Field label="Purpose" hint="Agents read it before they post here">
        <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What this channel is for" maxLength={300} />
      </Field>
      <Field label="Visibility">
        <Segmented
          items={[
            { value: 'public', label: 'Public' },
            { value: 'private', label: 'Private' }
          ]}
          value={kind}
          onChange={setKind}
          size="sm"
        />
      </Field>
      <Field label="Add" align="start" hint="Agents join their department channel by themselves; add them here for anything else.">
        <div className="fm-pick">
          {members
            .filter((m) => m.status === 'active' && m.role !== 'owner')
            .map((m) => (
              <label key={m.id} className={`fm-pick__item ${picked.has(m.id) ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={picked.has(m.id)}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s)
                      if (n.has(m.id)) n.delete(m.id)
                      else n.add(m.id)
                      return n
                    })
                  }
                />
                <MemberAvatar display={display(m.id)} size={18} />
                <span>{display(m.id)?.name ?? m.name}</span>
                <span className="fm-pick__role">{display(m.id)?.role}</span>
              </label>
            ))}
        </div>
      </Field>
    </Sheet>
  )
}

const EXPIRY = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '0', label: 'Never' }
] as const

export function InviteSheet({ companyId, channels, members, display, onCancel }: { companyId: string; channels: ForumChannel[]; members: ForumMember[]; display: (id: string) => MemberDisplay | null; onCancel: () => void }): React.JSX.Element {
  const [role, setRole] = useState<ForumInviteRole>('member')
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]['value']>('7')
  const [uses, setUses] = useState(1)
  const [scope, setScope] = useState<Set<string>>(new Set())
  const [made, setMade] = useState<ForumInvite | null>(null)
  const [invites, setInvites] = useState<ForumInvite[]>([])
  const reload = () => void hive.forum.invites({ companyId }).then(setInvites, () => {})
  useEffect(reload, [companyId])
  const named = channels.filter((c) => c.name && !c.archivedAt)
  const create = async () => {
    const inv = await attempt(() => hive.forum.invite({ companyId, role, label: label.trim() || undefined, expiresInDays: Number(expiry), maxUses: uses, ...(role === 'guest' ? { channelIds: [...scope] } : {}) }), 'Create invite')
    if (inv) {
      setMade(inv)
      reload()
    }
  }
  const copy = (text: string) => void hive.clipboard.writeText({ text }).then(() => toast('Copied'))
  const people = members.filter((m) => m.kind !== 'agent')
  return (
    <Sheet title="Invite people" onCancel={onCancel} onPrimary={made ? onCancel : () => void create()} primaryLabel={made ? 'Done' : 'Create invite'} primaryDisabled={!made && role === 'guest' && scope.size === 0} width={560}>
      {made ? (
        <div className="fm-invite-made">
          <div className="fm-invite-made__kicker">Invite code · shown once</div>
          <div className="fm-invite-made__code">{made.code}</div>
          <div className="fm-invite-made__actions">
            <Button size="sm" icon="copy" onClick={() => copy(made.code!)}>
              Copy code
            </Button>
            <Button size="sm" icon="link" onClick={() => copy(made.link!)}>
              Copy link
            </Button>
          </div>
          <p className="fm-invite-made__note">
            {made.role === 'guest' ? 'A guest sees only the channels you picked.' : `Joins as ${made.role}.`} {made.expiresAt ? `Expires ${new Date(made.expiresAt).toLocaleDateString()}.` : 'Never expires.'} Principia keeps only a fingerprint of the
            code. Today it is redeemed on this Mac; across machines once hosted sync is on.
          </p>
        </div>
      ) : (
        <>
          <Field label="Role">
            <Segmented
              items={[
                { value: 'member', label: 'Member' },
                { value: 'guest', label: 'Guest' },
                { value: 'admin', label: 'Admin' }
              ]}
              value={role}
              onChange={setRole}
              size="sm"
            />
          </Field>
          <Field label="For" hint="A name or an email, so you recognise the invite later">
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ana Ruiz, designer" maxLength={120} data-autofocus />
          </Field>
          {role === 'guest' && (
            <Field label="Channels" align="start" hint="Guests see these channels and nothing else. Agents never message guests.">
              <div className="fm-pick">
                {named.map((c) => (
                  <label key={c.id} className={`fm-pick__item ${scope.has(c.id) ? 'is-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={scope.has(c.id)}
                      onChange={() =>
                        setScope((s) => {
                          const n = new Set(s)
                          if (n.has(c.id)) n.delete(c.id)
                          else n.add(c.id)
                          return n
                        })
                      }
                    />
                    <span>#{c.name}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field label="Expires">
            <Segmented items={EXPIRY.map((e) => ({ ...e }))} value={expiry} onChange={setExpiry} size="sm" />
          </Field>
          <Field label="Uses">
            <input className="input fm-uses" type="number" min={1} max={100} value={uses} onChange={(e) => setUses(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </Field>
        </>
      )}
      <div className="fm-members">
        <div className="fm-members__heading">People ({people.filter((m) => m.status === 'active').length})</div>
        {people.map((m) => (
          <div key={m.id} className={`fm-members__row ${m.status !== 'active' ? 'is-off' : ''}`}>
            <MemberAvatar display={display(m.id)} size={20} />
            <span className="fm-members__name">{m.name}</span>
            <span className="fm-members__handle">@{m.handle}</span>
            <span className="fm-role">{m.role}</span>
            {m.status === 'active' && m.role !== 'owner' && (
              <button className="fm-link-btn" onClick={() => void attempt(() => hive.forum.membership({ op: 'remove', memberId: m.id }), 'Remove member')}>
                Remove
              </button>
            )}
            {m.status === 'removed' && <span className="fm-members__status">removed</span>}
          </div>
        ))}
        {invites.length > 0 && <div className="fm-members__heading">Invites</div>}
        {invites.slice(0, 12).map((i) => (
          <div key={i.id} className={`fm-members__row ${i.status !== 'active' ? 'is-off' : ''}`}>
            <span className="fm-members__code">…{i.codeHint}</span>
            <span className="fm-members__name">{i.label || 'Unnamed invite'}</span>
            <span className="fm-role">{i.role}</span>
            <span className="fm-members__status">
              {i.status}
              {i.status === 'active' && i.maxUses > 1 ? ` · ${i.uses}/${i.maxUses}` : ''}
            </span>
            {i.status === 'active' && (
              <button className="fm-link-btn" onClick={() => void attempt(() => hive.forum.revokeInvite({ inviteId: i.id }), 'Revoke invite').then(reload)}>
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  )
}

/** Approve a proposal: the agent's draft, editable. `title` / `primaryLabel`: a conversation's hire card says "Create & bring in". */
export function DecideSheet({ m, onCancel, onDone, title, primaryLabel }: { m: ForumMessage; onCancel: () => void; onDone: () => void; title?: string; primaryLabel?: string }): React.JSX.Element {
  const p = m.proposal!
  const departments = useStore((s) => s.departments.filter((d) => d.companyId === m.companyId && !d.archivedAt))
  const profiles = useStore((s) => s.profiles.filter((x) => x.adapter !== 'shell'))
  const [name, setName] = useState(p.department?.name ?? '')
  const [does, setDoes] = useState(p.department?.does ?? '')
  const [doesNot, setDoesNot] = useState(p.department?.doesNot ?? '')
  const [role, setRole] = useState(p.agent?.role ?? '')
  const [dep, setDep] = useState<string>(p.agent?.departmentKey ?? '')
  const [instructions, setInstructions] = useState(p.agent?.instructions ?? '')
  const [capabilities, setCapabilities] = useState(p.agent?.capabilities ?? '')
  const preferred = useMemo(() => profiles.find((x) => x.adapter === (p.agent?.adapter ?? 'claude')) ?? profiles[0], [profiles, p.agent?.adapter])
  const [profileId, setProfileId] = useState(preferred?.id ?? '')
  const approve = async () => {
    const edits = p.kind === 'department' ? { name, does, doesNot } : { role, departmentKey: dep || null, instructions, capabilities, ...(profileId ? { profileId } : {}) }
    const r = await attempt(() => hive.forum.decide({ messageId: m.id, decision: 'approve', edits }), 'Approve proposal')
    if (r) {
      toast(p.kind === 'department' ? `${name} is a department now` : `${role} hired`)
      onDone()
    }
  }
  const ok = p.kind === 'department' ? !!name.trim() : !!role.trim() && !!profileId
  return (
    <Sheet title={title ?? (p.kind === 'department' ? 'Approve: new department' : 'Approve: new agent')} onCancel={onCancel} onPrimary={() => void approve()} primaryLabel={primaryLabel ?? (p.kind === 'department' ? 'Create department' : 'Hire')} primaryDisabled={!ok} width={560}>
      <p className="fm-sheet-why">{p.reason}</p>
      {p.kind === 'department' ? (
        <>
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-autofocus />
          </Field>
          <Field label="Does" align="start">
            <textarea className="input fm-textarea" value={does} onChange={(e) => setDoes(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Does not" align="start" hint="Agents route work by this charter">
            <textarea className="input fm-textarea" value={doesNot} onChange={(e) => setDoesNot(e.target.value)} maxLength={300} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Role">
            <input className="input" value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} data-autofocus />
          </Field>
          <Field label="Department">
            <select className="input" value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">Company level</option>
              {departments.map((d) => (
                <option key={d.id} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Profile" hint="Adapter, model and keys come from the profile. Autonomy starts manual.">
            <select className="input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Instructions" align="start">
            <textarea className="input fm-textarea fm-textarea--tall" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={4000} />
          </Field>
          <Field label="Capabilities" align="start">
            <textarea className="input fm-textarea" value={capabilities} onChange={(e) => setCapabilities(e.target.value)} maxLength={400} />
          </Field>
        </>
      )}
    </Sheet>
  )
}

/** /propose from a human: posts a proposal card in the channel for discussion. */
export function ProposeSheet({ companyId, channel, kind: initial, onCancel, onDone }: { companyId: string; channel: ForumChannel; kind: 'department' | 'agent' | null; onCancel: () => void; onDone: () => void }): React.JSX.Element {
  const [kind, setKind] = useState<'department' | 'agent'>(initial ?? 'department')
  const [title, setTitle] = useState('')
  const [reason, setReason] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const departments = useStore((s) => s.departments.filter((d) => d.companyId === companyId && !d.archivedAt))
  const [dep, setDep] = useState(channel.system === 'department' ? (departments.find((d) => d.id === channel.departmentId)?.key ?? '') : '')
  const send = async () => {
    const proposal =
      kind === 'department'
        ? { kind, reason, department: { name: title, does: a, doesNot: b } }
        : { kind, reason, agent: { departmentKey: dep || null, role: title, instructions: a, capabilities: b } }
    const r = await attempt(() => hive.forum.post({ companyId, channelId: channel.id, text: reason, proposal }), 'Propose')
    if (r) onDone()
  }
  return (
    <Sheet title="Propose" onCancel={onCancel} onPrimary={() => void send()} primaryLabel="Post proposal" primaryDisabled={!title.trim() || reason.trim().length < 3} width={540}>
      <Field label="Kind">
        <Segmented
          items={[
            { value: 'department', label: 'New department' },
            { value: 'agent', label: 'New agent' }
          ]}
          value={kind}
          onChange={setKind}
          size="sm"
        />
      </Field>
      <Field label={kind === 'department' ? 'Name' : 'Role'}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'department' ? 'Growth' : 'SEO writer'} maxLength={80} data-autofocus />
      </Field>
      {kind === 'agent' && (
        <Field label="Department">
          <select className="input" value={dep} onChange={(e) => setDep(e.target.value)}>
            <option value="">Company level</option>
            {departments.map((d) => (
              <option key={d.id} value={d.key}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Why" align="start">
        <textarea className="input fm-textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={600} />
      </Field>
      <Field label={kind === 'department' ? 'Does' : 'Instructions'} align="start">
        <textarea className="input fm-textarea" value={a} onChange={(e) => setA(e.target.value)} maxLength={kind === 'department' ? 300 : 4000} />
      </Field>
      <Field label={kind === 'department' ? 'Does not' : 'Capabilities'} align="start">
        <textarea className="input fm-textarea" value={b} onChange={(e) => setB(e.target.value)} maxLength={kind === 'department' ? 300 : 400} />
      </Field>
    </Sheet>
  )
}

export function EditSheet({ m, onCancel, onDone }: { m: ForumMessage; onCancel: () => void; onDone: () => void }): React.JSX.Element {
  const [text, setText] = useState(m.text)
  const save = async () => {
    const r = await attempt(() => hive.forum.edit({ messageId: m.id, text }), 'Edit message')
    if (r) onDone()
  }
  return (
    <Sheet title="Edit message" onCancel={onCancel} onPrimary={() => void save()} primaryDisabled={!text.trim() || text === m.text} width={560}>
      <textarea className="input fm-textarea fm-textarea--tall" value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
    </Sheet>
  )
}
