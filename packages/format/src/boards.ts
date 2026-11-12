// Hearth Whiteboard (ARCHITECTURE §15): Excalidraw boards. One board per Markdown file,
// `boards/<id>.md`: its settings in frontmatter, then the text on the board as a list (so search,
// agents and anyone reading the repo see it), then the Excalidraw scene as JSON in a fenced
// `excalidraw` block, one element per line so Git diffs stay readable. Everything here is pure.

import { z } from 'zod'
import { patchFrontmatter } from './frontmatter.js'
import { isId, newId } from './ids.js'

export const BOARDS_FOLDER = 'boards'
/** The fence's info string that marks the scene block. */
export const BOARD_SCENE_INFO = 'excalidraw'
/** A board's live elements are capped so one file stays a reasonable size. */
export const MAX_BOARD_ELEMENTS = 20_000
/** Deleted elements are kept (small) so deletes merge; all elements together are capped higher. */
export const MAX_BOARD_ELEMENTS_TOTAL = 100_000
/**
 * Element types a board may not hold. Excalidraw renders an `iframe` element's HTML in a
 * scripted frame, so one member could run their page in every other member's browser.
 */
export const BLOCKED_ELEMENT_TYPES: ReadonlySet<string> = new Set(['iframe'])

/** `boards/<id>.md`. */
export function boardPath(id: string): string {
  return `${BOARDS_FOLDER}/${id}.md`
}

/** The id of a board file, or null when the path isn't `boards/<id>.md`. */
export function boardIdOf(path: string): string | null {
  const match = /^boards\/([0-9A-Z]{26})\.md$/.exec(path)
  return match?.[1] && isId(match[1]) ? match[1] : null
}

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? undefined, schema.optional())
}

/** Unknown keys pass through untouched. */
export const BoardFrontmatter = z.looseObject({
  id: z.string().min(1),
  type: z.literal('board'),
  title: optional(z.string()),
  created: z.string(),
  created_by: z.string(),
  updated: optional(z.string()),
  updated_by: optional(z.string()),
})
export type BoardFrontmatter = z.infer<typeof BoardFrontmatter>

/**
 * One Excalidraw element. Hearth only reads `id`, `version`, `isDeleted`, `type` and `text`;
 * every other field is kept exactly as Excalidraw wrote it.
 */
export const BoardElement = z.looseObject({
  id: z.string().min(1).max(200),
  type: z
    .string()
    .min(1)
    .max(100)
    .refine((t) => !BLOCKED_ELEMENT_TYPES.has(t), 'This kind of element can’t be on a board'),
  version: z.number().int().nonnegative(),
  versionNonce: z.number().optional(),
  isDeleted: z.boolean().optional(),
  text: z.string().optional(),
  fileId: z.string().nullable().optional(),
})
export type BoardElement = z.infer<typeof BoardElement>

/** An image on a board: stored as a file in the same space (the assets folder), never inline. */
export const BoardFile = z.object({
  mimeType: z.string().min(1).max(100),
  /** The image's path in the board's space. */
  path: z.string().min(1).max(1000),
})
export type BoardFile = z.infer<typeof BoardFile>

export const BoardScene = z.object({
  elements: z
    .array(BoardElement)
    .max(MAX_BOARD_ELEMENTS_TOTAL)
    .refine(
      (els) => els.filter((el) => !el.isDeleted).length <= MAX_BOARD_ELEMENTS,
      `A board holds at most ${MAX_BOARD_ELEMENTS} shapes`,
    ),
  appState: z
    .looseObject({
      viewBackgroundColor: z.string().max(50).optional(),
      gridSize: z.number().nullable().optional(),
    })
    .default({}),
  files: z.record(z.string().min(1).max(200), BoardFile).default({}),
})
export type BoardScene = z.infer<typeof BoardScene>

export const EMPTY_SCENE: BoardScene = { elements: [], appState: {}, files: {} }

/** A title is one line. */
export function boardTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** The text of every live text element, in drawing order, one line each, empty ones dropped. */
export function boardTexts(scene: Pick<BoardScene, 'elements'>): string[] {
  const out: string[] = []
  for (const el of scene.elements) {
    if (el.isDeleted || el.type !== 'text' || typeof el.text !== 'string') continue
    const line = el.text.replace(/\s+/g, ' ').trim()
    if (line) out.push(line)
  }
  return out
}

/** The live (not deleted) elements: what a board shows. */
export function liveElements(scene: Pick<BoardScene, 'elements'>): BoardElement[] {
  return scene.elements.filter((el) => !el.isDeleted)
}

/**
 * Two versions of one board merged element by element: an element on one side only is kept; one
 * on both sides keeps the higher `version` (a delete is a higher version with `isDeleted`), ties
 * broken by the lower `versionNonce` as Excalidraw's own reconciliation does. Order follows
 * `theirs` (what is saved), with elements only in `ours` placed after the element they followed.
 * Files are the union, `ours` winning a clash.
 */
export function mergeScenes(theirs: BoardScene, ours: BoardScene): BoardScene {
  const mine = new Map(ours.elements.map((el) => [el.id, el]))
  const inTheirs = new Set(theirs.elements.map((el) => el.id))
  // Each element only in `ours` goes right after the element before it in our order (which is
  // either in theirs or another of our new ones); the first goes at the end.
  const after = new Map<string | null, BoardElement[]>()
  for (let i = 0; i < ours.elements.length; i++) {
    const el = ours.elements[i] as BoardElement
    if (inTheirs.has(el.id)) continue
    const anchor = i > 0 ? (ours.elements[i - 1] as BoardElement).id : null
    const list = after.get(anchor)
    if (list) list.push(el)
    else after.set(anchor, [el])
  }
  const merged: BoardElement[] = []
  const seen = new Set<string>()
  const emit = (el: BoardElement) => {
    if (seen.has(el.id)) return
    seen.add(el.id)
    merged.push(el)
    const stack = [...(after.get(el.id) ?? [])].reverse()
    while (stack.length > 0) {
      const next = stack.pop() as BoardElement
      if (seen.has(next.id)) continue
      seen.add(next.id)
      merged.push(next)
      stack.push(...[...(after.get(next.id) ?? [])].reverse())
    }
  }
  for (const el of theirs.elements) {
    const other = mine.get(el.id)
    emit(other ? newer(el, other) : el)
  }
  for (const el of after.get(null) ?? []) emit(el)
  return {
    elements: merged,
    // Ours carries only the canvas settings it changed (the editor sends no others).
    appState: { ...theirs.appState, ...ours.appState },
    files: { ...theirs.files, ...ours.files },
  }
}

function newer(a: BoardElement, b: BoardElement): BoardElement {
  if (a.version !== b.version) return a.version > b.version ? a : b
  return (b.versionNonce ?? 0) < (a.versionNonce ?? 0) ? b : a
}

/** A deleted element shrunk to what merging needs: its id, kind, version and that it's deleted. */
export function compactTombstone(el: BoardElement): BoardElement {
  if (!el.isDeleted) return el
  const out: BoardElement = { id: el.id, type: el.type, version: el.version, isDeleted: true }
  if (el.versionNonce !== undefined) out.versionNonce = el.versionNonce
  if (typeof el.index === 'string') out.index = el.index
  return out
}

/** A scene as stored: deleted elements shrunk and unused images dropped. */
export function tidyScene(scene: BoardScene): BoardScene {
  return pruneFiles({ ...scene, elements: scene.elements.map(compactTombstone) })
}

/** Files no live element points at are dropped, so deleted images leave the scene. */
export function pruneFiles(scene: BoardScene): BoardScene {
  const used = new Set(liveElements(scene).flatMap((el) => (el.fileId ? [el.fileId] : [])))
  const files = Object.fromEntries(Object.entries(scene.files).filter(([id]) => used.has(id)))
  return { ...scene, files }
}

/** The fence for the scene block: longer than any run of backticks inside it. */
function fenceFor(json: string): string {
  let longest = 0
  for (const run of json.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The scene as JSON, one element per line. */
export function sceneJson(scene: BoardScene): string {
  const head = `{"type":"excalidraw","version":2,"source":"hearth","elements":[`
  const els = scene.elements.map((el) => JSON.stringify(el)).join(',\n')
  const tail = `],"appState":${JSON.stringify(scene.appState)},"files":${JSON.stringify(scene.files)}}`
  return scene.elements.length > 0 ? `${head}\n${els}\n${tail}` : `${head}${tail}`
}

const NOTE =
  '<!-- A Hotsauce Whiteboard. Open it in Hotsauce to draw; the list is the text on the board. -->'

/** The file body (everything after the frontmatter) for a scene. */
export function boardBodyText(scene: BoardScene): string {
  const texts = boardTexts(scene)
  const list =
    texts.length > 0 ? `${texts.map((t) => `- ${escapeListText(t)}`).join('\n')}\n\n` : ''
  const json = sceneJson(scene)
  const fence = fenceFor(json)
  return `\n${NOTE}\n\n${list}${fence}${BOARD_SCENE_INFO}\n${json}\n${fence}\n`
}

// A line that would read as Markdown structure (a heading, a fence, HTML) is escaped, so the
// list is always a plain list.
function escapeListText(t: string): string {
  return t.replace(/^([#>`~<])/, '\\$1')
}

export interface NewBoard {
  title?: string | undefined
  scene?: BoardScene | undefined
  createdBy: string
  created?: string | undefined
  id?: string | undefined
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A board file's text and path. */
export function newBoardFile(board: NewBoard): { id: string; path: string; text: string } {
  const id = board.id ?? newId()
  const created = board.created ?? isoNow()
  const fields: Record<string, unknown> = {
    id,
    type: 'board',
    title: boardTitle(board.title ?? '') || undefined,
    created,
    created_by: board.createdBy.toLowerCase(),
    updated: created,
  }
  return {
    id,
    path: boardPath(id),
    text: patchFrontmatter(boardBodyText(board.scene ?? EMPTY_SCENE), fields),
  }
}

export class BoardFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoardFormatError'
  }
}

/**
 * The scene in a board file's body. A body without a scene block is an empty board; a block
 * that isn't a valid scene throws `BoardFormatError` (so a save never overwrites it blindly).
 */
export function parseBoardBody(body: string): BoardScene {
  const block = sceneBlock(body)
  if (block === null) return EMPTY_SCENE
  let data: unknown
  try {
    data = JSON.parse(block)
  } catch {
    throw new BoardFormatError('The board’s drawing data isn’t valid JSON')
  }
  const parsed = BoardScene.safeParse(data)
  if (!parsed.success) throw new BoardFormatError('The board’s drawing data isn’t a valid scene')
  return parsed.data
}

/** A closing fence for `fence`: the same character, at least as long, nothing else on the line. */
function closes(line: string, fence: string): boolean {
  const t = line.trim()
  return /^(`{3,}|~{3,})$/.test(t) && t[0] === fence[0] && t.length >= fence.length
}

/** The JSON inside the first fenced `excalidraw` block, or null. */
function sceneBlock(body: string): string | null {
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(lines[i] as string)
    if (!open || open[2] !== BOARD_SCENE_INFO) continue
    const fence = open[1] as string
    const end = lines.findIndex((l, j) => j > i && closes(l, fence))
    if (end < 0) return null
    return lines.slice(i + 1, end).join('\n')
  }
  return null
}

/** The body without its scene block: what full-text search should see for a board. */
export function boardSearchText(body: string): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const open = /^(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line)
    if (fence === null && open && open[2] === BOARD_SCENE_INFO) {
      fence = open[1] as string
      continue
    }
    if (fence !== null) {
      if (closes(line, fence)) fence = null
      continue
    }
    if (
      line.startsWith('<!-- A Hotsauce Whiteboard') ||
      line.startsWith('<!-- A Hearth Whiteboard')
    )
      continue
    out.push(line)
  }
  return out.join('\n')
}
