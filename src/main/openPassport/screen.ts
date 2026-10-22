// Vendored from open-passport 0.1.0 (packages/js/src/core/screen.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Security screens (SPEC.md §10): credential shapes, executable content, allowed file types and paths.

export const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bsk-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/, 'sk- API key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, 'GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, 'private key'],
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i, 'credential assignment']
]

/** Instruction-injection shapes that never belong in company memory (quarantined, never rendered). */
export const IMPERATIVE_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(all|previous|prior)\s+instructions/i, 'ignore instructions'],
  [/\bsystem\s+prompt\b/i, 'system prompt'],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, 'pipe to shell'],
  [/rm\s+-rf\s+(\/(\s|$|\*)|~)/i, 'rm -rf']
]

/** SPEC.md §10.3: the only file types a passport may carry. */
export const ALLOWED_EXT = /\.(md|json|txt|csv|png|jpe?g|gif|webp|pdf)$/i
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_FILES = 5000
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024

export function credentialHit(text: string): string | null {
  for (const [re, label] of CREDENTIAL_PATTERNS) if (re.test(text)) return label
  return null
}

export function imperativeHit(text: string): string | null {
  for (const [re, label] of IMPERATIVE_PATTERNS) if (re.test(text)) return label
  return null
}

/** Active content inside markdown: script/iframe tags, `javascript:` links, event handler attributes. */
export function executableHit(text: string): string | null {
  if (/<\s*(script|iframe|object|embed)\b/i.test(text)) return 'html script/iframe'
  if (/\]\(\s*javascript:/i.test(text) || /href\s*=\s*["']?\s*javascript:/i.test(text)) return 'javascript: link'
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(text)) return 'html event handler'
  return null
}

/** A safe relative path: `/`-separated, no `..`, no absolute or drive paths, no NUL, no backslashes. */
export function safeRelPath(p: string): boolean {
  if (!p || p.length > 512 || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

export function redactCredentials(text: string): string {
  let out = text
  for (const [re] of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted]')
  return out
}
