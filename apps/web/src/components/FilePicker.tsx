import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { type DriveFile, type FolderListing, filesApi, formatBytes } from '../api/files'
import { startUploads } from '../apps/files/uploads'
import { useSession } from '../state/session'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

/**
 * One picker for attaching a Hearth file to a Doc, a meeting note, a Note or a Task (§18.4):
 * browse Team files and My files, search, or upload a new one. Resolves with the link to put in.
 */
export function FilePicker({
  targetSpace,
  onPick,
  onClose,
}: {
  /** Where the link will be read: a personal file going into a team page gets a share link. */
  targetSpace: string
  onPick: (attachment: Attachment) => void
  onClose: () => void
}) {
  const session = useSession()
  const personal = session.spaces.find((s) => s.kind === 'personal')?.name ?? null
  const [space, setSpace] = useState(targetSpace === personal ? personal : 'team')
  const [folder, setFolder] = useState('')
  const [q, setQ] = useState('')
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(
      () =>
        filesApi.list(space, folder, q).then(
          (l) => {
            if (cancelled) return
            setListing(l)
            setError(null)
          },
          (e: unknown) =>
            !cancelled && setError(e instanceof Error ? e.message : 'Couldn’t load files'),
        ),
      q ? 200 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [space, folder, q])

  const pick = async (file: DriveFile) => {
    if (needsShareLink(file, targetSpace) && !file.shareUrl) {
      const ok = window.confirm(
        `Attaching ${file.name} turns on its share link, so everyone who can open this page can open the file.`,
      )
      if (!ok) return
    }
    setBusy(file.name)
    try {
      onPick(await attachmentFor(file, targetSpace))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t attach that file')
      setBusy(null)
    }
  }

  const upload = async (files: File[]) => {
    if (files.length === 0) return
    setBusy(files.length === 1 ? (files[0]?.name ?? '') : `${files.length} files`)
    const done = await startUploads(files, { space, folder })
    if (done.length === 0) {
      setBusy(null)
      setError('The upload didn’t finish')
      return
    }
    // One at a time: several uploads attach the first and leave the rest in Files.
    const first = done[0]
    if (first) await pick(first)
  }

  return (
    <Dialog title="Attach a file" onClose={onClose} testId="file-picker">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div
            role="tablist"
            aria-label="Where"
            className="flex rounded-lg border border-ash p-0.5 text-sm"
          >
            {[
              { name: 'team', label: 'Team files' },
              ...(personal ? [{ name: personal, label: 'My files' }] : []),
            ].map((s) => (
              <button
                key={s.name}
                type="button"
                role="tab"
                aria-selected={space === s.name}
                onClick={() => {
                  setSpace(s.name)
                  setFolder('')
                }}
                className={`rounded-md px-2.5 py-1 ${space === s.name ? 'bg-paper-sunk text-ink' : 'text-ink-soft'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label="Search files"
            data-testid="file-picker-search"
            className="h-8 min-w-0 flex-1 rounded-lg border border-ash bg-paper px-2.5 text-sm"
          />
        </div>
        {folder ? (
          <button
            type="button"
            className="flex items-center gap-1 self-start text-sm text-ink-soft hover:text-ink"
            onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}
          >
            <Icon name="back" className="size-3.5" />
            {folder}
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-ember-strong">
            {error}
          </p>
        ) : null}
        <ul
          className="max-h-72 min-h-32 divide-y divide-ash/70 overflow-y-auto"
          data-testid="file-picker-list"
        >
          {listing === null ? <li className="py-2 text-sm text-ink-faint">Loading…</li> : null}
          {listing?.folders.map((f) => (
            <li key={f}>
              <button
                type="button"
                className="flex w-full items-center gap-2 py-2 text-left text-sm text-ink"
                onClick={() => setFolder(f)}
              >
                <Icon name="folder" className="size-4 text-ember" />
                {f.split('/').pop()}
              </button>
            </li>
          ))}
          {listing?.files.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                disabled={busy !== null}
                data-testid="file-picker-item"
                className="flex w-full items-center gap-2 py-2 text-left text-sm text-ink disabled:opacity-50"
                onClick={() => void pick(f)}
              >
                <Icon name="file" className="size-4 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-ink-faint">{formatBytes(f.size)}</span>
              </button>
            </li>
          ))}
          {listing && listing.files.length === 0 && listing.folders.length === 0 ? (
            <li className="py-6 text-center text-sm text-ink-faint">
              {q ? 'No files match.' : 'No files here yet.'}
            </li>
          ) : null}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <Link to="/files" className="text-xs text-ink-soft hover:text-ink" onClick={onClose}>
            Open Files
          </Link>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => input.current?.click()}
            data-testid="file-picker-upload"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-50"
          >
            <Icon name="upload" />
            {busy ? `Attaching ${busy}…` : 'Upload new'}
          </button>
          <input
            ref={input}
            type="file"
            hidden
            data-testid="file-picker-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              void upload(files)
            }}
          />
        </div>
      </div>
    </Dialog>
  )
}

export interface Attachment {
  name: string
  /** Where it opens in Hearth. */
  url: string
  /** A Markdown link to it. */
  markdown: string
}

/**
 * The link to attach: the file's own page, or its share link when it's in a personal space and
 * the page it goes into isn't (so teammates reading the page can open it too).
 */
export async function attachmentFor(file: DriveFile, targetSpace: string): Promise<Attachment> {
  let url = file.url
  if (needsShareLink(file, targetSpace)) {
    const shared = file.shareUrl ? file : await filesApi.share(file.space, file.id, true)
    url = shared.shareUrl ?? file.url
  }
  const label = file.name.replace(/([\\[\]])/g, '\\$1')
  return { name: file.name, url, markdown: `[${label}](${url})` }
}

/** A personal file going into a page outside that space is opened through its share link. */
function needsShareLink(file: DriveFile, targetSpace: string): boolean {
  return file.space !== 'team' && file.space !== targetSpace
}

const LINK = /\[((?:\\.|[^\]\\])+)\]\((\/files\/(?:s\/[A-Za-z0-9_-]+|[^/\s)]+\/[0-9A-Z]{26}))\)/g

/** The Hearth Files links in some text, in order, without repeats. */
export function attachmentsIn(text: string): Array<{ name: string; url: string }> {
  const seen = new Set<string>()
  const out: Array<{ name: string; url: string }> = []
  for (const m of text.matchAll(LINK)) {
    const url = m[2] ?? ''
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ name: (m[1] ?? '').replace(/\\(.)/g, '$1'), url })
  }
  return out
}

/** The text with each Files link shown as just its name (the chips carry the link). */
export function withoutAttachmentLinks(text: string): string {
  return text.replace(LINK, (_, name: string) => name.replace(/\\(.)/g, '$1'))
}

/** Attached files as chips that open them. */
export function AttachmentChips({ text, className = '' }: { text: string; className?: string }) {
  const found = attachmentsIn(text)
  if (found.length === 0) return null
  return (
    <ul className={`flex flex-wrap gap-1.5 ${className}`} data-testid="attachment-chips">
      {found.map((a) => (
        <li key={a.url}>
          <Link
            to={a.url}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex max-w-56 items-center gap-1 rounded-full border border-ash bg-paper-raised px-2 py-0.5 text-xs text-ink hover:border-ember"
          >
            <Icon name="paperclip" className="size-3 shrink-0 text-ink-faint" />
            <span className="truncate">{a.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
