// Web-only helpers over @hearth/format, which owns how Hearth files look.

import { extractTitle, parseFrontmatter, patchFrontmatter, slugify } from '@hearth/format'

/** What a new doc is called until its author types a title over it. */
export const NEW_DOC_TITLE = 'Untitled'

export interface Property {
  key: string
  value: string | string[]
}

/** Frontmatter data as display fields, in file order: lists as items, anything else as text. */
export function propertyList(data: Record<string, unknown>): Property[] {
  return Object.entries(data).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? value.map(displayValue) : displayValue(value),
  }))
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** The first `# H1` of the body, whatever the frontmatter `title` says. */
export function firstHeading(text: string): string | null {
  return extractTitle(parseFrontmatter(text).body)
}

/**
 * The file a retitled doc could move to (Docs PRD §5: the slug comes from the title, and
 * renaming the title offers to rename the file): the new title's slug, same folder. Null until
 * the title differs from the one the doc was opened with, or when the name already fits.
 */
export function renameTarget(
  path: string,
  openedTitle: string | null,
  title: string | null,
): string | null {
  if (title === null || title === openedTitle) return null
  const target = `${path.slice(0, path.lastIndexOf('/') + 1)}${slugify(title)}.md`
  return target === path ? null : target
}

/**
 * Keeps frontmatter `title` in step with the first H1 (Docs PRD §4.1). It only moves when the
 * two agreed in `base`, the version being edited, so a title someone set apart from the heading
 * on purpose is left alone. Only the `title` line changes.
 */
export function syncTitle(base: string, next: string): string {
  const title = parseFrontmatter(next).data.title
  if (typeof title !== 'string') return next
  const heading = firstHeading(next)
  if (heading === null || heading === title.trim()) return next
  if (title.trim() !== firstHeading(base)) return next
  try {
    return patchFrontmatter(next, { title: heading })
  } catch {
    // Frontmatter Hearth can't patch in place stays as written; the server says so on save.
    return next
  }
}
