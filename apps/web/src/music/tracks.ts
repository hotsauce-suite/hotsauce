// The background music (docs/PLAN-background-music.md). Every track is CC0 (public domain): anyone
// may reuse and share it. They're credited on the help page anyway (site/public/help/music.html).
// The files live in apps/web/public/music/ and load only when someone presses play.

export interface Track {
  id: string
  /** What the panel calls it. */
  label: string
  /** The original's title and author, for the credits. */
  title: string
  author: string
  source: string
  file: string
}

export const TRACKS: readonly Track[] = [
  {
    id: 'piano',
    label: 'Soft piano',
    title: 'Calm Piano 1 (Vaporware)',
    author: 'The Cynic Project',
    source: 'https://opengameart.org/content/calm-piano-1-vaporware',
    file: '/music/soft-piano.mp3',
  },
  {
    id: 'lofi',
    label: 'Lo-fi',
    title: 'Chill lofi inspired',
    author: 'omfgdude',
    source: 'https://opengameart.org/content/chill-lofi-inspired',
    file: '/music/lo-fi.mp3',
  },
  {
    id: 'ambient',
    label: 'Ambient',
    title: 'Another August',
    author: 'The Cynic Project',
    source: 'https://opengameart.org/content/another-august',
    file: '/music/ambient.mp3',
  },
  {
    id: 'rain',
    label: 'Rain',
    title: 'AMB Rain Loop 1',
    author: 'kresiek-the-furry',
    source: 'https://opengameart.org/content/amb-rain-loop-1',
    file: '/music/rain.mp3',
  },
]

export const DEFAULT_TRACK = 'piano'

export function trackById(id: string): Track {
  return TRACKS.find((t) => t.id === id) ?? (TRACKS[0] as Track)
}
