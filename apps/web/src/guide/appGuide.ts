// Hotsauce 101's cards (docs/PLAN-tour-and-101.md H1-H3). The words are the same list hotsauce.work
// shows (site/public/apps.json), so the site and the app can't drift apart; the loops are the
// site's too, built into the app and fetched only when a card is played.

import entries from '../../../../site/public/apps.json'

export type Feature = 'ai' | 'transcription'

export interface GuideEntry {
  id: string
  /** The suite app this card is about (`APPS` in apps/registry.ts); null for Ask and Booking links. */
  app: string | null
  name: string
  instead: string
  line: string
  how: string
  feats: string[]
  needs: string
  /** The loop's name under site/public/video/apps/. */
  video: string
  /** Where Open goes in the app; null when there is no page to open (Ask lives on every page). */
  open: string | null
  /** What the server must have switched on for the app's main job. */
  requires: Feature[]
}

export const GUIDE: readonly GuideEntry[] = entries as GuideEntry[]

const media = import.meta.glob('../../../../site/public/video/apps/*.{mp4,jpg}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function mediaUrl(name: string): string | null {
  return media[`../../../../site/public/video/apps/${name}`] ?? null
}

export function videoOf(entry: GuideEntry): string | null {
  return mediaUrl(`${entry.video}.mp4`)
}

export function posterOf(entry: GuideEntry): string | null {
  return mediaUrl(`${entry.video}.jpg`)
}

const FEATURE_NAMES: Record<Feature, string> = {
  ai: 'an AI key',
  transcription: 'a speech-to-text key',
}

/** What a card says about this workspace: ready, or the keys it still needs, in plain words. */
export function statusOf(
  entry: GuideEntry,
  features: Partial<Record<Feature, boolean>> | undefined,
): { ready: boolean; missing: string | null } {
  // An older server says nothing: don't claim a key is missing.
  if (!features) return { ready: true, missing: null }
  const missing = entry.requires.filter((f) => features[f] === false).map((f) => FEATURE_NAMES[f])
  if (missing.length === 0) return { ready: true, missing: null }
  return { ready: false, missing: missing.join(' and ') }
}

/** Ready cards first, each group in the list's own order. */
export function sortedForWorkspace(
  list: readonly GuideEntry[],
  features: Partial<Record<Feature, boolean>> | undefined,
): GuideEntry[] {
  const ready = list.filter((e) => statusOf(e, features).ready)
  return [...ready, ...list.filter((e) => !ready.includes(e))]
}
