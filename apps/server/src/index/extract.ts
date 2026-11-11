import { parse as parseYaml } from 'yaml'

/** `meeting` is a note under `meetings/`, `transcript` its `.transcript.md` sibling (ARCHITECTURE §7.1). */
export type FileKind = 'docs' | 'meeting' | 'transcript' | 'other'

export interface ExtractedDoc {
  id: string | null
  title: string
  kind: FileKind
  /** Markdown with the frontmatter block removed; this is what full-text search sees. */
  body: string
  /** The parsed frontmatter mapping; null when there is none, or it isn't a valid YAML mapping. */
  frontmatter: Record<string, unknown> | null
}

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ATX_H1 = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/

/** Markdown files outside hidden folders (.hearth metadata, .trash, editor config). */
export function isIndexable(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && !path.split('/').some((s) => s.startsWith('.'))
}

export function kindOf(path: string): FileKind {
  const top = path.split('/', 1)[0]
  if (top === 'docs') return 'docs'
  if (top !== 'meetings') return 'other'
  return path.toLowerCase().endsWith('.transcript.md') ? 'transcript' : 'meeting'
}

/** Title is frontmatter `title`, else the first H1, else the filename without `.md`. */
export function extractDoc(path: string, text: string): ExtractedDoc {
  const { frontmatter, body } = splitFrontmatter(text)
  const data = frontmatter ?? {}
  return {
    id: typeof data.id === 'string' ? data.id : null,
    title: frontmatterTitle(data) ?? firstH1(body) ?? fileStem(path),
    kind: kindOf(path),
    body,
    frontmatter,
  }
}

function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown> | null
  body: string
} {
  const match = FRONTMATTER.exec(text)
  if (!match) return { frontmatter: null, body: text }
  return { frontmatter: parseYamlObject(match[1] ?? ''), body: text.slice(match[0].length) }
}

function parseYamlObject(yaml: string): Record<string, unknown> | null {
  // An empty block is an empty mapping.
  if (yaml.trim() === '') return {}
  try {
    const value: unknown = parseYaml(yaml)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    // Files pushed from outside Hearth can carry broken YAML; still index them.
    return null
  }
}

function frontmatterTitle(data: Record<string, unknown>): string | null {
  const t = data.title
  if (typeof t !== 'string' && typeof t !== 'number') return null
  return String(t).trim() || null
}

function firstH1(body: string): string | null {
  let fence: string | null = null
  for (const line of body.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = ATX_H1.exec(line)?.[1]?.trim()
    if (heading) return heading
  }
  return null
}

function fileStem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
}
