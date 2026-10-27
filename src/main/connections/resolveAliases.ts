import { foldAliases, keyAliases } from '../../shared/services'

/** Dashboards keep reading keys by name; a missing canonical name falls back to its older alias (POSTHOG_API_KEY). */
export function resolveWithAliases(resolve: (names: string[], companyId: string) => Record<string, string>, names: string[], companyId: string): Record<string, string> {
  const extra = names.flatMap((n) => keyAliases(n))
  if (!extra.length) return resolve(names, companyId)
  return foldAliases(names, resolve([...new Set([...names, ...extra])], companyId))
}
