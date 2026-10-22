/**
 * The department slot of the Passport brief (DEPARTMENTS.md §7) before the vault: pure, shared by the static profile
 * renderer (company/scope.ts) and the vault brief (brief.ts) so both say the same thing in the same place.
 */
import type { PassportDepartment } from '../../shared/passport'

/** DEPARTMENTS.md §7: the department slot's size (about 600 chars, heading included). */
export const DEPARTMENT_SLOT_CHARS = 600
/**
 * The department slot before the vault (or with the vault off, or a note with nothing to say): `## [[Marketing]]
 * (department)` then `contextFallback`, then the charter while it fits. [] when there is nothing to say.
 */
export function departmentFallbackLines(d: PassportDepartment, maxChars = DEPARTMENT_SLOT_CHARS, head = `## [[${(d.passportNote || d.name).replace(/[[\]|#^\n]/g, ' ').trim()}]] (department)`): string[] {
  const body = [
    ...d.contextFallback.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean),
    ...(d.charter.does.trim() ? [`Does: ${d.charter.does.replace(/\s+/g, ' ').trim()}`] : []),
    ...(d.charter.doesNot.trim() ? [`Does not: ${d.charter.doesNot.replace(/\s+/g, ' ').trim()}`] : [])
  ]
  if (!body.length) return []
  const out = [head]
  let used = head.length + 1
  for (const l of body) {
    const room = maxChars - used - 1
    if (room <= 1) break
    const line = l.length > room ? `${l.slice(0, room - 1).trimEnd()}…` : l
    out.push(line)
    used += line.length + 1
  }
  return out.length > 1 ? out : []
}
