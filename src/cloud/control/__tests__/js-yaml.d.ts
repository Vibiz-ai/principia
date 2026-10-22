/** js-yaml ships no types; the deploy tests only parse (it is in the lockfile through the dev toolchain). */
declare module 'js-yaml' {
  export function load(text: string): unknown
}
