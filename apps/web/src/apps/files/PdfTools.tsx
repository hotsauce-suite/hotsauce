// PDF tools (docs/PLAN-pdf-tools.md): one panel for a PDF in Files, with Pages (combine, reorder,
// rotate, remove), Split, Shrink, Make searchable and Redact. The browser does the work and every
// result is uploaded as a new PDF beside the original, which never changes.

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { type DriveFile, filesApi, formatBytes, uploadFile } from '../../api/files'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { macReader } from '../../lib/pdf/ocr'
import type { PdfView, ShownBox } from '../../lib/pdf/render'
import {
  type PagePick,
  PdfToolError,
  parseRanges,
  rangeLabel,
  resultName,
  type ShrinkLevel,
} from '../../lib/pdf/tools'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import { filesBus } from './bus'

export type PdfTab = 'pages' | 'split' | 'shrink' | 'searchable' | 'redact'

const TABS: Array<{ id: PdfTab; label: string }> = [
  { id: 'pages', label: 'Pages' },
  { id: 'split', label: 'Split' },
  { id: 'shrink', label: 'Shrink' },
  { id: 'searchable', label: 'Make searchable' },
  { id: 'redact', label: 'Redact' },
]

export const isPdfFile = (f: { mime: string; preview?: string }) =>
  f.mime === 'application/pdf' || f.preview === 'pdf'

interface Source {
  name: string
  bytes: Uint8Array
  view: PdfView
}

interface PageCard extends PagePick {
  key: string
  rotate: number
}

function message(err: unknown): string {
  if (err instanceof PdfToolError) return err.message
  return err instanceof Error && err.message ? err.message : 'Something went wrong'
}

const fetchBytes = (f: DriveFile) => filesApi.pdf(f.space, f.id)

async function loadSource(name: string, bytes: Uint8Array): Promise<Source> {
  const [{ openView }, { pageCount }] = await Promise.all([
    import('../../lib/pdf/render'),
    import('../../lib/pdf/tools'),
  ])
  // pdf-lib first: it says plainly when a file is locked or broken.
  await pageCount(bytes)
  return { name, bytes, view: await openView(bytes) }
}

/** A page drawn small, cached per source and page. */
function Thumb({
  view,
  page,
  rotate,
  side = 220,
}: {
  view: PdfView
  page: number
  rotate: number
  side?: number
}) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void import('../../lib/pdf/render').then(async ({ drawPage }) => {
      try {
        const canvas = await drawPage(view, page, side)
        if (live) setSrc(canvas.toDataURL('image/jpeg', 0.8))
        canvas.width = 0
      } catch {
        if (live) setSrc('')
      }
    })
    return () => {
      live = false
    }
  }, [view, page, side])
  return (
    <div className="grid aspect-[3/4] w-full place-items-center overflow-hidden rounded-md bg-paper-sunk">
      {src ? (
        <img
          src={src}
          alt={`Page ${page}`}
          className="max-h-full max-w-full shadow-sm transition-transform"
          style={{ transform: `rotate(${rotate}deg)${rotate % 180 ? ' scale(0.75)' : ''}` }}
        />
      ) : (
        <span className="text-xs text-ink-faint">{src === '' ? 'Can’t show' : '…'}</span>
      )}
    </div>
  )
}

export function PdfTools({
  file,
  initialTab = 'pages',
  withFiles = [],
  onClose,
  onOpen,
}: {
  file: DriveFile
  initialTab?: PdfTab | undefined
  /** More PDFs to start Pages with (several dropped on the Mac app's icon, R10). */
  withFiles?: DriveFile[] | undefined
  onClose: () => void
  /** Opens a saved result. */
  onOpen: (f: DriveFile) => void
}) {
  const [tab, setTab] = useState<PdfTab>(initialTab)
  const [sources, setSources] = useState<Source[]>([])
  const [pages, setPages] = useState<PageCard[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ files: DriveFile[]; note?: string | undefined } | null>(null)
  const [picking, setPicking] = useState(false)
  const nextKey = useRef(1)
  const computer = useRef<HTMLInputElement>(null)
  const sourcesRef = useRef<Source[]>([])
  sourcesRef.current = sources

  const cardsFor = (source: number, count: number): PageCard[] =>
    Array.from({ length: count }, (_, index) => ({
      key: `p${nextKey.current++}`,
      source,
      index,
      rotate: 0,
    }))

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per file opened
  useEffect(() => {
    let live = true
    let handed = false
    const loaded: Source[] = []
    void (async () => {
      try {
        const all = [file, ...withFiles.filter((f) => f.id !== file.id && isPdfFile(f))]
        for (const f of all) {
          const s = await loadSource(f.name, await fetchBytes(f))
          loaded.push(s)
        }
        if (!live) return
        handed = true
        setSources(loaded)
        setPages(loaded.flatMap((s, i) => cardsFor(i, s.view.numPages)))
      } catch (err) {
        if (live) setLoadError(message(err))
      }
    })()
    return () => {
      live = false
      if (!handed) for (const s of loaded) void s.view.destroy()
    }
  }, [file.space, file.id])

  useEffect(
    () => () => {
      for (const s of sourcesRef.current) void s.view.destroy()
    },
    [],
  )

  const addSource = async (name: string, bytes: Uint8Array) => {
    const s = await loadSource(name, bytes)
    // Counted here, not from the last render, so two quick adds each get their own place.
    const index = sourcesRef.current.length
    sourcesRef.current = [...sourcesRef.current, s]
    setSources((prev) => [...prev, s])
    setPages((prev) => [...prev, ...cardsFor(index, s.view.numPages)])
  }

  const save = async (results: Array<{ name: string; bytes: Uint8Array }>, note?: string) => {
    const stored: DriveFile[] = []
    for (const r of results) {
      const blob = Object.assign(new Blob([r.bytes as BlobPart], { type: 'application/pdf' }), {
        name: r.name,
      })
      stored.push(await uploadFile(blob, { space: file.space, folder: file.folder }))
    }
    filesBus.emit({ type: 'changed' })
    setSaved({ files: stored, note })
  }

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setSaved(null)
    try {
      await work()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(null)
    }
  }

  const original = sources[0]

  return (
    <Dialog
      title={`PDF tools: ${file.name}`}
      onClose={busy ? () => {} : onClose}
      wide
      testId="pdf-tools"
    >
      <div className="flex flex-col gap-4">
        <div
          role="tablist"
          aria-label="PDF tools"
          className="flex flex-wrap gap-1 border-b border-ash pb-2"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`pdf-tab-${t.id}`}
              disabled={!!busy}
              onClick={() => {
                setTab(t.id)
                setError(null)
                setSaved(null)
              }}
              className={`rounded-md px-3 py-1.5 text-sm ${
                tab === t.id ? 'bg-ember-wash font-medium text-ink' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loadError ? (
          <p
            role="alert"
            className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink"
            data-testid="pdf-tools-error"
          >
            {loadError}
          </p>
        ) : !original ? (
          <p className="text-sm text-ink-faint">Opening the PDF…</p>
        ) : tab === 'pages' ? (
          <PagesTab
            sources={sources}
            pages={pages}
            setPages={setPages}
            busy={!!busy}
            onAddFromFiles={() => setPicking(true)}
            onAddFromComputer={() => computer.current?.click()}
            onSave={() =>
              run('Saving…', async () => {
                const { assemble } = await import('../../lib/pdf/tools')
                const bytes = await assemble(
                  sources.map((s) => s.bytes),
                  pages.map(({ source, index, rotate }) => ({ source, index, rotate })),
                )
                const used = new Set(pages.map((p) => p.source))
                await save([
                  { name: resultName(file.name, used.size > 1 ? 'combined' : 'edited'), bytes },
                ])
              })
            }
          />
        ) : tab === 'split' ? (
          <SplitTab
            pageCount={original.view.numPages}
            busy={!!busy}
            onSplit={(groups) =>
              run('Splitting…', async () => {
                const { assemble } = await import('../../lib/pdf/tools')
                const results = []
                for (const g of groups) {
                  results.push({
                    name: resultName(file.name, rangeLabel(g)),
                    bytes: await assemble(
                      [original.bytes],
                      g.map((index) => ({ source: 0, index })),
                    ),
                  })
                }
                await save(results)
              })
            }
          />
        ) : tab === 'shrink' ? (
          <ShrinkTab
            size={original.bytes.length}
            busy={!!busy}
            onShrink={(level) =>
              run('Shrinking…', async () => {
                const { shrinkPdf } = await import('../../lib/pdf/run')
                const result = await shrinkPdf(original.bytes, level)
                if (!result.smaller) {
                  setSaved({
                    files: [],
                    note: 'This PDF is already about as small as it gets, so nothing was saved.',
                  })
                  return
                }
                await save(
                  [{ name: resultName(file.name, 'smaller'), bytes: result.bytes }],
                  `${formatBytes(original.bytes.length)} → ${formatBytes(result.bytes.length)}`,
                )
              })
            }
          />
        ) : tab === 'searchable' ? (
          <SearchableTab
            busy={busy}
            onRun={() =>
              run('Reading the pages…', async () => {
                const { makeSearchable } = await import('../../lib/pdf/run')
                const result = await makeSearchable(original.bytes, (done, total) =>
                  setBusy(
                    total
                      ? `Reading page ${Math.min(done + 1, total)} of ${total}…`
                      : 'Checking the pages…',
                  ),
                )
                if (result.read === 0) {
                  setSaved({
                    files: [],
                    note: 'Every page already has text you can search, so nothing was saved.',
                  })
                  return
                }
                await save(
                  [{ name: resultName(file.name, 'searchable'), bytes: result.bytes }],
                  result.skipped
                    ? `Read ${result.read} page${result.read === 1 ? '' : 's'}; ${result.skipped} already had text.`
                    : undefined,
                )
              })
            }
          />
        ) : (
          <RedactTab
            view={original.view}
            busy={busy}
            onRedact={(boxes) =>
              run('Redacting…', async () => {
                const { redact } = await import('../../lib/pdf/run')
                const bytes = await redact(original.bytes, boxes, (done, total) =>
                  setBusy(`Redacting page ${Math.min(done + 1, total)} of ${total}…`),
                )
                await save([{ name: resultName(file.name, 'redacted'), bytes }])
              })
            }
          />
        )}

        {busy && tab !== 'searchable' && tab !== 'redact' ? (
          <p className="text-sm text-ink-soft" role="status">
            {busy}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink"
            data-testid="pdf-tools-error"
          >
            {error}
          </p>
        ) : null}
        {saved ? (
          <div
            role="status"
            data-testid="pdf-tools-saved"
            className="flex flex-col gap-2 rounded-lg border border-ash bg-paper-sunk px-3 py-2 text-sm text-ink"
          >
            {saved.files.length ? (
              <p>
                Saved{' '}
                {saved.files.length === 1
                  ? `“${saved.files[0]?.name}”`
                  : `${saved.files.length} PDFs`}{' '}
                beside the original.{saved.note ? ` ${saved.note}` : ''}
              </p>
            ) : (
              <p>{saved.note}</p>
            )}
            {saved.files.length ? (
              <ul className="flex flex-wrap gap-2">
                {saved.files.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={`${secondaryButton} h-8`}
                      data-testid="pdf-tools-open"
                      onClick={() => onOpen(f)}
                    >
                      Open {saved.files.length > 1 ? f.name : ''}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      <input
        ref={computer}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        data-testid="pdf-tools-input"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])]
          e.target.value = ''
          void run('Adding…', async () => {
            for (const f of list) await addSource(f.name, new Uint8Array(await f.arrayBuffer()))
          })
        }}
      />
      {picking ? (
        <PdfPicker
          space={file.space}
          folder={file.folder}
          onClose={() => setPicking(false)}
          onPick={(f) => {
            setPicking(false)
            void run('Adding…', async () => addSource(f.name, await fetchBytes(f)))
          }}
        />
      ) : null}
    </Dialog>
  )
}

const iconButton =
  'grid size-7 place-items-center rounded-md text-ink-soft hover:bg-paper-sunk hover:text-ink disabled:opacity-40'

function PagesTab({
  sources,
  pages,
  setPages,
  busy,
  onAddFromFiles,
  onAddFromComputer,
  onSave,
}: {
  sources: Source[]
  pages: PageCard[]
  setPages: (f: (p: PageCard[]) => PageCard[]) => void
  busy: boolean
  onAddFromFiles: () => void
  onAddFromComputer: () => void
  onSave: () => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)
  const move = (from: number, to: number) =>
    setPages((list) => {
      if (to < 0 || to >= list.length) return list
      const next = [...list]
      const [card] = next.splice(from, 1)
      if (card) next.splice(to, 0, card)
      return next
    })
  const patch = (key: string, fn: (c: PageCard) => PageCard | null) =>
    setPages((list) => list.flatMap((c) => (c.key === key ? (fn(c) ?? []) : [c])))
  const letter = (i: number) => (sources.length > 1 ? `${String.fromCharCode(65 + (i % 26))} ` : '')
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">
        Turn, move or remove pages, or add pages from other PDFs, then save a new PDF beside this
        one.
        {sources.length > 1
          ? ` Letters show which PDF a page came from: ${sources.map((s, i) => `${letter(i).trim()} ${s.name}`).join(', ')}.`
          : ''}
      </p>
      <ol
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
        data-testid="pdf-pages"
      >
        {pages.map((card, i) => {
          const source = sources[card.source]
          if (!source) return null
          return (
            <li
              key={card.key}
              data-testid="pdf-page"
              data-rotate={card.rotate}
              draggable={!busy}
              onDragStart={(e) => {
                setDragging(card.key)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (dragging) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = pages.findIndex((p) => p.key === dragging)
                if (from >= 0) move(from, i)
                setDragging(null)
              }}
              onDragEnd={() => setDragging(null)}
              className={`flex flex-col gap-1 rounded-lg border p-2 ${
                dragging === card.key ? 'border-ember opacity-60' : 'border-ash'
              }`}
            >
              <Thumb view={source.view} page={card.index + 1} rotate={card.rotate} />
              <div className="flex items-center justify-between text-xs text-ink-soft">
                <span className="tabular-nums" title={source.name}>
                  {i + 1}
                  <span className="text-ink-faint">
                    {' '}
                    · {letter(card.source)}p{card.index + 1}
                  </span>
                </span>
                <span className="flex">
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Turn page ${i + 1} left`}
                    disabled={busy}
                    onClick={() =>
                      patch(card.key, (c) => ({ ...c, rotate: (c.rotate + 270) % 360 }))
                    }
                  >
                    <Icon name="rotateLeft" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Turn page ${i + 1} right`}
                    data-testid="pdf-page-rotate"
                    disabled={busy}
                    onClick={() =>
                      patch(card.key, (c) => ({ ...c, rotate: (c.rotate + 90) % 360 }))
                    }
                  >
                    <Icon name="rotate" />
                  </button>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex">
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Move page ${i + 1} earlier`}
                    disabled={busy || i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    <Icon name="back" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Move page ${i + 1} later`}
                    data-testid="pdf-page-later"
                    disabled={busy || i === pages.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    <Icon name="forward" />
                  </button>
                </span>
                <button
                  type="button"
                  className={iconButton}
                  aria-label={`Remove page ${i + 1}`}
                  data-testid="pdf-page-remove"
                  disabled={busy || pages.length === 1}
                  onClick={() => patch(card.key, () => null)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${secondaryButton} h-9`}
            disabled={busy}
            onClick={onAddFromFiles}
            data-testid="pdf-add-files"
          >
            <Icon name="plus" />
            Add a PDF from Files
          </button>
          <button
            type="button"
            className={`${secondaryButton} h-9`}
            disabled={busy}
            onClick={onAddFromComputer}
          >
            <Icon name="upload" />
            Add from this computer
          </button>
        </span>
        <button
          type="button"
          className={`${primaryButton} h-9`}
          disabled={busy || pages.length === 0}
          onClick={onSave}
          data-testid="pdf-pages-save"
        >
          Save as new PDF
        </button>
      </div>
    </div>
  )
}

function SplitTab({
  pageCount,
  busy,
  onSplit,
}: {
  pageCount: number
  busy: boolean
  onSplit: (groups: number[][]) => void
}) {
  const [mode, setMode] = useState<'each' | 'ranges'>('ranges')
  const [ranges, setRanges] = useState(
    pageCount > 1 ? `1-${Math.ceil(pageCount / 2)}, ${Math.ceil(pageCount / 2) + 1}-` : '1',
  )
  const [error, setError] = useState<string | null>(null)
  const go = () => {
    setError(null)
    if (mode === 'each') return onSplit(Array.from({ length: pageCount }, (_, i) => [i]))
    try {
      onSplit(parseRanges(ranges, pageCount))
    } catch (err) {
      setError(message(err))
    }
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-ink-soft">
        This PDF has {pageCount} page{pageCount === 1 ? '' : 's'}. Each part is saved as its own PDF
        beside this one.
      </p>
      <label className="flex items-center gap-2">
        <input type="radio" checked={mode === 'ranges'} onChange={() => setMode('ranges')} />
        Pages I choose
      </label>
      {mode === 'ranges' ? (
        <div className="ml-6 flex flex-col gap-1">
          <input
            value={ranges}
            onChange={(e) => setRanges(e.target.value)}
            aria-label="Pages for each part"
            data-testid="pdf-split-ranges"
            className="h-9 max-w-sm rounded-lg border border-ash bg-paper px-3"
          />
          <span className="text-xs text-ink-faint">
            Commas between parts, like 1-3, 5, 8- (8- runs to the end).
          </span>
        </div>
      ) : null}
      <label className="flex items-center gap-2">
        <input
          type="radio"
          checked={mode === 'each'}
          onChange={() => setMode('each')}
          data-testid="pdf-split-each"
        />
        Every page on its own ({pageCount} PDF{pageCount === 1 ? '' : 's'})
      </label>
      {error ? (
        <p role="alert" className="text-ember-strong" data-testid="pdf-split-error">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          className={`${primaryButton} h-9`}
          disabled={busy}
          onClick={go}
          data-testid="pdf-split-save"
        >
          <Icon name="scissors" />
          Split
        </button>
      </div>
    </div>
  )
}

const LEVELS: Array<{ id: ShrinkLevel; label: string; hint: string }> = [
  { id: 'email', label: 'For email', hint: 'Smallest. Pictures look fine on a screen.' },
  { id: 'balanced', label: 'Balanced', hint: 'Smaller, still good for printing.' },
  {
    id: 'keep',
    label: 'Keep quality',
    hint: 'Pictures stay as they are; only the file is tidied.',
  },
]

function ShrinkTab({
  size,
  busy,
  onShrink,
}: {
  size: number
  busy: boolean
  onShrink: (level: ShrinkLevel) => void
}) {
  const [level, setLevel] = useState<ShrinkLevel>('email')
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-ink-soft">
        This PDF is {formatBytes(size)}. Shrinking saves a smaller copy beside it.
      </p>
      {LEVELS.map((l) => (
        <label key={l.id} className="flex items-start gap-2">
          <input
            type="radio"
            className="mt-1"
            checked={level === l.id}
            onChange={() => setLevel(l.id)}
            data-testid={`pdf-shrink-${l.id}`}
          />
          <span>
            <span className="font-medium text-ink">{l.label}</span>
            <span className="block text-xs text-ink-faint">{l.hint}</span>
          </span>
        </label>
      ))}
      <div className="flex justify-end">
        <button
          type="button"
          className={`${primaryButton} h-9`}
          disabled={busy}
          onClick={() => onShrink(level)}
          data-testid="pdf-shrink-save"
        >
          <Icon name="shrink" />
          Shrink
        </button>
      </div>
    </div>
  )
}

function SearchableTab({ busy, onRun }: { busy: string | null; onRun: () => void }) {
  const onMac = macReader() !== null
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-ink-soft">
        Reads the words on scanned pages and adds them as hidden text, so you can search, select and
        copy them. The pages look the same. Pages that already have text are left as they are.
      </p>
      <p className="text-xs text-ink-faint">
        {onMac
          ? 'Your Mac reads the pages itself. Searchable text works for English and other languages written in the Latin alphabet.'
          : 'Reads English. The first time, it fetches a 9 MB reading kit from this server.'}
      </p>
      {busy ? (
        <p role="status" className="text-ink-soft" data-testid="pdf-searchable-progress">
          {busy}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          className={`${primaryButton} h-9`}
          disabled={!!busy}
          onClick={onRun}
          data-testid="pdf-searchable-run"
        >
          <Icon name="search" />
          Make searchable
        </button>
      </div>
    </div>
  )
}

function RedactPage({
  view,
  page,
  boxes,
  onAdd,
  onRemove,
  disabled,
}: {
  view: PdfView
  page: number
  boxes: ShownBox[]
  onAdd: (b: ShownBox) => void
  onRemove: (i: number) => void
  disabled: boolean
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  )
  const area = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    void import('../../lib/pdf/render')
      .then(async ({ drawPage }) => {
        const canvas = await drawPage(view, page, 1100)
        if (live) setSrc(canvas.toDataURL('image/jpeg', 0.85))
        canvas.width = 0
      })
      .catch(() => {
        if (live) setSrc('')
      })
    return () => {
      live = false
    }
  }, [view, page])
  const at = (e: ReactPointerEvent) => {
    const r = area.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  const shown = draft
    ? {
        x: Math.min(draft.x0, draft.x1),
        y: Math.min(draft.y0, draft.y1),
        width: Math.abs(draft.x1 - draft.x0),
        height: Math.abs(draft.y1 - draft.y0),
      }
    : null
  return (
    <figure className="flex flex-col items-center gap-1">
      <div
        ref={area}
        data-testid="pdf-redact-page"
        className={`relative w-full max-w-2xl touch-none select-none overflow-hidden rounded-md border border-ash bg-paper ${
          disabled ? '' : 'cursor-crosshair'
        }`}
        onPointerDown={(e) => {
          if (disabled || (e.target as HTMLElement).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          const p = at(e)
          setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
        }}
        onPointerMove={(e) => {
          if (!draft) return
          const p = at(e)
          setDraft({ ...draft, x1: p.x, y1: p.y })
        }}
        onPointerUp={() => {
          if (shown && shown.width > 0.005 && shown.height > 0.004) onAdd(shown)
          setDraft(null)
        }}
      >
        {src ? (
          <img src={src} alt={`Page ${page}`} className="block w-full" draggable={false} />
        ) : (
          <div className="flex aspect-[3/4] w-full items-center justify-center bg-paper-sunk text-xs text-ink-faint">
            {src === '' ? 'This page can’t be shown' : null}
          </div>
        )}
        {boxes.map((b, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: boxes are only added or removed
            key={i}
            data-testid="pdf-redact-box"
            className="group absolute bg-ink/85 outline outline-2 outline-ember"
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              width: `${b.width * 100}%`,
              height: `${b.height * 100}%`,
            }}
          >
            {disabled ? null : (
              <button
                type="button"
                aria-label="Remove this box"
                className="absolute -top-2.5 -right-2.5 grid size-5 place-items-center rounded-full bg-paper-raised text-ink shadow-float"
                onClick={() => onRemove(i)}
              >
                <Icon name="close" className="size-3" />
              </button>
            )}
          </div>
        ))}
        {shown ? (
          <div
            className="absolute border-2 border-dashed border-ember bg-ink/40"
            style={{
              left: `${shown.x * 100}%`,
              top: `${shown.y * 100}%`,
              width: `${shown.width * 100}%`,
              height: `${shown.height * 100}%`,
            }}
          />
        ) : null}
      </div>
      <figcaption className="text-xs text-ink-faint">Page {page}</figcaption>
    </figure>
  )
}

function RedactTab({
  view,
  busy,
  onRedact,
}: {
  view: PdfView
  busy: string | null
  onRedact: (boxes: Map<number, ShownBox[]>) => void
}) {
  const [boxes, setBoxes] = useState<Map<number, ShownBox[]>>(new Map())
  const [find, setFind] = useState('')
  const [found, setFound] = useState<string | null>(null)
  const [finding, setFinding] = useState(false)
  const total = [...boxes.values()].reduce((n, b) => n + b.length, 0)
  const pagesWith = [...boxes.values()].filter((b) => b.length).length
  const add = (page: number, list: ShownBox[]) =>
    setBoxes((prev) => {
      const next = new Map(prev)
      next.set(page, [...(next.get(page) ?? []), ...list])
      return next
    })
  const findAll = async () => {
    setFinding(true)
    setFound('Finding…')
    try {
      const { findText } = await import('../../lib/pdf/render')
      let count = 0
      for (let n = 1; n <= view.numPages; n++) {
        const list = await findText(view, n, find)
        if (list.length) add(n - 1, list)
        count += list.length
      }
      setFound(
        count
          ? `Boxed ${count} place${count === 1 ? '' : 's'}. Check each page before saving.`
          : 'Not found. Scanned pages have no text to find: draw boxes on them instead.',
      )
    } catch {
      setFound('Couldn’t search this PDF’s text. Draw boxes on the pages instead.')
    } finally {
      setFinding(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-ink-soft">
        Drag across what to hide, or find words to box them everywhere. Saving paints the boxes
        solid black and turns those pages into pictures, so nothing under a box can be copied or
        recovered. Other pages stay as they are.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (find.trim()) void findAll()
        }}
      >
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find words to black out"
          aria-label="Find words to black out"
          data-testid="pdf-redact-find"
          className="h-9 min-w-0 flex-1 rounded-lg border border-ash bg-paper px-3"
        />
        <button
          type="submit"
          className={`${secondaryButton} h-9`}
          disabled={!!busy || finding || !find.trim()}
          data-testid="pdf-redact-find-go"
        >
          Box every match
        </button>
      </form>
      {found ? (
        <p className="text-xs text-ink-soft" data-testid="pdf-redact-found">
          {found}
        </p>
      ) : null}
      <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto rounded-lg bg-paper-sunk p-3">
        {Array.from({ length: view.numPages }, (_, i) => (
          <RedactPage
            // biome-ignore lint/suspicious/noArrayIndexKey: pages are fixed and in order
            key={i}
            view={view}
            page={i + 1}
            boxes={boxes.get(i) ?? []}
            disabled={!!busy}
            onAdd={(b) => add(i, [b])}
            onRemove={(j) =>
              setBoxes((prev) => {
                const next = new Map(prev)
                next.set(
                  i,
                  (next.get(i) ?? []).filter((_, k) => k !== j),
                )
                return next
              })
            }
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-faint" role="status">
          {busy ??
            (total
              ? `${total} box${total === 1 ? '' : 'es'} on ${pagesWith} page${pagesWith === 1 ? '' : 's'}`
              : 'No boxes yet')}
        </span>
        <span className="flex gap-2">
          {total ? (
            <button
              type="button"
              className={`${secondaryButton} h-9`}
              disabled={!!busy}
              onClick={() => setBoxes(new Map())}
            >
              Clear boxes
            </button>
          ) : null}
          <button
            type="button"
            className={`${primaryButton} h-9`}
            disabled={!!busy || finding || total === 0}
            onClick={() => onRedact(boxes)}
            data-testid="pdf-redact-save"
          >
            <Icon name="eyeOff" />
            Redact and save
          </button>
        </span>
      </div>
    </div>
  )
}

/** Picks another PDF from Files to add to Pages. */
function PdfPicker({
  space,
  folder,
  onPick,
  onClose,
}: {
  space: string
  folder: string
  onPick: (f: DriveFile) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<DriveFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(
      () =>
        filesApi.list(space, q ? '' : folder, q).then(
          (l) => live && setFiles(l.files.filter(isPdfFile)),
          (e: unknown) => live && setError(message(e)),
        ),
      q ? 200 : 0,
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [space, folder, q])
  return (
    <Dialog title="Add a PDF from Files" onClose={onClose} testId="pdf-picker">
      <div className="flex flex-col gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search PDFs"
          aria-label="Search PDFs"
          className="h-9 rounded-lg border border-ash bg-paper px-3 text-sm"
        />
        {error ? <p className="text-sm text-ember-strong">{error}</p> : null}
        {files === null ? <p className="text-sm text-ink-faint">Loading…</p> : null}
        {files?.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {q ? 'No PDFs match.' : 'No other PDFs in this folder. Search to look everywhere.'}
          </p>
        ) : null}
        <ul className="flex max-h-80 flex-col divide-y divide-ash/70 overflow-y-auto">
          {files?.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                data-testid="pdf-picker-file"
                className="flex w-full items-center gap-3 py-2 text-left text-sm hover:text-ember-strong"
                onClick={() => onPick(f)}
              >
                <Icon name="docs" className="size-4 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-ink-faint">{formatBytes(f.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}
