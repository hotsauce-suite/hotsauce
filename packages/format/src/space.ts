import { parseDocument, stringify } from 'yaml'
import { SpaceConfig } from './schemas.js'

export const SPACE_LAYOUT = {
  docs: 'docs',
  meetings: 'meetings',
  assets: 'assets',
  meta: '.hearth',
  trash: '.trash',
} as const

const SPACE_CONFIG_PATH = `${SPACE_LAYOUT.meta}/space.yaml`

/** The files a new, empty space repo starts with. Throws if the space config would be invalid. */
export function initialSpaceFiles(
  name: string,
  opts: { kind: 'team' | 'personal'; owner?: string },
): Array<{ path: string; content: string }> {
  return [
    { path: 'README.md', content: readme(name) },
    { path: SPACE_CONFIG_PATH, content: serializeSpaceConfig({ name, schema: 1, ...opts }) },
    { path: `${SPACE_LAYOUT.meta}/docs/FORMAT.md`, content: DOCS_FORMAT },
    { path: `${SPACE_LAYOUT.docs}/.gitkeep`, content: '' },
    { path: `${SPACE_LAYOUT.assets}/.gitkeep`, content: '' },
  ]
}

/** Reads `.hearth/space.yaml`. Throws an error that lists every problem. */
export function parseSpaceConfig(yamlText: string): SpaceConfig {
  const doc = parseDocument(yamlText)
  const [error] = doc.errors
  if (error) throw new Error(`Invalid ${SPACE_CONFIG_PATH}: ${error.message}`)
  return validateSpaceConfig(doc.toJS())
}

/** Writes `.hearth/space.yaml`, validating first so an invalid config never reaches Git. */
export function serializeSpaceConfig(config: SpaceConfig): string {
  return stringify(validateSpaceConfig(config))
}

function validateSpaceConfig(value: unknown): SpaceConfig {
  const result = SpaceConfig.safeParse(value)
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(file)'}: ${i.message}`)
    throw new Error(`Invalid ${SPACE_CONFIG_PATH}:\n${lines.join('\n')}`)
  }
  return result.data
}

function readme(name: string): string {
  return `# ${name}

This is a Hearth space: a Git repository of plain files. Hearth reads and writes it, and you can
also clone it and work on it with any editor, script, or agent.

## Layout

- \`docs/\`: documents from Hearth Docs. Folders here are the folders people see.
- \`meetings/\`: meeting notes and transcripts from Hearth Meetings, once there are any.
- \`assets/\`: images and small attachments, linked from documents with relative paths.
- \`.hearth/\`: Hearth's own files. \`space.yaml\` names this space; each app keeps its metadata
  in \`.hearth/<app>/\` and describes its file format in \`.hearth/<app>/FORMAT.md\`.
- \`.trash/\`: deleted files, kept for 30 days.

## Conventions

- Content is markdown with YAML frontmatter.
- Files Hearth manages carry a stable \`id\` (a ULID) in their frontmatter. Keep it when you edit,
  rename, or move a file; links and history depend on it.
- Large binaries (audio, video) are not stored here; they live in object storage with a small
  pointer file in the repo.
`
}

const DOCS_FORMAT = `# Hearth Docs file format

How Hearth Docs stores documents in this space, for people, scripts, and agents working on the
files directly.

## Where documents live

- Every document is a markdown file under \`docs/\`. Folders under \`docs/\` are the folders shown
  in Hearth.
- File names come from the title when the document is created: lowercase \`a-z\`, \`0-9\`, and
  hyphens, for example \`docs/planning/q4-plan.md\`.
- Images and attachments go in \`assets/YYYY/MM/<slug>-<shortid>.<ext>\`.
- Deleted documents move to \`.trash/<date>/<original path>\`.

## Frontmatter

\`\`\`markdown
---
id: 01JA2Z8Q4M7V3K9R5T1XWYB6CD
title: Q4 plan
created: 2026-10-07T14:03:00Z
tags: [planning]
---

# Q4 plan
\`\`\`

- \`id\` is a ULID (26 characters, uppercase Crockford base32). Hearth adds it on first save if it
  is missing. Never change or reuse an \`id\`: it keeps links, search, and history attached to the
  document across renames and moves. A new file may leave it out.
- \`title\`, \`created\` (ISO 8601, UTC), and \`tags\` (a list of strings) are optional.
- Any other keys are kept. Hearth edits only the keys it changes and leaves the rest of the
  file's text exactly as it was.

## Body

- GitHub-flavored markdown. The first \`# Heading\` is the title shown in the editor; keep it in
  step with \`title\`.
- Link to other documents and to assets with ordinary relative links, such as
  \`[Q4 plan](../planning/q4-plan.md)\` or \`![Funnel](../../assets/2026/10/funnel-5T1XWYB6.png)\`.
  \`hearth://<id>\` links to a document by \`id\` and survives any move.
- If you move a file yourself, update its own relative links so they still point at the same
  targets. Hearth does this when the move happens in Hearth.

## Style for files you create

LF line endings, a trailing newline, \`-\` bullets, \`*emphasis*\`, \`**strong**\`, \`#\` headings,
and fenced code blocks. Never reformat text you didn't write.
`
