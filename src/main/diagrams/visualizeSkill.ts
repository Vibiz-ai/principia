/**
 * DIAGRAMS.md §6: `/visualize <what>` inside a Claude Code chat pane. Principia writes one skill under its own data
 * folder (never ~/.claude, never the founder's checkout) and adds that folder to the chats it starts with
 * `--add-dir`; Claude Code loads `.claude/skills` from added folders as plain, unnamespaced commands. A plugin
 * (`--plugin-dir`) would only give `/principia:visualize`.
 *
 * The skill is user-invoked only (`disable-model-invocation`), so its description costs no tokens until the founder
 * types it. It expands to "Draw <what> as a principia-graph." plus a one-line format reminder, so resumed chats
 * (which never get the system-prompt note again) still know the format.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DIAGRAM_FENCE, TASK_STATUSES } from '../../shared/diagram'

let skillRoot: string | null = null

export const VISUALIZE_SKILL = `---
name: visualize
description: Draw something as a Principia diagram (a ${DIAGRAM_FENCE} block)
argument-hint: <what to draw>
disable-model-invocation: true
---
Draw $ARGUMENTS as a ${DIAGRAM_FENCE}.

Answer with one fenced \`\`\`${DIAGRAM_FENCE} block of JSON: {"title","direction":"right"|"down","nodes":[{"id","kind","label","detail"?,"status"?,"group"?: id of a group node}],"edges":[{"from","to","kind"?,"label"?}],"steps"?:[{"title","focus":[ids],"text"}]}. Node kinds: client service database queue storage external person function file decision note task milestone metric group. Edge kinds: flow call data async depends blocks. Task status: ${TASK_STATUSES.join(' ')}. Every step's focus names at least one node. No coordinates. Keep it under 40 nodes unless asked, and add a short sentence of context around it.
`

/** Writes (or refreshes) the skill; idempotent. A failure only means /visualize is missing in new chats. */
export function installVisualizeSkill(userData: string): string | null {
  const root = path.join(userData, 'claude-skills')
  try {
    const dir = path.join(root, '.claude', 'skills', 'visualize')
    fs.mkdirSync(dir, { recursive: true })
    writeIfChanged(path.join(dir, 'SKILL.md'), VISUALIZE_SKILL)
    skillRoot = root
  } catch {
    skillRoot = null
  }
  return skillRoot
}

function writeIfChanged(file: string, text: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return
  } catch {
    /* new file */
  }
  fs.writeFileSync(file, text, { mode: 0o600 })
}

/** claude interactive args: `--add-dir <root>` once installed, else nothing (tests, failed install). */
export const visualizeSkillArgs = (): string[] => (skillRoot ? ['--add-dir', skillRoot] : [])

/** Tests only. */
export const resetVisualizeSkill = (): void => {
  skillRoot = null
}
