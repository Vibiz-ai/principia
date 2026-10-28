/**
 * Removes every match of `re` (a /g pattern) again and again until none is left. One pass is not enough for tags and
 * comments: removing `<b>` from `<scr<b>ipt>` or `<!-<!---->-` splices the halves into a new `<script>` or `<!--`.
 */
export function stripAll(s: string, re: RegExp): string {
  let prev: string
  do {
    prev = s
    s = s.replace(re, '')
  } while (s !== prev)
  return s
}

/** Plain text of an HTML/markdown fragment: every `<…>` tag removed until none is left. */
export const stripTags = (s: string): string => stripAll(s, /<[^>]+>/g)
