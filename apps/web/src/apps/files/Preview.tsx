import type { PreviewKind } from '@hearth/format'
import { MAX_FILE_TEXT_CHARS } from '@hearth/format'
import { useEffect, useState } from 'react'
import { filesApi } from '../../api/files'

/** The file itself in the browser: image, PDF, video, audio or its text; else a download card. */
export function FilePreview({
  file,
  space,
}: {
  file: { id: string; name: string; preview: PreviewKind; contentUrl: string; downloadUrl: string }
  /** Set for a file the viewer can see in its space; text previews read the pulled-out text. */
  space?: string
}) {
  switch (file.preview) {
    case 'image':
      return (
        <img
          src={file.contentUrl}
          alt={file.name}
          data-testid="file-preview-image"
          className="mx-auto max-h-full max-w-full object-contain"
        />
      )
    case 'pdf':
      return (
        <iframe
          src={file.contentUrl}
          title={file.name}
          data-testid="file-preview-pdf"
          className="h-full min-h-[60vh] w-full rounded-md border border-ash bg-paper"
        />
      )
    case 'video':
      return (
        // biome-ignore lint/a11y/useMediaCaption: members' own recordings have no caption track
        <video
          src={file.contentUrl}
          controls
          playsInline
          data-testid="file-preview-video"
          className="mx-auto max-h-full max-w-full rounded-md bg-ink"
        />
      )
    case 'audio':
      return (
        // biome-ignore lint/a11y/useMediaCaption: members' own recordings have no caption track
        <audio src={file.contentUrl} controls data-testid="file-preview-audio" className="w-full" />
      )
    case 'text':
      return space ? <TextPreview space={space} file={file} /> : <NoPreview file={file} />
    default:
      return <NoPreview file={file} />
  }
}

function TextPreview({
  space,
  file,
}: {
  space: string
  file: { id: string; name: string; downloadUrl: string }
}) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    filesApi.text(space, file.id).then(
      (f) => !cancelled && setText(f.text),
      () => !cancelled && setText(''),
    )
    return () => {
      cancelled = true
    }
  }, [space, file.id])
  if (text === null) return <p className="text-sm text-ink-faint">Loading…</p>
  // No text read (too big, or unreadable): offer the download rather than say it's empty.
  if (!text) return <NoPreview file={file} />
  return (
    <div className="flex h-full flex-col gap-2">
      {text.length >= MAX_FILE_TEXT_CHARS ? (
        <p className="text-xs text-ink-soft">
          Showing the first part of this file.{' '}
          <a href={file.downloadUrl} className="underline">
            Download it
          </a>{' '}
          for the rest.
        </p>
      ) : null}
      <pre
        data-testid="file-preview-text"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-ash bg-paper p-4 font-mono text-[13px] leading-relaxed text-ink"
      >
        {text}
      </pre>
    </div>
  )
}

function NoPreview({ file }: { file: { name: string; downloadUrl: string } }) {
  return (
    <div
      data-testid="file-preview-none"
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-ash-strong p-10 text-center"
    >
      <p className="text-sm text-ink-soft">There’s no preview for this kind of file.</p>
      <a
        href={file.downloadUrl}
        className="inline-flex h-10 items-center rounded-lg bg-ember px-4 text-sm font-medium text-paper-raised hover:bg-ember-strong"
      >
        Download {file.name}
      </a>
    </div>
  )
}
