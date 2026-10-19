/**
 * Workflow input values (CONTRACT §14, typed boolean inputs). Pure, no Node or DOM imports; used by main, the engine
 * and the renderer so every path agrees on what a boolean input accepts and what "dry run" means.
 *
 * Boolean inputs are stored and templated as the strings 'true' / 'false'. Any other value is refused (never guessed):
 * a typo in a free-text dry_run once meant a real push.
 */
import type { ValidationError, WorkflowInput } from './types'

export const BOOLEAN_VALUES = ['true', 'false'] as const

/** Input names that mean "do not push / do not change anything remote". */
export const DRY_RUN_NAME = /^dry[_-]?run$/i
export const isDryRunName = (name: string): boolean => DRY_RUN_NAME.test(name)

/**
 * Input names that read like an on/off switch. A push or PR step gated on such an input must use type 'boolean'
 * (hive_workflow_validate rejects a free-text one).
 */
export const FLAG_NAME = /^(dry[_-]?run|no[_-]?push|skip[_-]?push|push|do[_-]?push|allow[_-]?push|confirm(ed)?|live|apply|force|real[_-]?run|publish)$|^(is|should|enable|disable|allow|skip|no)[_-]/i

export const isBooleanValue = (v: unknown): v is 'true' | 'false' => v === 'true' || v === 'false'

/** The value a boolean input runs with: given value, else its default, else 'false'. null = not true/false (refuse). */
export function booleanValue(def: Pick<WorkflowInput, 'default'>, given: string | undefined): 'true' | 'false' | null {
  const v = given !== undefined && given !== '' ? given : def.default !== undefined && def.default !== '' ? def.default : 'false'
  return isBooleanValue(v) ? v : null
}

/** Errors for boolean inputs whose effective value is not exactly 'true' or 'false'. */
export function inputValueErrors(defs: WorkflowInput[], values: Record<string, string> | null | undefined): ValidationError[] {
  const out: ValidationError[] = []
  for (const d of defs ?? []) {
    if (d.type !== 'boolean') continue
    const given = values?.[d.name]
    if (booleanValue(d, given) === null) {
      const shown = given !== undefined && given !== '' ? given : (d.default ?? '')
      out.push({ path: 'inputs', message: `Input "${d.name}" is a checkbox: its value must be true or false (got "${shown.slice(0, 40)}")` })
    }
  }
  return out
}

/** true when a boolean dry-run input resolves to 'true' for these values. */
export function isDryRun(defs: WorkflowInput[], values: Record<string, string> | null | undefined): boolean {
  return (defs ?? []).some((d) => d.type === 'boolean' && isDryRunName(d.name) && booleanValue(d, values?.[d.name]) === 'true')
}
