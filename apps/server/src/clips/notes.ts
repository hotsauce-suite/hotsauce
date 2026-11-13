import {
  docPath,
  formatTranscriptLine,
  meetingPaths,
  newId,
  patchFrontmatter,
} from '@hearth/format'
import type { ClipSpeaker } from './service.js'
import type { ClipRecord } from './store.js'

export type NoteKind = 'doc' | 'meeting'

/**
 * Model output goes on a page and into Git: images are dropped, so a transcript that talks the
 * model into writing `![](https://…?secret)` can't make every reader's browser fetch a URL.
 */
export function stripImages(markdown: string): string {
  // Every image form starts `![` (inline, reference, nested brackets): drop the `!` and what's
  // left is at most a link, which nothing fetches until someone clicks it.
  return markdown.replace(/!(?=\[)/g, '').replace(/<img\b[^>]*>?/gi, '')
}

/** Only `- [ ] …` lines; an empty string when the model found none. */
export function checklistOnly(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*] \[[ xX]\] \S/.test(l))
    .map((l) => l.replace(/^[-*] \[[xX]\]/, '- [ ]').replace(/^\* /, '- '))
    .join('\n')
}

function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * A note about a clip, for the member's space: a Hearth Doc (`docs/clips/<slug>.md`) or a
 * Meetings note (`meetings/YYYY/MM/<date>-<slug>.md`, `type: meeting`, so its unticked action
 * items show on Meetings home). Title, link to the clip, summary, action items, and the transcript
 * when asked for: in the doc, or as the meeting's own `.transcript.md`, which Meetings shows in
 * its transcript panel. Frontmatter carries `clip:` with the link back.
 */
export function clipNote(args: {
  kind: NoteKind
  clip: ClipRecord
  speakers: ClipSpeaker[]
  url: string
  withTranscript: boolean
  now: Date
}): { path: string; content: string; transcript?: { path: string; content: string } } {
  const { clip, url } = args
  const title = clip.title.replace(/\s+/g, ' ').trim() || 'Clip'
  const recorded = new Date(clip.createdAt)
  const when = recorded.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const length = clip.durationMs ? ` · ${stamp(clip.durationMs / 1000)}` : ''
  const summary = clip.aiSummary ?? clip.summary
  const lines = [
    `# ${title}`,
    '',
    `[Watch the clip](${url})${length} · recorded by ${clip.ownerName} on ${when}`,
    '',
  ]
  if (summary) lines.push('## Summary', '', stripImages(summary).trim(), '')
  if (clip.aiActions !== null) {
    lines.push('## Action items', '', clip.aiActions.trim() || '_None found._', '')
  }
  const names = new Map(args.speakers.map((s) => [s.id, s.name]))
  const meetingTranscript =
    args.kind === 'meeting' && args.withTranscript && clip.transcript.length > 0
  if (args.kind === 'doc' && args.withTranscript && clip.transcript.length > 0) {
    lines.push('## Transcript', '')
    for (const seg of clip.transcript) {
      const who = seg.speaker === undefined ? '' : `**${names.get(seg.speaker) ?? 'Speaker'}** `
      lines.push(`${who}[${stamp(seg.start)}] ${seg.text.replace(/\s*\r?\n\s*/g, ' ')}`, '')
    }
  }
  const body = `\n${lines.join('\n').trimEnd()}\n`
  if (args.kind === 'meeting') {
    const paths = meetingPaths(recorded, title)
    const transcript = meetingTranscript
      ? {
          path: paths.transcript,
          content: `# ${title}: transcript\n\n${clip.transcript
            .map((seg) =>
              formatTranscriptLine({
                at: seg.start,
                speaker:
                  seg.speaker === undefined
                    ? clip.ownerName
                    : (names.get(seg.speaker) ?? 'Speaker'),
                text: seg.text,
              }),
            )
            .join('\n')}\n`,
        }
      : undefined
    const content = patchFrontmatter(body, {
      id: newId(),
      type: 'meeting',
      title,
      date: clip.createdAt,
      ...(clip.durationMs
        ? { duration_min: Math.max(1, Math.round(clip.durationMs / 60_000)) }
        : {}),
      clip: url,
      ...(transcript
        ? { transcript: transcript.path.slice(transcript.path.lastIndexOf('/') + 1) }
        : {}),
    })
    return { path: paths.note, content, ...(transcript ? { transcript } : {}) }
  }
  const content = patchFrontmatter(body, {
    id: newId(),
    title,
    created: args.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    clip: url,
  })
  return { path: docPath('clips', title), content }
}

/** `a.md`, then `a-2.md`, `a-3.md`, … : the first that `exists` says is free. */
export async function freePath(
  path: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(path))) return path
  const base = path.replace(/\.md$/, '')
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}.md`
    if (!(await exists(candidate))) return candidate
  }
  return `${base}-${Date.now()}.md`
}
