import { type DragEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { type ImportResult, memberTimeZone, tasksApi } from '../../api/tasks'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { errorMessage, tasksBus } from './useTaskList'

const TOKEN_HELP = 'https://app.todoist.com/app/settings/integrations/developer'

type Outcome = { kind: 'done'; result: ImportResult } | { kind: 'failed'; message: string }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** `/tasks/import`: a one-time import from Todoist, by API token or exported CSV files. */
export default function ImportTodoist() {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `Import from Todoist · ${product()} Tasks`
  }, [])

  const run = async (jobs: Array<() => Promise<ImportResult>>) => {
    setBusy(true)
    setOutcome(null)
    const total: ImportResult = { imported: 0, skipped: 0, projects: [] }
    try {
      for (const job of jobs) {
        const r = await job()
        total.imported += r.imported
        total.skipped += r.skipped
        for (const p of r.projects) if (!total.projects.includes(p)) total.projects.push(p)
      }
      setOutcome({ kind: 'done', result: total })
      tasksBus.emit({ type: 'changed' })
    } catch (err) {
      setOutcome({ kind: 'failed', message: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const importToken = () => {
    const t = token.trim()
    if (!t) return
    void run([() => tasksApi.importTodoist({ token: t, tz: memberTimeZone() })]).then(() =>
      setToken(''),
    )
  }

  const importFiles = (files: FileList | File[]) => {
    const csvs = [...files].filter((f) => /\.csv$/i.test(f.name) || f.type === 'text/csv')
    if (csvs.length === 0) {
      setOutcome({ kind: 'failed', message: 'Drop the .csv files Todoist exported.' })
      return
    }
    void run(
      csvs.map((file) => async () => {
        const csv = await file.text()
        return tasksApi.importTodoist({
          csv,
          projectName: file.name.replace(/\.csv$/i, ''),
          tz: memberTimeZone(),
        })
      }),
    )
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    importFiles(event.dataTransfer.files)
  }

  return (
    <>
      <MeetingsPageHeader title={`${product()} Tasks`} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="tasks-import">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-8 md:pt-10">
          <h1 className="font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-ink">
            Import from Todoist
          </h1>
          <p className="mt-2 text-[0.95rem] text-ink-soft">
            Brings your Todoist tasks into your personal space once: projects, sections (as labels),
            labels, priorities, dates and repeats. Importing again only adds tasks that are new
            since.
          </p>

          <section className="mt-8 rounded-xl border border-ash bg-paper-raised/50 p-5">
            <h2 className="font-display text-lg font-semibold tracking-tight">With an API token</h2>
            <p className="mt-1 text-sm text-ink-soft">
              Copy it from{' '}
              <a
                href={TOKEN_HELP}
                target="_blank"
                rel="noreferrer"
                className="text-ink underline decoration-ash-strong underline-offset-2 hover:decoration-ember"
              >
                Todoist → Settings → Integrations → Developer
              </a>
              . {product()} uses it for this import only and never stores it.
            </p>
            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault()
                importToken()
              }}
            >
              <input
                type="password"
                aria-label="Todoist API token"
                data-testid="todoist-token"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your API token"
                className="h-10 min-w-0 flex-1 rounded-lg border border-ash bg-paper-raised px-3 font-mono text-sm text-ink placeholder:font-ui placeholder:text-ink-faint focus:border-ember focus:outline-none"
              />
              <button
                type="submit"
                data-testid="todoist-import"
                disabled={!token.trim() || busy}
                className={primaryButton}
              >
                Import
              </button>
            </form>
          </section>

          {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop zone; its button is the keyboard way in. */}
          <section
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            data-testid="todoist-drop"
            className={`mt-4 rounded-xl border border-dashed p-5 transition-colors ${over ? 'border-ember bg-ember-wash' : 'border-ash-strong bg-paper-raised/30'}`}
          >
            <h2 className="font-display text-lg font-semibold tracking-tight">Or from CSV files</h2>
            <p className="mt-1 text-sm text-ink-soft">
              In Todoist, open a project’s menu → Export as a template → Download as CSV. Drop the
              files here; each becomes a project named after its file.
            </p>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-ash-strong px-4 text-sm text-ink hover:border-ember disabled:opacity-50"
            >
              <Icon name="upload" />
              Choose CSV files
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              multiple
              hidden
              data-testid="todoist-files"
              onChange={(e) => {
                if (e.target.files) importFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </section>

          <div aria-live="polite" className="mt-6">
            {busy ? <p className="text-sm text-ink-soft">Importing…</p> : null}
            {outcome?.kind === 'failed' ? (
              <p role="alert" className="text-sm text-ember-strong">
                {outcome.message}
              </p>
            ) : null}
            {outcome?.kind === 'done' ? (
              <div
                data-testid="todoist-result"
                className="rounded-xl border border-ash bg-moss-wash px-4 py-3 text-sm text-ink"
              >
                <p className="font-medium">
                  Imported {plural(outcome.result.imported, 'task')}
                  {outcome.result.skipped ? `; skipped ${outcome.result.skipped} already here` : ''}
                  .
                </p>
                {outcome.result.projects.length > 0 ? (
                  <p className="mt-1 text-ink-soft">
                    Projects: {outcome.result.projects.join(', ')}
                  </p>
                ) : null}
                <Link
                  to="/tasks"
                  className="mt-2 inline-block text-ink underline decoration-ash-strong underline-offset-2 hover:decoration-ember"
                >
                  Go to your tasks
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
