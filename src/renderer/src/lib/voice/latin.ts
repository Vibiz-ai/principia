/**
 * VOICE.md §6: every Latin phrase the app may show. Real, attested, literally translated. The translation is always
 * shown or read next to it; screen readers hear only the English.
 */
export interface LatinPhrase {
  la: string
  en: string
  /** where it appears (documentation only) */
  use: string
}

export const LATIN = {
  alea: { la: 'Alea iacta est', en: 'The die is cast', use: 'Ceremony title' },
  festina: { la: 'Festina lente', en: 'Make haste slowly', use: 'Loading (plan)' },
  veni: { la: 'Veni, vidi, vici', en: 'I came, I saw, I conquered', use: 'Badge: first post approved' },
  roma: {
    la: 'Roma uno die non est condita',
    en: "Rome wasn't built in a day",
    use: 'The English version on Goals only (medieval proverb, not classical; never shown in Latin)'
  },
  fortes: { la: 'Fortes fortuna adiuvat', en: 'Fortune favors the bold', use: 'Ready, Start now?' },
  labor: { la: 'Labor omnia vincit', en: 'Work conquers all', use: 'Badge: first task done' },
  nulla: { la: 'Nulla dies sine linea', en: 'No day without a line', use: 'Badge: first week' },
  acta: { la: 'Acta non verba', en: 'Deeds, not words', use: 'Board empty' },
  quidnovi: { la: 'Quid novi?', en: "What's new?", use: 'Digest empty' },
  otium: { la: 'Otium cum dignitate', en: 'Leisure, with dignity', use: 'Needs you empty' },
  bene: { la: 'Bene factum', en: 'Well done', use: 'Task-done toast' },
  primus: { la: 'Primus lapis', en: 'The first stone', use: 'Badge: company launched' },
  ave: { la: 'Ave', en: 'Hail, welcome', use: 'Top Needs-you item only' },
  abovo: { la: 'Ab ovo', en: 'From the very beginning', use: 'Launch wait; a nod to the name Principia (Horace)' },
  concordia: { la: 'Concordia', en: 'Harmony', use: 'Badge: full team' },
  pax: { la: 'Pax', en: 'Peace', use: 'Badge: calm week' },
  centuria: { la: 'Centuria', en: 'A hundred', use: 'Badge: 100 tasks done' }
} as const satisfies Record<string, LatinPhrase>

export type LatinKey = keyof typeof LATIN

/** Every Latin word in LATIN, lowercased (plain copy must contain none of them). */
export function latinWords(): Set<string> {
  const words = new Set<string>()
  for (const p of Object.values(LATIN)) for (const w of p.la.toLowerCase().match(/[a-z]+/g) ?? []) words.add(w)
  return words
}
