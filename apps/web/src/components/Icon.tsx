const PATHS = {
  chevron: 'M6 4l4 4-4 4',
  file: 'M4 1.75h5.25L12.5 5v9.25h-8.5zM9 1.75V5.25h3.5',
  folder: 'M1.75 4.25v8.5h12.5V5.5H7.5L6 3.75H1.75z',
  plus: 'M8 3v10M3 8h10',
  folderPlus: 'M1.75 4.25v8.5h12.5V5.5H7.5L6 3.75H1.75zM8 7v4M6 9h4',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.75 10.75 14 14',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.75h2.75M8 5v3.25l2 1.25',
  book: 'M2 3.25c2-.75 4-.75 6 .75 2-1.5 4-1.5 6-.75v9.5c-2-.75-4-.75-6 .75-2-1.5-4-1.5-6-.75zM8 4v9.75',
  share: 'M8 10V2M5 4.75 8 1.75l3 3M3.25 7.5v6.75h9.5V7.5',
  star: 'M8 1.75l1.9 4 4.35.5-3.25 3 .9 4.25L8 11.4l-3.9 2.1.9-4.25-3.25-3 4.35-.5z',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  close: 'M4 4l8 8M12 4l-8 8',
  sliders: 'M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3',
  flag: 'M3.5 14.25V2.25h8.25l-1.5 3 1.5 3H3.5',
  copy: 'M5.25 5.25h8v8.5h-8zM2.25 10.75V2.25h8.25',
  link: 'M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.6.6M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.6-.6',
  trash: 'M2.75 4.25h10.5M6.25 4.25V2.5h3.5v1.75M4 4.25l.75 10h6.5l.75-10',
  pencil: 'M10.5 2.5l3 3-8 8H2.5v-3z',
  move: 'M1.75 4.25v8.5h12.5V5.5H7.5L6 3.75H1.75zM6 9.25h4.5M9 7.75l1.5 1.5L9 10.75',
  mic: 'M8 1.75A2.25 2.25 0 0 0 5.75 4v3.5a2.25 2.25 0 0 0 4.5 0V4A2.25 2.25 0 0 0 8 1.75zM3.5 7.25a4.5 4.5 0 0 0 9 0M8 11.75v2.5',
  tab: 'M1.75 2.75h12.5v8.5H1.75zM5.5 14.25h5M8 11.25v3',
  pause: 'M5.75 3.5v9M10.25 3.5v9',
  play: 'M5 3.25v9.5L12.5 8z',
  stop: 'M4.25 4.25h7.5v7.5h-7.5z',
  sparkle: 'M8 1.75l1.35 4.9 4.9 1.35-4.9 1.35L8 14.25l-1.35-4.9L1.75 8l4.9-1.35z',
  chat: 'M2.25 3.25h11.5v7.5H7.25l-3 2.5v-2.5h-2z',
  transcript: 'M2.5 3.75h11M2.5 6.75h7.5M2.5 9.75h11M2.5 12.75h5.5',
  calendar: 'M2.25 3.75h11.5v10H2.25zM2.25 6.75h11.5M5.25 2v3M10.75 2v3',
  video: 'M1.75 4.25h8.5v7.5h-8.5zM10.25 7l4-2.25v6.5l-4-2.25',
  check: 'M3 8.5l3 3 7-7',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  docs: 'M4 1.75h5.25L12.5 5v9.25h-8.5zM9 1.75V5.25h3.5M6.25 8.5h3.5M6.25 11h3.5',
  gear: 'M8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM8 1.75v1.75M8 12.5v1.75M1.75 8h1.75M12.5 8h1.75M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2',
  external: 'M9.25 2.25h4.5v4.5M13.75 2.25 7.5 8.5M12 9.75v4H2.25V4h4',
  download: 'M8 2v8.25M4.75 7 8 10.25 11.25 7M2.75 11v2.75h10.5V11',
  restart: 'M2.75 8a5.25 5.25 0 1 0 1.55-3.7M2.75 2.5v2.75H5.5',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.6 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** The default mark: a single flame inside an arch. */
export function HearthMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path
        d="M4 29V14a12 12 0 0 1 24 0v15"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M16 9c3.6 4 5.6 6.8 5.6 10a5.6 5.6 0 0 1-11.2 0c0-2.1 1-3.6 2.3-5.1.4 1.7 1.1 2.6 2.3 3-.6-2.8 0-5.4 1-7.9z"
        fill="var(--ember)"
      />
    </svg>
  )
}
