/**
 * Five doors (design.md §2-3, pm-review step 1): the one navigation model. The sidebar, ⌘1-⌘5, the app menu, the
 * palette and the window title all read their labels from here, so they can never disagree. Pure: no store, no IPC.
 *
 * - PRIMARY: the five doors, fixed order, ⌘1-⌘5 in every mode.
 * - MORE: everything else, one click away in the More popover, pinnable into PINNED.
 * - SETTINGS_PAGES: once-ever setup (Keys, Cloud, Company) lives in Settings sections, not the nav.
 * - resolveView: old route names (Agents, Canvas, Passport, Keys…) and the new door names both land on a real view.
 */
import type { Id, NavVisibility, SidebarPrefs } from '@shared/types'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import type { ActiveCompany } from './companyModel'
import type { SettingsSection, ViewState } from '../state/store'

export type DoorKey = 'home' | 'team' | 'board' | 'chats' | 'knowledge'
export type MoreKey = 'automations' | 'addons' | 'files' | 'forum' | 'slack' | 'plans' | 'activity' | 'spend'
export type MoreGroup = 'Automate' | 'Work' | 'Insight'

export interface Door {
  key: DoorKey
  label: string
  icon: string
  kbd: string
  /** the palette's one-line hint */
  desc: string
  /** old names and words people search with (palette synonyms) */
  aliases: string[]
}

export interface MoreItem {
  key: MoreKey
  label: string
  icon: string
  group: MoreGroup
  desc: string
  defaultVisibility: NavVisibility
  aliases: string[]
  /** listed only when this holds (Plans: its experimental flag) */
  requires?: 'plans'
}

export const PRIMARY: readonly Door[] = [
  { key: 'home', label: 'Home', icon: 'home', kbd: '⌘1', desc: 'What needs you, and what is running', aliases: ['dashboard', 'needs you', 'portfolio'] },
  { key: 'team', label: 'Team', icon: 'agents', kbd: '⌘2', desc: 'Departments and the agents in them', aliases: ['agents', 'departments', 'people', 'staff', 'roster'] },
  { key: 'board', label: 'Board', icon: 'board', kbd: '⌘3', desc: 'Every task and where it is', aliases: ['tasks', 'kanban', 'todo', 'issues'] },
  { key: 'chats', label: 'Chats', icon: 'chat', kbd: '⌘4', desc: 'Conversations and live sessions', aliases: ['agents', 'sessions', 'session', 'terminal', 'running', 'live', 'chat'] },
  { key: 'knowledge', label: 'Knowledge', icon: 'knowledge', kbd: '⌘5', desc: 'What your agents know about the business', aliases: ['passport', 'memory', 'notes', 'vault', 'brand voice'] }
]

export const MORE_GROUPS: readonly MoreGroup[] = ['Automate', 'Work', 'Insight']

export const MORE: readonly MoreItem[] = [
  { key: 'automations', label: 'Automations', icon: 'refresh', group: 'Automate', desc: 'Schedules, workflows and Slack triggers', defaultVisibility: 'hidden', aliases: ['schedules', 'workflows', 'autopilots', 'cron', 'triggers'] },
  { key: 'addons', label: 'Add-ons', icon: 'addons', group: 'Automate', desc: 'Workflows and skills to install', defaultVisibility: 'hidden', aliases: ['marketplace', 'skills', 'catalog'] },
  { key: 'files', label: 'Files', icon: 'file', group: 'Work', desc: 'Everything your agents saved', defaultVisibility: 'hidden', aliases: ['artifacts', 'outputs', 'documents'] },
  // pm-review C8: Forum is never pinned by default; it shows in PINNED while a thread has something for you
  { key: 'forum', label: 'Forum', icon: 'forum', group: 'Work', desc: 'Agents talking to each other', defaultVisibility: 'active', aliases: ['channels', 'threads', 'agent talk'] },
  { key: 'slack', label: 'Slack', icon: 'slack', group: 'Work', desc: 'Your Slack, mirrored for agents', defaultVisibility: 'hidden', aliases: [] },
  { key: 'plans', label: 'Plans', icon: 'plans', group: 'Work', desc: 'Goals broken into milestones (beta)', defaultVisibility: 'hidden', aliases: ['goals', 'milestones'], requires: 'plans' },
  { key: 'activity', label: 'Activity', icon: 'activity', group: 'Insight', desc: 'Live map and history of runs', defaultVisibility: 'hidden', aliases: ['canvas', 'runs', 'history', 'graph'] },
  { key: 'spend', label: 'Spend', icon: 'coins', group: 'Insight', desc: 'Plan use and cost per agent', defaultVisibility: 'hidden', aliases: ['usage', 'cost', 'tokens', 'money', 'billing', 'disk'] }
]

/** Settings sections that used to be nav items or palette-only pages. */
export interface SettingsPage {
  section: SettingsSection
  label: string
  desc: string
  aliases: string[]
}
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { section: 'company', label: 'Company settings', desc: 'Name, colour, logo, repositories, export', aliases: ['company', 'profile', 'rename company', 'linear', 'linear sync', 'repositories'] },
  { section: 'connections', label: 'Connections', desc: 'Tools this company’s agents can use: Slack, Notion, GitHub, Stripe…', aliases: ['connections', 'connect', 'integrations', 'mcp', 'tools', 'slack', 'notion', 'github', 'stripe'] },
  { section: 'keys', label: 'Keys & secrets', desc: 'Secrets this company’s agents use, like STRIPE_SECRET_KEY', aliases: ['keys', 'api key', 'api keys', 'env', 'environment variables', 'secrets', 'token'] },
  { section: 'agents', label: 'AI providers', desc: 'Claude, Codex and other CLIs, profiles and their API keys (every company)', aliases: ['ai providers', 'providers', 'api key', 'api keys', 'anthropic', 'openai', 'claude', 'codex', 'model', 'cli'] },
  { section: 'cloud', label: 'Cloud sync', desc: 'Agents online while your Mac sleeps', aliases: ['cloud', 'principia cloud', 'pairing'] }
]

export function doorByKey(key: DoorKey): Door {
  return PRIMARY.find((d) => d.key === key)!
}
export function moreByKey(key: string): MoreItem | undefined {
  return MORE.find((m) => m.key === key)
}

// ---------- routes ----------

/** New door / More names that are aliases of an existing view. */
export type AliasName = 'board' | 'knowledge' | 'activity' | 'files' | 'spend' | 'addons' | 'automations'
export type NavTarget = ViewState | { name: AliasName }

/** The view a door or More item opens. */
export function viewFor(key: DoorKey | MoreKey, nonce = Date.now()): ViewState {
  switch (key) {
    case 'home':
      return { name: 'home' }
    case 'team':
      return { name: 'team' }
    case 'board':
      return { name: 'tasks' }
    case 'chats':
      return { name: 'chats' }
    case 'knowledge':
      return { name: 'passport', nonce }
    case 'automations':
      return { name: 'schedules' }
    case 'addons':
      return { name: 'marketplace' }
    case 'files':
      return { name: 'artifacts' }
    case 'forum':
      return { name: 'forum', nonce }
    case 'slack':
      return { name: 'slack', nonce }
    case 'plans':
      return { name: 'plans' }
    case 'activity':
      return { name: 'canvas' }
    case 'spend':
      return { name: 'usage' }
  }
}

/**
 * Old routes stay as aliases (deep links, notifications, the app menu, muscle memory): Agents opens Chats on Live;
 * Keys, Cloud and Company Settings open their Settings section; the new door names open the view they mount.
 */
export function resolveView(v: NavTarget): ViewState {
  switch (v.name) {
    case 'board':
      return { name: 'tasks' }
    case 'knowledge':
      return viewFor('knowledge')
    case 'activity':
      return { name: 'canvas' }
    case 'files':
      return { name: 'artifacts' }
    case 'spend':
      return { name: 'usage' }
    case 'addons':
      return { name: 'marketplace' }
    case 'automations':
      return { name: 'schedules' }
    case 'agents':
      return { name: 'chats', filter: 'live' }
    case 'keys':
      return { name: 'settings', section: 'keys' }
    case 'cloud':
      return { name: 'settings', section: 'cloud' }
    case 'company':
      return { name: 'settings', section: 'company', companyId: v.companyId, create: v.create, nonce: v.nonce }
    default:
      return v
  }
}

/** Which door, More item or Settings a view belongs to: the sidebar highlights it, the title names it. */
export function navKeyOf(view: Pick<ViewState, 'name'>): DoorKey | MoreKey | 'settings' | null {
  switch (view.name) {
    case 'home':
    case 'portfolio':
      return 'home'
    case 'team':
    case 'department':
    case 'agentSeat':
      return 'team'
    case 'tasks':
      return 'board'
    case 'chats':
    case 'agents':
    case 'session':
      return 'chats'
    case 'passport':
    case 'memory':
      return 'knowledge'
    case 'schedules':
    case 'workflows':
    case 'editor':
      return 'automations'
    case 'marketplace':
      return 'addons'
    case 'artifacts':
      return 'files'
    case 'forum':
      return 'forum'
    case 'slack':
      return 'slack'
    case 'plans':
      return 'plans'
    case 'canvas':
    case 'run':
      return 'activity'
    case 'usage':
      return 'spend'
    case 'settings':
    case 'keys':
    case 'cloud':
    case 'company':
      return 'settings'
    default:
      return null
  }
}

/** Toolbar / window titles in nav words (App.tsx TITLES). */
export const VIEW_TITLES: Record<ViewState['name'], string> = {
  home: 'Home',
  portfolio: 'All companies',
  team: 'Team',
  department: 'Department',
  agentSeat: 'Agent',
  tasks: 'Board',
  plans: 'Plans',
  chats: 'Chats',
  agents: 'Chats',
  session: 'Chat',
  passport: 'Knowledge',
  memory: 'Knowledge',
  schedules: 'Automations',
  workflows: 'Automations',
  editor: 'Workflow',
  marketplace: 'Add-ons',
  artifacts: 'Files',
  forum: 'Forum',
  slack: 'Slack',
  canvas: 'Activity',
  run: 'Run',
  usage: 'Spend',
  settings: 'Settings',
  keys: 'Keys & secrets',
  cloud: 'Cloud sync',
  company: 'Company settings'
}

/** ⌘1-⌘5: the doors, the same in Personal, focused and All companies mode. */
export function doorForDigit(digit: number): DoorKey | null {
  return PRIMARY[digit - 1]?.key ?? null
}

// ---------- pins and visibility (persisted per company in settings.sidebarNav) ----------

/**
 * The settings.sidebarNav key: the focused company's id, or 'all'. A Personal-only user (no rail, `multi` false) is
 * in Personal even though the effective focus reads 'all', so their pins stay Personal's after they add a company.
 */
export function prefsKey(active: ActiveCompany, multi = true): string {
  return multi ? active : PERSONAL_COMPANY_ID
}
export function prefsFor(all: Record<string, SidebarPrefs> | undefined, active: ActiveCompany, multi = true): SidebarPrefs {
  return all?.[prefsKey(active, multi)] ?? {}
}

export function visibilityOf(prefs: SidebarPrefs, key: string): NavVisibility {
  return prefs.visibility?.[key] ?? moreByKey(key)?.defaultVisibility ?? 'hidden'
}
export function isPinned(prefs: SidebarPrefs, ref: string): boolean {
  if (ref.startsWith('dept:')) return !!prefs.pins?.includes(ref)
  return visibilityOf(prefs, ref) === 'always'
}

/** Set a More item's visibility; Always show also appends it to the pin order, anything else drops it. */
export function setVisibility(prefs: SidebarPrefs, key: string, v: NavVisibility): SidebarPrefs {
  const def = moreByKey(key)?.defaultVisibility ?? 'hidden'
  const visibility = { ...(prefs.visibility ?? {}) }
  if (v === def) delete visibility[key]
  else visibility[key] = v
  const pins = (prefs.pins ?? []).filter((p) => p !== key)
  if (v === 'always') pins.push(key)
  return compact({ pins, visibility })
}

/**
 * The pin in More and "Unpin" in PINNED. A More item flips between Always show and its resting state (Hidden, or
 * Show when active when that is its default, so unpinning Forum returns it to "Show when active", never Hidden).
 * A `dept:<id>` ref toggles in the pin list.
 */
export function togglePin(prefs: SidebarPrefs, ref: string): SidebarPrefs {
  if (ref.startsWith('dept:')) {
    const pins = prefs.pins ?? []
    return compact({ ...prefs, pins: pins.includes(ref) ? pins.filter((p) => p !== ref) : [...pins, ref] })
  }
  const def = moreByKey(ref)?.defaultVisibility ?? 'hidden'
  if (isPinned(prefs, ref)) return setVisibility(prefs, ref, def === 'always' ? 'hidden' : def)
  return setVisibility(prefs, ref, 'always')
}

function compact(p: SidebarPrefs): SidebarPrefs {
  const out: SidebarPrefs = {}
  if (p.pins?.length) out.pins = p.pins
  if (p.visibility && Object.keys(p.visibility).length) out.visibility = p.visibility
  return out
}

export interface PinnedContext {
  /** More items with something for you right now (Forum: a mention or DM) */
  active: ReadonlySet<string>
  /** a More item may be listed at all (Plans needs its flag) */
  available: (key: MoreKey) => boolean
  /** a pinned department still exists in this company */
  department?: (id: Id) => boolean
}

/**
 * What PINNED lists, in order: pinned refs in pin order (Always show), then Show-when-active items that are active.
 * Unknown keys, unavailable items and departments that are gone are skipped, never shown broken.
 */
export function pinnedRefs(prefs: SidebarPrefs, ctx: PinnedContext): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (ref: string): void => {
    if (seen.has(ref)) return
    seen.add(ref)
    out.push(ref)
  }
  for (const ref of prefs.pins ?? []) {
    if (ref.startsWith('dept:')) {
      if (!ctx.department || ctx.department(ref.slice(5))) add(ref)
      continue
    }
    const m = moreByKey(ref)
    if (m && ctx.available(m.key) && visibilityOf(prefs, ref) === 'always') add(ref)
  }
  // Always-show items set without a pin order (older prefs) still show, after the ordered ones
  for (const m of MORE) if (ctx.available(m.key) && visibilityOf(prefs, m.key) === 'always') add(m.key)
  for (const m of MORE) if (ctx.available(m.key) && visibilityOf(prefs, m.key) === 'active' && ctx.active.has(m.key)) add(m.key)
  return out
}

/** Where the More popover sits: beside its row, moved up so its bottom stays 8px inside the window, never above 8px. */
export function morePopoverBox(anchorTop: number, height: number, viewport: number): { top: number; maxHeight: number } {
  const maxHeight = Math.max(0, viewport - 16)
  const top = Math.max(8, Math.min(anchorTop - 8, viewport - Math.min(height, maxHeight) - 8))
  return { top, maxHeight }
}

/** The More popover's rows, grouped, unavailable items left out. */
export function moreGroups(available: (key: MoreKey) => boolean): { group: MoreGroup; items: MoreItem[] }[] {
  return MORE_GROUPS.map((group) => ({ group, items: MORE.filter((m) => m.group === group && available(m.key)) })).filter((g) => g.items.length > 0)
}

/** The palette's "Go to" rows: label = the nav label, search text includes the old names. */
export interface GoToEntry {
  id: string
  label: string
  hint: string
  icon: string
  kbd?: string
  keywords: string
  /** old names typed exactly ("schedules", "canvas") make this the top hit (lib/paletteRank) */
  exact: string[]
  target: { door: DoorKey } | { more: MoreKey } | { settings: SettingsSection }
}
export function goToEntries(available: (key: MoreKey) => boolean): GoToEntry[] {
  return [
    ...PRIMARY.map<GoToEntry>((d) => ({ id: `v:${d.key}`, label: d.label, hint: d.desc, icon: d.icon, kbd: d.kbd, keywords: d.aliases.join(' '), exact: d.aliases, target: { door: d.key } })),
    ...MORE.filter((m) => available(m.key)).map<GoToEntry>((m) => ({ id: `v:${m.key}`, label: m.label, hint: m.desc, icon: m.icon, keywords: m.aliases.join(' '), exact: m.aliases, target: { more: m.key } })),
    ...SETTINGS_PAGES.map<GoToEntry>((p) => ({ id: `v:set:${p.section}`, label: p.label, hint: `Settings · ${p.desc}`, icon: p.section === 'keys' ? 'keys' : p.section === 'cloud' ? 'globe' : p.section === 'connections' ? 'link' : 'settings', keywords: p.aliases.join(' '), exact: p.aliases, target: { settings: p.section } }))
  ]
}
