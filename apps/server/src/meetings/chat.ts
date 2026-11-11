import { chunkMarkdown, parseTranscript, transcriptPathFor } from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { GitStore } from '../git/index.js'
import type { Index } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'
import { folderPrefix, matchesCompany, matchesPerson } from './list.js'
import type { LLM, LLMUsage } from './llm/types.js'

export interface ChatScope {
  space?: string
  meetingPath?: string
  folder?: string
  person?: string
  company?: string
}

export interface Citation {
  space: string
  path: string
  /** 1-based line in the file where the cited passage starts. */
  line: number
  text: string
}

/** A passage of a note or transcript, as the model sees it. */
export type Chunk = Citation

type ChatIndex = Pick<Index, 'search' | 'listFiles' | 'getFile' | 'rankPassages'>

const MAX_CHUNKS = 12
// Files to read for chunks; bm25 over files picks them.
const MAX_FILES = 8
// Meetings to read when the scope is a person or company.
const MAX_SCOPED_MEETINGS = 20
const NOTE_CHUNK_CHARS = 800
const TRANSCRIPT_LINES_PER_CHUNK = 3
const NOTHING_FOUND = "I couldn't find anything about that in your meetings."

const SYSTEM = `You answer questions about the user's meetings using only the numbered excerpts from their meeting notes and transcripts.

- Cite the excerpts you used after each claim, by number in square brackets, like [3] or [2][5].
- If the excerpts don't answer the question, say so plainly. Don't guess and don't use outside knowledge.
- In transcripts, "Me" is the person who took the notes and "Them" is the other side of the call.
- Be concise. Use a Markdown list when there are several things.`

/**
 * Questions over meetings with citations (ARCHITECTURE §7.1). Retrieval is full-text: bm25 picks
 * the meeting notes and transcripts in the member's visible spaces (narrowed by the scope), they
 * are read from Git and cut into passages, bm25 again picks the best 12, and the model sees them
 * as `[n] <space>/<path>#L<line>: text`. Its `[n]` citations come back as file and line.
 */
export class MeetingChat {
  readonly #index: ChatIndex
  readonly #git: Pick<GitStore, 'readFile'>
  readonly #llm: LLM
  readonly #model: string
  readonly #spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'>

  constructor(
    index: ChatIndex,
    git: Pick<GitStore, 'readFile'>,
    llm: LLM,
    opts: { model: string; spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'> },
  ) {
    this.#index = index
    this.#git = git
    this.#llm = llm
    this.#model = opts.model
    this.#spaces = opts.spaces
  }

  async ask(
    principal: Principal,
    input: { question: string; scope: ChatScope },
  ): Promise<{ answer: string; citations: Citation[]; usage: LLMUsage }> {
    const { question, scope } = input
    const spaces = await this.#scopeSpaces(principal, scope)
    const files = await this.#candidates(question, spaces, scope)
    const chunks = (await Promise.all(files.map((f) => this.#chunksOf(f.space, f.path)))).flat()
    const picked = this.#pick(question, chunks, scope.meetingPath !== undefined)
    if (picked.length === 0) {
      return { answer: NOTHING_FOUND, citations: [], usage: { input: 0, output: 0 } }
    }
    const excerpts = picked.map((c, i) => `[${i + 1}] ${c.space}/${c.path}#L${c.line}: ${c.text}`)
    const { text, usage } = await this.#llm.complete({
      model: this.#model,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `<excerpts>\n${excerpts.join('\n\n')}\n</excerpts>\n\nQuestion: ${question.trim()}`,
        },
      ],
    })
    return { ...resolveCitations(text, picked), usage }
  }

  async #scopeSpaces(principal: Principal, scope: ChatScope): Promise<string[]> {
    if (scope.space !== undefined) {
      if (!this.#spaces.canAccess(principal, scope.space)) {
        throw new HearthError('forbidden', `You don't have access to the space "${scope.space}"`)
      }
      return [scope.space]
    }
    if (scope.meetingPath !== undefined) {
      throw new HearthError('bad_request', 'A meeting scope needs its space')
    }
    return (await this.#spaces.visibleSpaces(principal)).map((s) => s.name)
  }

  async #candidates(
    question: string,
    spaces: string[],
    scope: ChatScope,
  ): Promise<Array<{ space: string; path: string }>> {
    const prefix = folderPrefix(scope.folder)
    if (scope.meetingPath !== undefined) {
      const space = spaces[0] ?? ''
      const note = scope.meetingPath
      const transcript = this.#transcriptOf(space, note)
      return transcript === null
        ? [{ space, path: note }]
        : [
            { space, path: note },
            { space, path: transcript },
          ]
    }
    if (scope.person !== undefined || scope.company !== undefined) {
      const meetings = spaces
        .flatMap((space) =>
          this.#index
            .listFiles({ space, kind: 'meeting', prefix, order: 'date_desc' })
            .filter((f) => matchesPerson(f.frontmatter, scope.person))
            .filter((f) => matchesCompany(f.frontmatter, scope.company)),
        )
        .sort((a, b) => dateOf(b.frontmatter).localeCompare(dateOf(a.frontmatter)))
        .slice(0, MAX_SCOPED_MEETINGS)
      return meetings.flatMap((m) => {
        const transcriptPath = transcriptPathFor(m.path, m.frontmatter ?? {})
        return transcriptPath === null
          ? [{ space: m.space, path: m.path }]
          : [
              { space: m.space, path: m.path },
              { space: m.space, path: transcriptPath },
            ]
      })
    }
    return this.#index
      .search(question, {
        spaces,
        kinds: ['meeting', 'transcript'],
        anyTerm: true,
        limit: MAX_FILES,
        prefix,
      })
      .map((hit) => ({ space: hit.space, path: hit.path }))
  }

  #transcriptOf(space: string, notePath: string): string | null {
    const fm = this.#index.getFile(space, notePath)?.frontmatter ?? {}
    return transcriptPathFor(notePath, fm)
  }

  async #chunksOf(space: string, path: string): Promise<Chunk[]> {
    let content: string
    try {
      content = (await this.#git.readFile(space, path)).content
    } catch (err) {
      // An index entry for a file gone since, or a transcript left in another space.
      if (err instanceof HearthError && err.code === 'not_found') return []
      throw err
    }
    return chunkFile(space, path, content)
  }

  /** The best passages by bm25; for one meeting, topped up in file order so it always has context. */
  #pick(question: string, chunks: Chunk[], wholeMeeting: boolean): Chunk[] {
    const ranked = this.#index.rankPassages(
      question,
      chunks.map((c) => c.text),
      MAX_CHUNKS,
    )
    const picked = ranked.map((r) => chunks[r.index]).filter((c): c is Chunk => c !== undefined)
    if (wholeMeeting) {
      for (const chunk of chunks) {
        if (picked.length >= MAX_CHUNKS) break
        if (!picked.includes(chunk)) picked.push(chunk)
      }
    }
    return picked
  }
}

/**
 * Passages of one file with the line each starts on. A transcript is cut every few transcript
 * lines; a note by `chunkMarkdown` (its sections, split when long).
 */
export function chunkFile(space: string, path: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/)
  if (path.toLowerCase().endsWith('.transcript.md')) {
    const chunks: Chunk[] = []
    let group: Array<{ line: number; text: string }> = []
    const flush = () => {
      const first = group[0]
      if (first)
        chunks.push({ space, path, line: first.line, text: group.map((g) => g.text).join('\n') })
      group = []
    }
    lines.forEach((text, i) => {
      if (parseTranscript(text).length === 0) return
      group.push({ line: i + 1, text })
      if (group.length === TRANSCRIPT_LINES_PER_CHUNK) flush()
    })
    flush()
    return chunks
  }
  return chunkMarkdown(content, NOTE_CHUNK_CHARS).map((chunk) => ({
    space,
    path,
    line: lineAt(content, chunk.from),
    text: chunk.text,
  }))
}

/**
 * Citations in order of first use, and the answer with its `[n]` renumbered to match: `[1]` is
 * `citations[0]`. Numbers that name no passage are dropped, and a combined marker such as
 * `[2, 5]` is written back as one marker per citation (`[1][2]`), which is what the web links.
 */
export function resolveCitations(
  answer: string,
  chunks: Chunk[],
): { answer: string; citations: Citation[] } {
  const used: number[] = []
  const renumbered = answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, list: string) => {
    const numbers = list
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= chunks.length)
      .map((n) => {
        if (!used.includes(n - 1)) used.push(n - 1)
        return used.indexOf(n - 1) + 1
      })
    return [...new Set(numbers)].map((n) => `[${n}]`).join('')
  })
  const citations = used.map((i) => {
    const { space, path, line, text } = chunks[i] as Chunk
    return { space, path, line, text }
  })
  return { answer: renumbered, citations }
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

function dateOf(frontmatter: Record<string, unknown> | null): string {
  return stringField(frontmatter, 'date') ?? ''
}

function stringField(frontmatter: Record<string, unknown> | null, key: string): string | undefined {
  const value = frontmatter?.[key]
  return typeof value === 'string' ? value : undefined
}
