import { type DragEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { notesApi } from '../../api/notes'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { readKeepExport } from './keepTakeout'
import { errorMessage, notesBus } from './useNotes'

/** Google Takeout with only Keep selected. */
export const TAKEOUT_KEEP_URL = 'https://takeout.google.com/settings/takeout/custom/keep'
const BATCH = 500

type Outcome =
  | { kind: 'done'; imported: number; skipped: number }
  | { kind: 'failed'; message: string }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** `/notes/import`: a one-time import of a Google Keep export (Google Takeout). */
export default function ImportKeep() {
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `Import from Google Keep · ${product()} Notes`
  }, [])

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return
    setOutcome(null)
    setBusy('Reading your export…')
    try {
      const notes = await readKeepExport(files)
      if (notes.length === 0) {
        setOutcome({
          kind: 'failed',
          message:
            'No Keep notes in that. Choose the .zip from Google Takeout, or the .json files in its Keep folder.',
        })
        return
      }
      let imported = 0
      let skipped = 0
      for (let i = 0; i < notes.length; i += BATCH) {
        setBusy(`Importing ${Math.min(i + BATCH, notes.length)} of ${notes.length}…`)
        const r = await notesApi.importKeep(notes.slice(i, i + BATCH))
        imported += r.imported
        skipped += r.skipped
      }
      setOutcome({ kind: 'done', imported, skipped })
      notesBus.emit({ type: 'changed' })
    } catch (err) {
      setOutcome({
        kind: 'failed',
        message: err instanceof Error && !('status' in err) ? err.message : errorMessage(err),
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
      <MeetingsPageHeader title={`${product()} Notes`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-28 md:px-8 md:pt-10">
          <h1 className="font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-ink">
            Import from Google Keep
          </h1>
          <p className="mt-2 text-[0.95rem] text-ink-soft">
            A one-time copy of your Keep notes into your personal notes: text, checklists, labels,
            colors, pins and archived notes. Pictures and drawings stay in Keep. Running it again
            only adds notes it hasn’t imported yet.
          </p>

          <ol className="mt-6 space-y-4">
            <li className="rounded-xl border border-ash bg-paper-raised p-4">
              <p className="font-medium text-ink">1. Export your notes from Google</p>
              <p className="mt-1 text-sm text-ink-soft">
                Google Takeout opens with only Keep selected. Choose “Next step”, then “Create
                export”. Google emails you a link to a .zip, usually within minutes.
              </p>
              <a
                href={TAKEOUT_KEEP_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="keep-takeout-link"
                className={`${primaryButton} mt-3 h-9`}
              >
                Open Google Takeout
                <Icon name="external" />
              </a>
            </li>
            <li className="rounded-xl border border-ash bg-paper-raised p-4">
              <p className="font-medium text-ink">2. Choose the .zip here</p>
              <p className="mt-1 text-sm text-ink-soft">
                Your browser reads the notes out of it; the rest of the file never leaves your
                computer. Several .zip files, or the .json files from its Keep folder, work too.
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
                <span className="text-ink-soft">Drop the .zip here, or</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  data-testid="keep-choose"
                  onClick={() => fileInput.current?.click()}
                  className={`${primaryButton} h-9`}
                >
                  Choose file
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".zip,.json,application/zip,application/json"
                  data-testid="keep-file"
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
                data-testid="keep-result"
                className="rounded-xl border border-moss/40 bg-moss-wash p-4 text-sm text-ink"
              >
                Imported {plural(outcome.imported, 'note')}
                {outcome.skipped > 0
                  ? ` (${plural(outcome.skipped, 'note')} skipped: already imported, empty or in Keep’s trash)`
                  : ''}
                .{' '}
                <Link to="/notes" className="font-medium text-ember-strong hover:underline">
                  See your notes
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
