import type { AdapterId } from '../../shared/types'

/** Only terminal provider/auth errors qualify. Never search arbitrary tool output or successful assistant prose. */
export function isHarnessAuthFailure(provider: AdapterId, error: string): boolean {
  if (provider === 'shell') return false
  return /(?:^|\n)(?:Error:\s*)?(?:Not logged in\b.*(?:\/login|login)|(?:Authentication|Login) (?:failed|required)\b|Your authentication token (?:has expired|is invalid)\b|OAuth token (?:has )?expired\b|Please (?:run|use) [`"']?(?:claude |codex )?(?:auth login|\/login)\b|API Error: 401\b|invalid_api_key\b)/i.test(error.trim())
}
