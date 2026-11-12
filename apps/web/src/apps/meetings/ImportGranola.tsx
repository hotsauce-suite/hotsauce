import { type DragEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { HearthApiError } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton } from './components/common'
import { batches, readGranolaExport } from './granolaExport'

/** Granola's settings, where "Generate CSV" is (Settings → Profile). */
export const GRANOLA_SETTINGS_URL = 'https://notes.granola.ai/settings/profile'

type Outcome =
  | { kind: 'done'; imported: number; skipped: number }
  | { kind: 'failed'; message: string }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** `/meetings/import`: a one-time, re-runnable import of Granola's CSV export. */
export default function ImportGranola() {
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `Import from Granola · ${product()} Meetings`
  }, [])

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return
    setOutcome(null)
    setBusy('Reading your export…')
    let imported = 0
    let skipped = 0
    try {
      const meetings = await readGranolaExport(files)
      if (meetings.length === 0) {
        setOutcome({
          kind: 'failed',
          message:
            'No Granola meetings in that. Choose the .csv (or .zip) from Granola’s export email.',
        })
        return
      }
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      let done = 0
      setBusy(`Importing ${meetings.length === 1 ? 'one meeting' : `${meetings.length} meetings`}…`)
      try {
        for (const batch of batches(meetings)) {
          const r = await meetingsApi.importGranola(batch, tz)
          imported += r.imported
          skipped += r.skipped
          done += batch.length
          setBusy(`Imported ${done} of ${meetings.length}…`)
        }
      } catch (err) {
        const reason =
          err instanceof HearthApiError || err instanceof Error
            ? err.message
            : 'Something went wrong.'
        setOutcome({
          kind: 'failed',
          message:
            `${imported > 0 ? `Imported ${plural(imported, 'meeting')}, then the import stopped: ` : 'The import stopped: '}` +
            `${reason} Run it again with the same file to finish; meetings already imported are skipped.`,
        })
        return
      }
      setOutcome({ kind: 'done', imported, skipped })
    } catch (err) {
      setOutcome({
        kind: 'failed',
        message:
          err instanceof Error ? err.message : 'That file couldn’t be read. Try the export again.',
      })
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (busy !== null) return
    void importFiles([...e.dataTransfer.files])
  }

  return (
    <>
      <MeetingsPageHeader title="Import from Granola" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-28 md:px-8 md:pt-10">
          <h1 className="font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-ink">
            Import from Granola
          </h1>
          <p className="mt-2 text-[0.95rem] text-ink-soft">
            A copy of your past Granola meetings into your personal meetings: your notes, Granola’s
            summary and the transcript, so Ask, search and your Agent brief cover them too. Running
            it again only adds meetings it hasn’t imported yet.
          </p>

          <ol className="mt-6 space-y-4">
            <li className="rounded-xl border border-ash bg-paper-raised p-4">
              <p className="font-medium text-ink">1. Ask Granola for your export</p>
              <p className="mt-1 text-sm text-ink-soft">
                In Granola, open Settings, then Profile, and choose “Generate CSV”. Granola emails
                you a link within a few hours. It includes the meetings you own that have a summary.
              </p>
              <a
                href={GRANOLA_SETTINGS_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="granola-settings-link"
                className={`${primaryButton} mt-3 h-9`}
              >
                Open Granola settings
                <Icon name="external" />
              </a>
            </li>
            <li className="rounded-xl border border-ash bg-paper-raised p-4">
              <p className="font-medium text-ink">2. Choose the file here</p>
              <p className="mt-1 text-sm text-ink-soft">
                The .csv from the email, or the .zip it came in. Your browser reads it and sends the
                meetings to your personal space.
              </p>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop zone; the button inside is the keyboard path */}
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
                className={`mt-3 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-sm ${over ? 'border-ember bg-ember-wash' : 'border-ash-strong'}`}
              >
                <Icon name="upload" className="size-6 text-ink-faint" />
                <span className="text-ink-soft">Drop the file here, or</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  data-testid="granola-choose"
                  onClick={() => fileInput.current?.click()}
                  className={`${primaryButton} h-9`}
                >
                  Choose file
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".csv,.zip,text/csv,application/zip"
                  data-testid="granola-file"
                  className="hidden"
                  onChange={(e) => {
                    void importFiles([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
              </div>
            </li>
          </ol>

          <div aria-live="polite" className="mt-5">
            {busy ? <p className="text-sm text-ink-soft">{busy}</p> : null}
            {outcome?.kind === 'done' ? (
              <div
                data-testid="granola-result"
                className="rounded-xl border border-moss/40 bg-moss-wash p-4 text-sm text-ink"
              >
                Imported {plural(outcome.imported, 'meeting')}
                {outcome.skipped > 0
                  ? ` (${plural(outcome.skipped, 'meeting')} skipped: already imported, undated or empty)`
                  : ''}
                .{' '}
                <Link to="/meetings" className="font-medium text-ember-strong hover:underline">
                  See your meetings
                </Link>
              </div>
            ) : null}
            {outcome?.kind === 'failed' ? (
              <p role="alert" className="text-sm text-ember-strong">
                {outcome.message}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
