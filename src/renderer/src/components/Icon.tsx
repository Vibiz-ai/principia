/** Line icons (16px, 1.5 stroke), inline SVG so the app works offline. */
const P: Record<string, string> = {
  marketplace: 'M2 6l1-3h10l1 3M2 6v1a1.5 1.5 0 0 0 3 0 1.5 1.5 0 0 0 3 0 1.5 1.5 0 0 0 3 0 1.5 1.5 0 0 0 3 0V6zM3 8.5V14h10V8.5M6 14v-4h4v4',
  book: 'M8 4C6 2.5 3.5 2.5 1.5 3v10c2-.5 4.5-.5 6.5 1 2-1.5 4.5-1.5 6.5-1V3C12.5 2.5 10 2.5 8 4v10',
  code: 'M5 4 1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 2.5l-3 11',
  spark: 'M8 1.5 9.7 6.3 14.5 8l-4.8 1.7L8 14.5 6.3 9.7 1.5 8l4.8-1.7z',
  coins: 'M12.5 5c0 1.4-2 2.5-4.5 2.5S3.5 6.4 3.5 5s2-2.5 4.5-2.5 4.5 1.1 4.5 2.5zM3.5 5v3c0 1.4 2 2.5 4.5 2.5s4.5-1.1 4.5-2.5V5M3.5 8v3c0 1.4 2 2.5 4.5 2.5s4.5-1.1 4.5-2.5V8',
  shield: 'M8 1.5 13 3.5V8c0 3-5 6.5-5 6.5S3 11 3 8V3.5zM5.5 7.5l2 2 3-4',
  home: 'M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z',
  chat: 'M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
  canvas: 'M8 2.5 13.5 8 8 13.5 2.5 8z',
  workflows: 'M3 4h4v3H3zM9 9h4v3H9zM7 5.5h2.5v3.5',
  schedules: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 5v3.2l2 1.3',
  artifacts: 'M2.5 3.5h11v9h-11zM2.5 10l3-3 3 3 2-2 3 3',
  keys: 'M10 2.5a3.5 3.5 0 1 1-2.9 5.4L3 12v1.5h2V12h1.5v-1.5H8l.6-.6A3.5 3.5 0 0 1 10 2.5zM11 5.2h.01',
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.8v1.7M8 12.5v1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M1.8 8h1.7M12.5 8h1.7M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2',
  plus: 'M8 3v10M3 8h10',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  chevronLeft: 'M10 3.5 5.5 8l4.5 4.5',
  folder: 'M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z',
  folderMissing: 'M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM6 7.5l4 4M10 7.5l-4 4',
  terminal: 'M2.5 3.5h11v9h-11zM5 6.5 7 8.3 5 10M8.5 10.5H11',
  stop: 'M4.5 4.5h7v7h-7z',
  play: 'M5 3.5v9l7.5-4.5z',
  split: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  more: 'M4 8h.01M8 8h.01M12 8h.01',
  close: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.8 10.8 14 14',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  grid: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  list: 'M3 4.5h10M3 8h10M3 11.5h10',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 5v3.2l2 1.3',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  warning: 'M8 2.5 14 13H2zM8 6.5v3M8 11.2h.01',
  sidebar: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  upload: 'M8 11V3M5 6l3-3 3 3M3 11.5V13h10v-1.5',
  download: 'M8 3v8M5 8l3 3 3-3M3 11.5V13h10v-1.5',
  external: 'M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5',
  /** three linked nodes: the Memory graph */
  memory: 'M4.5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6.3 4.9l3.4 1.7M10 8.4 6.9 10.7M4.8 6v4',
  pin: 'M9.5 2.5 13.5 6.5 11 7.5 8.5 10l.5 3-6-6 3 .5L8.5 5zM3 13l3-3',
  globe: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c1.7 1.7 2.5 3.7 2.5 6S9.7 12.3 8 14C6.3 12.3 5.5 10.3 5.5 8S6.3 3.7 8 2z',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  edit: 'M10.5 3 13 5.5 6 12.5H3.5V10z',
  /** two figures: the Agents hub */
  agents: 'M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM10.2 9.7c.3-.1.5-.1.8-.1 1.7 0 3 1.3 3 3.2',
  reply: 'M6.5 4 3 7.5 6.5 11M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1',
  /** hash in a speech bubble: the Slack page (generic glyph, not the Slack logo) */
  slack: 'M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM6.7 5.5l-.6 4M9.4 5.5l-.6 4M5.3 6.7h5M5 8.4h5'
}

export function Icon({ name, size = 16, className }: { name: keyof typeof P | string; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={P[name] ?? P.file} />
    </svg>
  )
}
