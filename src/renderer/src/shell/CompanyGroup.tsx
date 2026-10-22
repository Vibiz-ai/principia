/**
 * One company's group in the All-companies sidebar (COMPANY.md §8.3): a 28px header with avatar, name and live
 * badges ("+" new session in this company, "→" enter it), then its Chats (top 5) and its repos in its own order.
 * DEPARTMENTS.md §9: with departments on, a Board row (needs-you count) and the department rows come first.
 */
import { useEffect, useRef, useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import type { Repo, Session } from '@shared/types'
import { Icon } from '../components/Icon'
import { IconButton } from '../components/ui'
import { collapseExited } from '../lib/format'
import { EMPTY_BADGE, companyLabel, nextGroupPeek, type CompanyBadge } from '../lib/company'
import { enterCompany, newSessionMenu, openChat, toggleCompanyExpanded } from '../state/store'
import { mergeBoardBadge, type LaneCounts } from '../lib/departments'
import { CompanyAvatar, CompanyBadgeMark } from './CompanyRail'
import { CloudPlacedMark } from '../components/cloud/bits'
import { CompanyDepartments } from './DepartmentGroup'

export const REPO_DRAG_TYPE = 'application/x-principia-repository'

export function CompanyGroup({
  company,
  badge,
  board,
  expanded,
  chats,
  repos,
  renderSession,
  renderRepo,
  onRepoDrop
}: {
  company: CompanyPassport
  badge: CompanyBadge | undefined
  /** DEPARTMENTS.md §9 Board counts (laneOf); undefined while departments are off */
  board?: LaneCounts
  /** persisted state; a group with needs-you shows open regardless */
  expanded: boolean
  chats: Session[]
  repos: Repo[]
  renderSession: (s: Session, indent: boolean) => React.JSX.Element
  renderRepo: (r: Repo) => React.JSX.Element
  /** a repo dragged here from another company: the parent confirms and calls company:assignRepo */
  onRepoDrop: (repoId: string) => void
}): React.JSX.Element {
  const [dropping, setDropping] = useState(false)
  // board tasks that need you open the group too (§9 "auto-expanded when something needs you")
  const shownBadge = board ? mergeBoardBadge(badge ?? EMPTY_BADGE, board) : badge
  const needsCount = shownBadge?.needsYou ?? 0
  const needs = needsCount > 0
  // needs-you auto-expands a folded group; folding it again holds until something new needs you
  const [peek, setPeek] = useState(true)
  const prevNeeds = useRef(needsCount)
  useEffect(() => {
    setPeek((p) => nextGroupPeek(p, prevNeeds.current, needsCount))
    prevNeeds.current = needsCount
  }, [needsCount])
  const open = expanded || (needs && peek)
  const toggle = (): void => {
    if (open) setPeek(false)
    toggleCompanyExpanded(company.id, !open)
  }
  const label = companyLabel(company, true)
  const shownChats = collapseExited(chats).shown.slice(0, 5)
  return (
    <section className={`co-group ${dropping ? 'is-drop' : ''}`} aria-label={label}>
      <div
        className="side-row co-group__head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={`${label}\nClick to fold · ⌥→ enters the company · drop a repository here to move it`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          } else if (e.key === 'ArrowRight' && e.altKey) {
            e.preventDefault()
            void enterCompany(company.id)
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
          e.preventDefault()
          e.stopPropagation()
          setDropping(false)
          const id = e.dataTransfer.getData(REPO_DRAG_TYPE)
          if (id && !repos.some((r) => r.id === id)) onRepoDrop(id)
        }}
      >
        <span className="side-row__twisty" aria-hidden>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
        <CompanyAvatar company={company} size={18} />
        <span className="side-row__label co-group__name">{label}</span>
        <span className="co-group__badges">
          <CompanyBadgeMark badge={shownBadge} />
          <CloudPlacedMark companyId={company.id} />
        </span>
        <span className="co-group__actions">
          <IconButton
            icon="plus"
            label={`New session in ${company.name}`}
            onClick={(e) => {
              e.stopPropagation()
              void newSessionMenu(company.id)
            }}
          />
          <IconButton
            icon="chevronRight"
            label={`Enter ${company.name}`}
            onClick={(e) => {
              e.stopPropagation()
              void enterCompany(company.id)
            }}
          />
        </span>
      </div>
      {open && (
        <div className="co-group__body">
          {board && <CompanyDepartments companyId={company.id} board={board} />}
          {shownChats.length > 0 ? (
            <>
              <div className="co-group__sub">Chats</div>
              {shownChats.map((s) => renderSession(s, true))}
            </>
          ) : (
            repos.length === 0 && (
              <div className="side-row side-row--session side-row--indent is-dim" onClick={() => void openChat(true, company.id)} title={`Start an agent in ${company.name}’s own workspace folder`}>
                <Icon name="chat" size={14} />
                <span className="side-row__label">New chat (no repo)</span>
              </div>
            )
          )}
          {repos.map(renderRepo)}
        </div>
      )}
    </section>
  )
}
