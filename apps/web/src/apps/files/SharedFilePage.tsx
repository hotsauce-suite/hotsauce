import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { filesApi, formatBytes, type SharedFile } from '../../api/files'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { FilePreview } from './Preview'

/** `/files/s/:token`: a file someone shared by link, for any signed-in member. */
export default function SharedFilePage() {
  const { token = '' } = useParams()
  const [file, setFile] = useState<SharedFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    filesApi.shared(token).then(
      (f) => {
        if (cancelled) return
        setFile(f)
        document.title = `${f.name} · ${product()} Files`
      },
      (e: unknown) =>
        !cancelled && setError(e instanceof Error ? e.message : 'Couldn’t open the link'),
    )
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <>
      <MeetingsPageHeader title={file?.name ?? 'Shared file'}>
        {file ? (
          <a
            href={file.downloadUrl}
            className={`${primaryButton} h-9`}
            data-testid="shared-download"
          >
            <Icon name="download" />
            <span className="hidden sm:inline">Download</span>
          </a>
        ) : null}
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="shared-file">
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 px-4 pt-5 pb-24 md:px-8">
          {error ? (
            <p role="alert" className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {file ? (
            <>
              <p className="text-xs text-ink-faint">
                Shared by {file.createdBy} · {formatBytes(file.size)}
              </p>
              <div className="flex min-h-[60vh] flex-1 items-center justify-center">
                <FilePreview file={file} />
              </div>
            </>
          ) : !error ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : null}
        </div>
      </div>
    </>
  )
}
