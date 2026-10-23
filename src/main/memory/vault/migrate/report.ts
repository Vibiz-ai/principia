// Migration report (PASSPORT.md §9 step 6): what a dry run would write, or what a real run wrote, per company. The
// same shape feeds the `memory:vault migrate` answer, the one-time banner and the main-process log.

import type { VaultMigrationReport } from '../../../../shared/passport'

export type CompanyReport = VaultMigrationReport['companies'][number]

export function emptyCompanyReport(companyId: string, name: string): CompanyReport {
  return { companyId, name, hubNote: false, repoNotes: 0, entityNotes: 0, observations: 0, historyLines: 0, proposals: 0 }
}

/** Anything for this run to write in this company (the hub note existing is not a write). */
export function companyHasWork(c: CompanyReport): boolean {
  return c.repoNotes + c.entityNotes + c.observations + c.historyLines + c.proposals > 0
}

export function buildReport(input: {
  dryRun: boolean
  backupPath: string | null
  companies: CompanyReport[]
  events: number
  /** hub lines (profile observations, product ghosts) and repo notes count as writes but not as v1 totals */
  extraWrites: number
  /** a previous run left a migration.json behind */
  migratedBefore: boolean
  warnings: string[]
}): VaultMigrationReport {
  const sum = (k: 'entityNotes' | 'observations' | 'historyLines' | 'proposals') => input.companies.reduce((n, c) => n + c[k], 0)
  const totals = { entityNotes: sum('entityNotes'), observations: sum('observations'), historyLines: sum('historyLines'), proposals: sum('proposals'), events: input.events }
  const writes = input.companies.some(companyHasWork) || input.events > 0 || input.extraWrites > 0
  return {
    dryRun: input.dryRun,
    alreadyMigrated: input.migratedBefore && !writes,
    backupPath: input.backupPath,
    // companies with nothing to show stay out of the banner
    companies: input.companies.filter((c) => c.hubNote || companyHasWork(c)),
    totals,
    warnings: [...new Set(input.warnings)]
  }
}

/** Plain-text summary for the log and the banner tooltip. */
export function formatReport(r: VaultMigrationReport): string {
  const head = r.alreadyMigrated
    ? 'Passport migration: already done, nothing to write.'
    : `Passport migration${r.dryRun ? ' (dry run)' : ''}: ${r.totals.entityNotes} entity notes, ${r.totals.observations} observations, ` +
      `${r.totals.historyLines} History lines, ${r.totals.proposals} proposals, ${r.totals.events} events.`
  const lines = [head]
  for (const c of r.companies) {
    lines.push(
      `- ${c.name}: ${c.hubNote ? 'hub note, ' : ''}${c.repoNotes} repo notes, ${c.entityNotes} entity notes, ${c.observations} observations, ` +
        `${c.historyLines} History lines, ${c.proposals} proposals`
    )
  }
  if (r.backupPath) lines.push(`memory.db backed up to ${r.backupPath}`)
  for (const w of r.warnings) lines.push(`! ${w}`)
  return lines.join('\n')
}
