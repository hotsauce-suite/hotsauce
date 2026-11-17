/**
 * The Dictate page's "On this Mac" (docs/PLAN-dictations-page.md). Inside the Mac app, the page
 * reads this Mac's dictation numbers and recent dictations through the same handler as
 * Settings → This Mac (`hotsauceMacSettings`, apps/dictate-mac DictationsReply). The text never
 * leaves the Mac: the server and the demo don't have it.
 */
import { type MacSettingsBridge, macSettingsBridge } from './macSettings'

export type DictationRange = 'week' | 'month' | 'all'

export const DICTATION_RANGES: { id: DictationRange; label: string }[] = [
  { id: 'week', label: '7 days' },
  { id: 'month', label: '30 days' },
  { id: 'all', label: 'All' },
]

/** The longest search the Mac takes. */
export const SEARCH_LIMIT = 200

/** The event the Mac sends when its history changes (R5). */
export const DICTATIONS_CHANGED = 'hotsauce:mac-dictations'

export interface MacDictation {
  id: string
  /** Milliseconds since 1970. */
  date: number
  text: string
  app: string | null
  bundle: string | null
  /** Whether the cleanup pass ran; false shows "as spoken". */
  cleaned: boolean
  /** Written up by the Mac's own speech recognition. */
  onDevice: boolean
}

export interface MacDictations {
  range: DictationRange
  stats: {
    dictations: number
    totalWords: number
    timeSavedMinutes: number
    averageWPM: number
    topApps: { name: string; bundle: string | null; words: number }[]
  }
  month: {
    /** The 1st of the month, in milliseconds. */
    start: number
    /** Empty cells before the 1st, Monday first. */
    leadingBlanks: number
    days: { words: number; level: 0 | 1 | 2 | 3 | 4 }[]
    activeDays: number
  }
  /** Dictations kept on this Mac, and how many match the search. */
  total: number
  matched: number
  /** The newest matches, at most 200. */
  records: MacDictation[]
  /** App icons as data URLs, by bundle id. */
  icons: Record<string, string>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown): v is string => typeof v === 'string'
const textOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isRange = (v: unknown): v is DictationRange => v === 'week' || v === 'month' || v === 'all'

/** The Mac's answer, checked: anything malformed is null, never a half-drawn section. */
export function parseMacDictations(reply: unknown): MacDictations | null {
  if (!isObject(reply) || !isRange(reply.range)) return null
  const { stats, month, records, icons } = reply
  if (!isObject(stats) || !isObject(month) || !Array.isArray(records) || !isObject(icons))
    return null
  if (!count(reply.total) || !count(reply.matched)) return null
  if (!count(stats.dictations) || !count(stats.totalWords) || !count(stats.averageWPM)) return null
  if (!finite(stats.timeSavedMinutes) || stats.timeSavedMinutes < 0) return null
  if (!Array.isArray(stats.topApps)) return null
  const topApps = []
  for (const app of stats.topApps) {
    if (!isObject(app) || !text(app.name) || !textOrNull(app.bundle) || !count(app.words))
      return null
    topApps.push({ name: app.name, bundle: app.bundle, words: app.words })
  }
  if (!finite(month.start) || !count(month.leadingBlanks) || month.leadingBlanks > 6) return null
  if (!count(month.activeDays) || !Array.isArray(month.days) || month.days.length > 31) return null
  const days: MacDictations['month']['days'] = []
  for (const day of month.days) {
    if (!isObject(day) || !count(day.words) || !count(day.level) || day.level > 4) return null
    days.push({ words: day.words, level: day.level as 0 | 1 | 2 | 3 | 4 })
  }
  const list: MacDictation[] = []
  for (const r of records) {
    if (!isObject(r) || !text(r.id) || !finite(r.date) || !text(r.text)) return null
    if (!textOrNull(r.app) || !textOrNull(r.bundle)) return null
    if (typeof r.cleaned !== 'boolean' || typeof r.onDevice !== 'boolean') return null
    list.push({
      id: r.id,
      date: r.date,
      text: r.text,
      app: r.app,
      bundle: r.bundle,
      cleaned: r.cleaned,
      onDevice: r.onDevice,
    })
  }
  const iconMap: Record<string, string> = {}
  for (const [bundle, url] of Object.entries(icons)) {
    // Only images the Mac drew: a data URL of a PNG, never a link to load.
    if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) iconMap[bundle] = url
  }
  return {
    range: reply.range,
    stats: {
      dictations: stats.dictations,
      totalWords: stats.totalWords,
      timeSavedMinutes: stats.timeSavedMinutes,
      averageWPM: stats.averageWPM,
      topApps,
    },
    month: {
      start: month.start,
      leadingBlanks: month.leadingBlanks,
      days,
      activeDays: month.activeDays,
    },
    total: reply.total,
    matched: reply.matched,
    records: list,
    icons: iconMap,
  }
}

/** This Mac's dictations; null when the app doesn't answer (a browser, or an older app). */
export async function readMacDictations(
  range: DictationRange,
  search: string,
  bridge: MacSettingsBridge | null = macSettingsBridge(),
): Promise<MacDictations | null> {
  if (!bridge) return null
  try {
    return parseMacDictations(
      await bridge.postMessage({
        type: 'dictations',
        range,
        search: search.slice(0, SEARCH_LIMIT),
      }),
    )
  } catch {
    return null
  }
}

/** Copies a dictation, or pastes it into the app the member was in; whether the Mac did. */
export async function actOnDictation(
  id: string,
  action: 'copy' | 'paste',
  bridge: MacSettingsBridge | null = macSettingsBridge(),
): Promise<boolean> {
  if (!bridge) return false
  try {
    const reply = await bridge.postMessage({ type: 'dictation', id, action })
    return isObject(reply) && reply.ok === true
  } catch {
    return false
  }
}
