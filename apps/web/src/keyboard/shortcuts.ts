// The one key listener. Pages bind handlers to catalog ids (useShortcut); the listener finds
// the shortcut a key press means and runs the newest handler bound to it.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { SHORTCUTS, type ShortcutId } from './catalog'
import {
  isCharacterStroke,
  isPlainSpec,
  isTypingTarget,
  type KeyInput,
  matchStroke,
  parseSpec,
  type Stroke,
} from './keys'
import { singleKeysEnabled } from './prefs'

export interface ShortcutEvent {
  /** The spec that matched, as written in the catalog ("2", "ArrowDown"). */
  spec: string
  event: KeyboardEvent
}

/** Return false to leave the key alone (not handled: the browser and others get it). */
export type ShortcutHandler = (e: ShortcutEvent) => boolean | undefined

interface Binding {
  run: ShortcutHandler
}

/** A second stroke must follow the first within this long ("g", then "d"). */
export const SEQUENCE_MS = 1200

const bindings = new Map<ShortcutId, Binding[]>()
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  for (const listener of listeners) listener()
}

/** Binds `run` to a shortcut; the newest binding wins until it is removed. */
export function bindShortcut(id: ShortcutId, run: ShortcutHandler): () => void {
  const binding: Binding = { run }
  const stack = bindings.get(id) ?? []
  stack.push(binding)
  bindings.set(id, stack)
  changed()
  return () => {
    const current = bindings.get(id)
    if (!current) return
    const i = current.indexOf(binding)
    if (i !== -1) current.splice(i, 1)
    if (current.length === 0) bindings.delete(id)
    changed()
  }
}

/** The ids bound right now (the sheet lists these as "on this page"). */
export function boundIds(): ShortcutId[] {
  return [...bindings.keys()]
}

/** Re-renders when bindings change. */
export function useBoundIds(): ShortcutId[] {
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
  return boundIds()
}

/**
 * Binds `run` to a shortcut while the component is mounted. `run` may change every render;
 * the binding always calls the latest one. `enabled: false` unbinds.
 */
export function useShortcut(id: ShortcutId, run: ShortcutHandler, enabled = true): void {
  const ref = useRef(run)
  ref.current = run
  useEffect(() => {
    if (!enabled) return
    return bindShortcut(id, (e) => ref.current(e))
  }, [id, enabled])
}

const parsed = new Map<string, Stroke[]>()
function strokesOf(spec: string): Stroke[] {
  let s = parsed.get(spec)
  if (!s) {
    s = parseSpec(spec)
    parsed.set(spec, s)
  }
  return s
}

/** Enter and Space on these do what the control does. */
const CONTROL =
  'button, a[href], summary, video, audio, [role="button"], [role="checkbox"], [role="menuitem"], [role="tab"], [role="option"]'
/** Arrow keys on these seek or scrub. */
const MEDIA = 'video, audio'

function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ) !== null
  )
}

function closest(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null
}

function blockedFor(strokes: Stroke[], event: KeyboardEvent, onControls = false): boolean {
  if (!isPlainSpec(strokes)) return false
  if (isTypingTarget(event.target) || overlayOpen()) return true
  if (!singleKeysEnabled() && strokes.some(isCharacterStroke)) return true
  const last = strokes[strokes.length - 1]
  if (!last) return true
  if (
    (last.key === 'enter' || last.key === ' ') &&
    closest(event.target, onControls ? MEDIA : CONTROL)
  )
    return true
  if (last.key.startsWith('arrow') && closest(event.target, MEDIA)) return true
  return false
}

let pending: { stroke: KeyInput; at: number } | null = null

function run(id: ShortcutId, spec: string, event: KeyboardEvent): boolean {
  const stack = bindings.get(id)
  const binding = stack?.[stack.length - 1]
  if (!binding) return false
  const result = binding.run({ spec, event })
  if (result === false) return false
  event.preventDefault()
  return true
}

function input(event: KeyboardEvent): KeyInput {
  return {
    key: event.key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  }
}

export function handleKeyDown(event: KeyboardEvent): void {
  // keyCode 229: Safari's key that commits an IME composition, with isComposing already false.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
  const now = Date.now()
  const first = pending && now - pending.at <= SEQUENCE_MS ? pending.stroke : null
  pending = null
  const keyInput = input(event)

  // The second key of a sequence.
  if (first) {
    for (const [id, stack] of bindings) {
      if (!stack.length) continue
      for (const spec of SHORTCUTS[id].keys) {
        const strokes = strokesOf(spec)
        if (strokes.length !== 2 || blockedFor(strokes, event, SHORTCUTS[id].onControls)) continue
        const [a, b] = strokes as [Stroke, Stroke]
        if (matchStroke(a, first) && matchStroke(b, keyInput) && run(id, spec, event)) return
      }
    }
  }

  let startsSequence = false
  for (const [id, stack] of bindings) {
    if (!stack.length) continue
    for (const spec of SHORTCUTS[id].keys) {
      const strokes = strokesOf(spec)
      if (blockedFor(strokes, event, SHORTCUTS[id].onControls)) continue
      const [a] = strokes as [Stroke]
      if (!matchStroke(a, keyInput)) continue
      if (strokes.length === 1) {
        if (run(id, spec, event)) return
      } else startsSequence = true
    }
  }
  if (startsSequence) pending = { stroke: keyInput, at: now }
}

/** Installs the listener on `window`; returns the uninstall. AppShell calls it once. */
export function installKeyListener(): () => void {
  window.addEventListener('keydown', handleKeyDown)
  return () => {
    window.removeEventListener('keydown', handleKeyDown)
    pending = null
  }
}

export function useKeyListener(): void {
  useEffect(() => installKeyListener(), [])
}
