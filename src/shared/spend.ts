/**
 * Five doors step 4 (design §4.8, §4.9, pm-review B5/B6): the pure rules behind Spend and All companies. Plan use
 * first, pay-as-you-go dollars second and only on request; one total that equals the table; a monthly cap per company;
 * and no one-click money action in a list that mixes companies. No React, no IPC.
 */
import type { UsageBucket, UsageRow } from './usage'

/** The cap is reached when the month's pay-as-you-go value is at or over it. Unknown dollars never trip it. */
export function capReached(usd: number | null | undefined, cap: number | null | undefined): boolean {
  return typeof cap === 'number' && cap > 0 && typeof usd === 'number' && usd >= cap
}

/** "$18.60", "$0", "<$0.01"; "~$1.20" when part of it is estimated. Unpriced tokens add "+" (some work has no price). */
export function dollars(b: Pick<UsageBucket, 'usd' | 'estimated' | 'unpriced'> | null | undefined): string {
  if (!b || b.usd == null || b.usd === 0) return `$0${b?.unpriced ? '+' : ''}`
  const v = b.usd < 0.01 ? '<0.01' : b.usd < 1000 ? b.usd.toFixed(2) : Math.round(b.usd).toLocaleString('en-US')
  return `${b.estimated ? '~' : ''}$${v}${b.unpriced ? '+' : ''}`
}

/** "Cap $60/month · 52% used", "No monthly cap". */
export function capLine(usd: number | null | undefined, cap: number | null | undefined): { text: string; pct: number | null } {
  if (!cap) return { text: 'No monthly cap', pct: null }
  const pct = Math.min(999, Math.round(((usd ?? 0) / cap) * 100))
  return { text: `Cap $${formatCap(cap)}/month · ${pct}% used`, pct }
}
export function formatCap(cap: number): string {
  return Number.isInteger(cap) ? String(cap) : cap.toFixed(2)
}
/** What the founder typed in "Set a cap": "$60", "60", "60.5" → 60.5; null for empty or nonsense. */
export function parseCap(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= 100_000 ? n : null
}

/** Why "Set" stays off for what was typed, in plain words; null while empty or fine. */
export function capError(raw: string): string | null {
  const s = raw.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!s || parseCap(raw) !== null) return null
  if (!/^\d*(\.\d*)?$/.test(s)) return 'Type an amount in dollars, like 60.'
  if (/\.\d{3,}$/.test(s)) return 'Use at most two decimals, like 60.50.'
  const n = Number(s)
  if (n < 1) return 'The smallest cap is $1.'
  if (n > 100_000) return 'The largest cap is $100,000.'
  return 'Type an amount in dollars, like 60.'
}

/**
 * A table's rows plus the total row. The total is the sum of the rows shown, so the footer can never disagree with the
 * table (pm-review B5: "the footer total equals the table total, Personal included").
 */
export function withTotal(rows: readonly UsageRow[]): { rows: UsageRow[]; total: UsageBucket } {
  const total: UsageBucket = { usd: null, estimated: false, unpriced: false, tokensIn: 0, tokensOut: 0, agents: 0 }
  for (const r of rows) {
    total.agents += r.agents
    total.tokensIn += r.tokensIn
    total.tokensOut += r.tokensOut
    if (r.usd != null) total.usd = (total.usd ?? 0) + r.usd
    if (r.estimated) total.estimated = true
    if (r.unpriced) total.unpriced = true
  }
  return { rows: [...rows], total }
}

/**
 * One vocabulary on every surface (Spend tiles, the hero, All companies cards, the table, the CSV): "runs" counts
 * everything that ran, your own chats included, and a chat is never called an agent run.
 * "23 runs, incl. 4 chats of your own", "1 chat of your own", "5 agent runs".
 */
export function runsLine(runs: number, chats: number): string {
  if (!runs) return 'No agent work yet'
  const { n, of } = heroCount(runs, chats)
  return `${n} ${of}`
}

/** The Spend hero's count: "23 runs, incl. 4 chats of your own", "1 chat of your own", "5 agent runs". */
export function heroCount(runs: number, chats: number): { n: string; of: string } {
  if (!runs) return { n: '0', of: 'agent runs' }
  if (chats >= runs) return { n: String(runs), of: runs === 1 ? 'chat of your own' : 'chats of your own' }
  if (!chats) return { n: String(runs), of: `agent run${runs === 1 ? '' : 's'}` }
  return { n: String(runs), of: `runs, incl. ${chats} chat${chats === 1 ? '' : 's'} of your own` }
}

// ---------- All companies: one row per company, $0 included, and Export CSV ----------

export interface CompanySpend {
  companyId: string
  name: string
  personal: boolean
  paused: boolean
  month: UsageBucket | null
  week: UsageBucket | null
  cap: number | null
}

/** Every company in the list order (Personal last), with its month and week; a company with no runs is $0, not missing. */
export function companySpend(
  companies: readonly { id: string; name: string; system?: string | null; pausedAt?: string | null; monthlyCap?: number | null }[],
  month: readonly UsageRow[] | null,
  week: readonly UsageRow[] | null
): CompanySpend[] {
  const pick = (rows: readonly UsageRow[] | null, id: string): UsageBucket | null => {
    if (!rows) return null
    return rows.find((r) => r.companyId === id) ?? { usd: 0, estimated: false, unpriced: false, tokensIn: 0, tokensOut: 0, agents: 0 }
  }
  const list = [...companies].sort((a, b) => Number(a.system === 'personal') - Number(b.system === 'personal'))
  return list.map((c) => ({ companyId: c.id, name: c.name, personal: c.system === 'personal', paused: !!c.pausedAt, month: pick(month, c.id), week: pick(week, c.id), cap: c.monthlyCap ?? null }))
}

const csvCell = (v: string | number): string => {
  const s = String(v)
  // a leading = + - @ would run as a formula in a spreadsheet: prefix it
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
const usdCell = (b: UsageBucket | null): string => (b?.usd == null ? '0.00' : b.usd.toFixed(2))

/** The CSV agencies bill from: one row per company, dollars with two decimals, a total row that equals the rows. */
export function spendCsv(rows: readonly CompanySpend[], monthLabel: string): string {
  const head = ['Company', 'State', `${monthLabel} pay-as-you-go value (USD)`, 'This week (USD)', 'Runs this month (incl. your own chats)', 'Monthly cap (USD)']
  const lines = [head.map(csvCell).join(',')]
  let m = 0
  let w = 0
  let runs = 0
  for (const r of rows) {
    m += r.month?.usd ?? 0
    w += r.week?.usd ?? 0
    runs += r.month?.agents ?? 0
    lines.push([r.name, r.personal ? 'Personal' : r.paused ? 'Paused' : 'Running', usdCell(r.month), usdCell(r.week), r.month?.agents ?? 0, r.cap ? r.cap.toFixed(2) : ''].map(csvCell).join(','))
  }
  lines.push(['Total', '', m.toFixed(2), w.toFixed(2), runs, ''].map(csvCell).join(','))
  return lines.join('\n') + '\n'
}

/** One company's Spend table as CSV (by agent or department): runs, tokens and the pay-as-you-go value, plus the total. */
export function rowsCsv(rows: readonly UsageRow[], what: string): string {
  const { total } = withTotal(rows)
  const lines = [[what, 'Agent runs', 'Tokens', 'Pay-as-you-go value (USD)'].map(csvCell).join(',')]
  for (const r of rows) lines.push([r.label, r.agents, r.tokensIn + r.tokensOut, usdCell(r)].map(csvCell).join(','))
  lines.push(['Total', total.agents, total.tokensIn + total.tokensOut, usdCell(total)].map(csvCell).join(','))
  return lines.join('\n') + '\n'
}

// ---------- pm-review B6: no one-click money in mixed lists ----------

const MONEY = /(?:[$€£]\s?\d)|(?:\d\s?(?:usd|eur|gbp|dollars?)\b)|\b(?:refund|pay|charge|purchase|buy|spend|invoice|discount|credit|payout|transfer)\b/i

/** An answer button that moves money ("Refund $24", "Pay the invoice"). */
export function isMoneyAction(label: string): boolean {
  return MONEY.test(label)
}

/** "Yes", "OK", "Approve", "Go ahead": an answer that agrees to what the question asks. */
const AGREE = /^(?:yes|y|ok|okay|sure|approve[ds]?|confirm(?:ed)?|go ahead|do it|accept)\b/i

/**
 * An answer that moves money: the label itself does ("Refund $24"), or it agrees to a question that does ("Yes" to
 * "Refund $24 to her card?"). A "No" never moves money.
 */
export function isMoneyAnswer(label: string, prompt?: string | null): boolean {
  return isMoneyAction(label) || (!!prompt && isMoneyAction(prompt) && AGREE.test(label.trim()))
}

/**
 * The shortest name that still tells a company apart in a list: its first word ("Northwind"), or as many words as it
 * takes when another company starts the same way ("Harbor Dental Kids" beside "Harbor Dental Group"), else the name.
 */
export function shortCompanyName(name: string | null | undefined, others: readonly string[] = []): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  const rest = others.map((o) => o.trim().toLowerCase()).filter((o) => o && o !== words.join(' ').toLowerCase())
  for (let n = 1; n < words.length; n++) {
    const head = words.slice(0, n).join(' ').toLowerCase()
    if (!rest.some((o) => o === head || o.startsWith(`${head} `))) return words.slice(0, n).join(' ')
  }
  return words.join(' ')
}

/**
 * The label of an answer button in a list that mixes companies (All companies → Needs you). A money answer names the
 * client ("Refund $24 · Northwind", "Yes, $24 · Northwind" to a refund question), so a click can never pay out for the
 * wrong company; anything else is unchanged. Without a company name it reads "Review".
 */
export function mixedListLabel(label: string, companyName: string | null | undefined, opts: { prompt?: string | null; others?: readonly string[] } = {}): string {
  if (!isMoneyAnswer(label, opts.prompt)) return label
  const short = shortCompanyName(companyName, opts.others)
  if (!short) return 'Review'
  if (isMoneyAction(label)) return `${label} · ${short}`
  const amount = opts.prompt?.match(/[$€£]\s?\d[\d,]*(?:\.\d+)?/)?.[0]
  return amount ? `${label}, ${amount} · ${short}` : `${label} · ${short}`
}
