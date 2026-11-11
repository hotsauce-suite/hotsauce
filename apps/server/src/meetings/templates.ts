import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, SPACE_LAYOUT } from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { GitStore } from '../git/index.js'
import type { SpaceService } from '../spaces/index.js'

export type TemplateSource = 'builtin' | 'team' | 'personal'

export interface TemplateSection {
  /** The heading line as written, e.g. `## Action items`. */
  heading: string
  title: string
  /** What the section should hold: its HTML-comment instructions and any other text under it. */
  instructions: string
}

export interface TemplateDoc {
  id: string
  name: string
  description: string
  source: TemplateSource
  /** Guidance written before the first section heading, if any. */
  preamble: string
  sections: TemplateSection[]
}

/** Custom templates live here in the team space (shared) and a personal space (yours). */
export const TEMPLATES_DIR = `${SPACE_LAYOUT.meta}/meetings/templates`
export const DEFAULT_TEMPLATE = 'general'

// Next to this module in src/ and in dist/ (the build copies the .md files).
const BUILTIN_DIR = fileURLToPath(new URL('./templates/', import.meta.url))
const SECTION_HEADING = /^ {0,3}(#{2,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const COMMENT = /<!--([\s\S]*?)-->/g

/** A template file: frontmatter `{ id, name, description }`, then `##` sections. */
export function parseTemplate(
  text: string,
  fallbackId: string,
  source: TemplateSource,
): TemplateDoc {
  const { data, body } = parseFrontmatter(text)
  const id = nonEmpty(data.id) ?? fallbackId
  const sections: TemplateSection[] = []
  const preamble: string[] = []
  let current: { heading: string; title: string; lines: string[] } | null = null
  const flush = () => {
    if (current) {
      sections.push({
        heading: current.heading,
        title: current.title,
        instructions: instructionsOf(current.lines.join('\n')),
      })
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const match = SECTION_HEADING.exec(line)
    if (match) {
      flush()
      current = { heading: line.trim(), title: match[2] ?? '', lines: [] }
    } else if (current) current.lines.push(line)
    else preamble.push(line)
  }
  flush()
  return {
    id,
    name: nonEmpty(data.name) ?? id,
    description: nonEmpty(data.description) ?? '',
    source,
    preamble: instructionsOf(preamble.join('\n').replace(/^ {0,3}# .*$/m, '')),
    sections,
  }
}

/** The text of a section's comments and prose, one paragraph per line, comment markers gone. */
function instructionsOf(text: string): string {
  return text
    .replace(COMMENT, (_, inner: string) => `\n${inner}\n`)
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The built-in templates, read once from disk. */
export function loadBuiltinTemplates(dir = BUILTIN_DIR): TemplateDoc[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) =>
      parseTemplate(readFileSync(`${dir}/${name}`, 'utf8'), name.slice(0, -3), 'builtin'),
    )
}

/**
 * Built-in templates plus the `.md` files in `.hearth/meetings/templates/` of the team space and
 * the member's personal space, read from Git. A custom template with a built-in's id replaces
 * it; personal wins over team.
 */
export class MeetingTemplates {
  readonly #builtins: TemplateDoc[]
  readonly #git: Pick<GitStore, 'listTree' | 'readFile'>
  readonly #spaces: Pick<SpaceService, 'visibleSpaces'>
  readonly #log: (message: string) => void

  constructor(opts: {
    git: Pick<GitStore, 'listTree' | 'readFile'>
    spaces: Pick<SpaceService, 'visibleSpaces'>
    builtins?: TemplateDoc[]
    log?: (message: string) => void
  }) {
    this.#git = opts.git
    this.#spaces = opts.spaces
    this.#builtins = opts.builtins ?? loadBuiltinTemplates()
    this.#log = opts.log ?? console.warn
  }

  async listTemplates(principal: Principal): Promise<TemplateDoc[]> {
    const byId = new Map<string, TemplateDoc>()
    for (const t of this.#builtins) byId.set(t.id, t)
    const spaces = await this.#spaces.visibleSpaces(principal)
    // Team first, so a personal template with the same id replaces it.
    for (const kind of ['team', 'personal'] as const) {
      for (const space of spaces.filter((s) => s.kind === kind)) {
        for (const t of await this.#readSpace(space.name, kind)) byId.set(t.id, t)
      }
    }
    return [...byId.values()]
  }

  /** The template with this id, or bad_request. */
  async getTemplate(principal: Principal, id: string): Promise<TemplateDoc> {
    const template = (await this.listTemplates(principal)).find((t) => t.id === id)
    if (!template) throw new HearthError('bad_request', `No meeting template "${id}"`)
    return template
  }

  async #readSpace(space: string, source: TemplateSource): Promise<TemplateDoc[]> {
    const files = (await this.#git.listTree(space, TEMPLATES_DIR)).filter(
      (e) => e.type === 'file' && e.path.toLowerCase().endsWith('.md'),
    )
    const templates: TemplateDoc[] = []
    for (const file of files) {
      try {
        const { content } = await this.#git.readFile(space, file.path)
        const stem = file.path.slice(file.path.lastIndexOf('/') + 1, -'.md'.length)
        templates.push(parseTemplate(content, stem, source))
      } catch (err) {
        this.#log(`skipping meeting template ${space}/${file.path}: ${err}`)
      }
    }
    return templates
  }
}
