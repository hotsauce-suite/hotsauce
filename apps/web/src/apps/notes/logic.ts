// Pure helpers for Hearth Notes' web app (ARCHITECTURE §14.5).

import { NOTE_COLORS, type NoteColor } from '@hearth/format'
import type { NoteView } from '../../api/notes'

export const COLOR_NAMES: Record<NoteColor, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  darkblue: 'Dark blue',
  purple: 'Purple',
  pink: 'Pink',
  brown: 'Brown',
  gray: 'Gray',
}

export const COLORS: readonly (NoteColor | null)[] = [null, ...NOTE_COLORS]

export function labelUrl(label: string): string {
  return `/notes/label/${encodeURIComponent(label)}`
}

export function itemUrl(note: { space: string; id: string }): string {
  return `/notes/item/${encodeURIComponent(note.space)}/${encodeURIComponent(note.id)}`
}

/** Deals cards into `n` columns left to right, so the board reads row by row. */
export function dealColumns<T>(items: readonly T[], n: number): T[][] {
  const cols: T[][] = Array.from({ length: Math.max(1, n) }, () => [])
  items.forEach((item, i) => {
    cols[i % cols.length]?.push(item)
  })
  return cols
}

/** How many columns fit: cards at least `min` px wide, `gap` px apart; 2 on a phone. */
export function columnsFor(width: number, min = 236, gap = 14): number {
  if (width <= 0) return 1
  if (width < 480) return width < 260 ? 1 : 2
  return Math.max(1, Math.floor((width + gap) / (min + gap)))
}

/** "Edited 3:05 PM" today, "Edited Nov 3" this year, else "Edited Nov 3, 2025". */
export function editedLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return `Edited ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return `Edited ${d.toLocaleDateString(undefined, opts)}`
}

/** Splits the board into pinned and the rest (the server already sorts each). */
export function splitPinned(notes: readonly NoteView[]): {
  pinned: NoteView[]
  others: NoteView[]
} {
  return { pinned: notes.filter((n) => n.pinned), others: notes.filter((n) => !n.pinned) }
}

/** An order that puts a note on top of the board (above every unpinned card). */
export function topOrder(notes: readonly NoteView[], now = Date.now()): number {
  let max = now
  for (const n of notes) {
    const k = n.order ?? Date.parse(n.created)
    if (Number.isFinite(k) && k >= max) max = k + 1
  }
  return max
}

/** Days left before a trashed note is deleted for good (30 after it went in). */
export function daysLeftInTrash(trashed: string, now = Date.now()): number {
  const left = 30 - Math.floor((now - Date.parse(trashed)) / 86_400_000)
  return Math.max(0, left)
}
