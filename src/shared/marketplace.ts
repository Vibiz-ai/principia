import type { AdapterId, Id } from './types'

/**
 * Marketplace: a catalog of things to install into Hive. Hive ships a built-in catalog (resources/marketplace) and
 * can also read one remote index (Settings › Marketplace URL, an https link to an index.json, e.g. a raw GitHub URL).
 *
 * - workflow: a .hive.json file, imported like Workflows › Import (nothing runs until you run it)
 * - script: the same, for a workflow of deterministic steps only (python / node / shell, no agents)
 * - agent: a Claude Code subagent (.md) installed to ~/.claude/agents/<id>.md
 * - skill: a Claude Code skill (SKILL.md) installed to ~/.claude/skills/<id>/SKILL.md
 */
export const MARKET_KINDS = ['workflow', 'script', 'agent', 'skill'] as const
export type MarketKind = (typeof MARKET_KINDS)[number]
export type MarketSource = 'builtin' | 'remote'

/** One entry of an index.json. `path` is relative to the index (or an absolute https URL in a remote index). */
export interface MarketIndexItem {
  id: string // slug, unique per index; the install name for agents and skills
  kind: MarketKind
  name: string
  description: string
  tags?: string[]
  author?: string
  /** Vault keys the item uses (shown as "needs KEY"; missing ones link to Keys). */
  keys?: string[]
  /** Agent CLIs it needs besides Claude (e.g. a room with Codex). */
  adapters?: AdapterId[]
  path: string
}

export interface MarketIndex {
  hive: 'marketplace'
  version: 1
  name?: string
  items: MarketIndexItem[]
}

export interface MarketItem extends Omit<MarketIndexItem, 'path'> {
  source: MarketSource
  /** Set when already installed: the agent/skill file exists, or a workflow with this name exists. */
  installed: boolean
}

export interface MarketList {
  items: MarketItem[]
  /** The remote index URL in use (null = built-in only). */
  remoteUrl: string | null
  /** Why the remote index could not be read; the built-in catalog is still listed. */
  remoteError: string | null
}

export interface MarketRef {
  source: MarketSource
  id: string
}

/** What installing will do, shown before the user confirms. */
export interface MarketPreview {
  item: MarketItem
  /** Where an agent/skill is written; null for workflows. */
  target: string | null
  /** Agent / skill: the file as it will be written. Workflow: null (see `nodes`). */
  text: string | null
  nodes: { id: string; type: string; label: string; command: string | null; prompt?: string }[]
  /** An agent/skill file already exists at `target` and would be replaced. */
  overwrites: boolean
}

export type MarketInstallResult = { kind: 'workflow' | 'script'; workflowId: Id } | { kind: 'agent' | 'skill'; path: string }
