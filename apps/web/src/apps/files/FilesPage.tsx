import { useCallback, useEffect, useRef, useState } from 'react'
import { useMatches, useNavigate, useParams, useSearchParams } from 'react-router'
import { type DriveFile, type FolderListing, filesApi, formatBytes } from '../../api/files'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon, type IconName } from '../../components/Icon'
import { Menu, type MenuAnchor, MenuItem } from '../../components/Menu'
import { useListKeys } from '../../keyboard/listKeys'
import { useShortcut } from '../../keyboard/shortcuts'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { filesBus } from './bus'
import { FilePreview } from './Preview'
import type { FilesRouteKind } from './routes'
import { clearFinishedUploads, startUploads, useUploads } from './uploads'

function useKind(): FilesRouteKind {
  const matches = useMatches()
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.handle as { filesKind?: FilesRouteKind } | undefined
    if (handle?.filesKind) return handle.filesKind
  }
  return 'browse'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}

const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export function iconFor(mime: string): IconName {
  if (mime.startsWith('image/')) return 'palette'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'mic'
  if (mime === 'application/pdf' || mime.includes('word') || mime.startsWith('text/')) return 'docs'
  return 'file'
}

type Dialogs =
  | { kind: 'new-folder' }
  | { kind: 'rename'; file: DriveFile }
  | { kind: 'rename-folder'; folder: string }
  | { kind: 'move'; file: DriveFile }
  | { kind: 'delete'; file: DriveFile }
  | { kind: 'delete-folder'; folder: string }
  | null

/** `/files`: one folder of Team files or My files, Recent, and a file open on top. */
export default function FilesPage() {
  const kind = useKind()
  const params = useParams()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const session = useSession()
  const personal = session.spaces.find((s) => s.kind === 'personal')?.name ?? null
  // An open file shows on top of the folder it's in.
  const openSpace = kind === 'item' ? (params.space ?? 'team') : null
  const openId = kind === 'item' ? (params.id ?? '') : null
  const [open, setOpen] = useState<DriveFile | null>(null)
  const space = openSpace ?? search.get('space') ?? 'team'
  const folder = kind === 'item' ? (open?.folder ?? '') : (search.get('folder') ?? '')
  const [q, setQ] = useState('')
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [recent, setRecent] = useState<DriveFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [menu, setMenu] = useState<{
    anchor: MenuAnchor
    file?: DriveFile
    folder?: string
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const spaceLabel = space === personal ? 'My files' : space === 'team' ? 'Team files' : space

  useEffect(() => {
    document.title = `${product()} Files`
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(
    () =>
      filesBus.on((e) => {
        if (e.type === 'pick-upload') input.current?.click()
        if (e.type === 'changed') setTick((n) => n + 1)
      }),
    [],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick refetches after a change.
  useEffect(() => {
    let cancelled = false
    if (kind === 'recent') {
      filesApi.recent().then(
        (r) => {
          if (cancelled) return
          setRecent(r)
          setError(null)
        },
        (e: unknown) => !cancelled && setError(message(e)),
      )
      return () => {
        cancelled = true
      }
    }
    if (kind === 'item' && !open) return
    const timer = setTimeout(
      () =>
        filesApi.list(space, folder, q).then(
          (l) => {
            if (cancelled) return
            setListing(l)
            setError(null)
          },
          (e: unknown) => !cancelled && setError(message(e)),
        ),
      q ? 200 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [kind, space, folder, q, tick, open?.folder])

  useEffect(() => {
    if (!openSpace || !openId) {
      setOpen(null)
      return
    }
    let cancelled = false
    filesApi.get(openSpace, openId).then(
      (f) => !cancelled && setOpen(f),
      (e: unknown) => !cancelled && setError(message(e)),
    )
    return () => {
      cancelled = true
    }
  }, [openSpace, openId])

  const goFolder = (f: string) => {
    const p = new URLSearchParams()
    if (space !== 'team') p.set('space', space)
    if (f) p.set('folder', f)
    setQ('')
    navigate(`/files${p.size ? `?${p}` : ''}`)
  }
  const openFile = (f: DriveFile) => navigate(f.url)
  const closeFile = () => goFolder(open?.folder ?? '')

  const upload = useCallback(
    (files: FileList | File[]) => {
      if (files.length === 0) return
      void startUploads(files, { space, folder }).then((done) => {
        if (done.length > 0) setTick((n) => n + 1)
      })
    },
    [space, folder],
  )

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) setToast(ok)
      setTick((n) => n + 1)
      filesBus.emit({ type: 'changed' })
    } catch (err) {
      setToast(message(err))
    }
  }

  const copyShare = async (file: DriveFile) => {
    try {
      const shared = file.shareUrl ? file : await filesApi.share(file.space, file.id, true)
      const url = `${window.location.origin}${shared.shareUrl}`
      await navigator.clipboard?.writeText(url).catch(() => {})
      setToast('Link copied. Anyone signed in to the team can open it.')
      if (open?.id === file.id) setOpen(shared)
      setTick((n) => n + 1)
    } catch (err) {
      setToast(message(err))
    }
  }

  const crumbs = folder ? folder.split('/') : []
  const files = kind === 'recent' ? (recent ?? []) : (listing?.files ?? [])
  const folders = kind === 'recent' ? [] : (listing?.folders ?? [])
  useListKeys()
  useShortcut('files.upload', () => {
    input.current?.click()
    return true
  })
  const loading = kind === 'recent' ? recent === null : listing === null

  return (
    <>
      <MeetingsPageHeader title={`${product()} Files`}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${spaceLabel.toLowerCase()}`}
          aria-label="Search files"
          data-testid="files-search"
          className="hidden h-9 w-56 rounded-lg border border-ash bg-paper px-3 text-sm sm:block"
        />
        {kind !== 'recent' ? (
          <button
            type="button"
            className={`${secondaryButton} h-9`}
            onClick={() => setDialog({ kind: 'new-folder' })}
            data-testid="files-new-folder"
          >
            <Icon name="folderPlus" />
            <span className="hidden sm:inline">New folder</span>
          </button>
        ) : null}
        <button
          type="button"
          className={`${primaryButton} h-9`}
          onClick={() => input.current?.click()}
          data-testid="files-upload"
        >
          <Icon name="upload" />
          <span className="hidden sm:inline">Upload</span>
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="files-input"
          onChange={(e) => {
            if (e.target.files) upload([...e.target.files])
            e.target.value = ''
          }}
        />
      </MeetingsPageHeader>
      <section
        aria-label="Files in this folder"
        className="relative min-h-0 flex-1 overflow-y-auto"
        data-testid="files-page"
        onDragOver={(e) => {
          if (kind === 'recent' || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={(e) => {
          if (kind === 'recent') return
          e.preventDefault()
          setDragging(false)
          upload([...e.dataTransfer.files])
        }}
      >
        {dragging ? (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-ember bg-ember-wash/70 text-sm font-medium text-ink">
            Drop to upload to {folder || spaceLabel}
          </div>
        ) : null}
        <div className="mx-auto w-full max-w-5xl px-4 pt-5 pb-24 md:px-8">
          <nav aria-label="Folder" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
            {kind === 'recent' ? (
              <span className="font-medium text-ink">Recent</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => goFolder('')}
                  className={
                    crumbs.length ? 'text-ink-soft hover:text-ink' : 'font-medium text-ink'
                  }
                >
                  {spaceLabel}
                </button>
                {crumbs.map((c, i) => {
                  const to = crumbs.slice(0, i + 1).join('/')
                  const last = i === crumbs.length - 1
                  return (
                    <span key={to} className="flex items-center gap-1">
                      <Icon name="chevron" className="size-3 text-ink-faint" />
                      <button
                        type="button"
                        onClick={() => goFolder(to)}
                        className={last ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'}
                      >
                        {c}
                      </button>
                    </span>
                  )
                })}
              </>
            )}
          </nav>
          {error ? (
            <p className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink" role="alert">
              {error}
            </p>
          ) : null}
          {loading && !error ? <p className="text-sm text-ink-faint">Loading…</p> : null}
          {!loading && files.length === 0 && folders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-ash-strong p-10 text-center text-sm text-ink-soft">
              {q
                ? 'No files match.'
                : kind === 'recent'
                  ? 'Files you and your team upload appear here.'
                  : 'Drag files here, or choose Upload. PDFs, images, video and audio open right in the browser.'}
            </div>
          ) : null}
          <ul className="divide-y divide-ash/70" data-testid="files-list">
            {folders.map((f) => (
              <li key={f} className="flex items-center gap-3 py-2" data-testid="files-folder">
                <button
                  type="button"
                  data-list-item
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => goFolder(f)}
                >
                  <Icon name="folder" className="size-5 shrink-0 text-ember" />
                  <span className="truncate text-sm font-medium text-ink">
                    {f.split('/').pop()}
                  </span>
                </button>
                <RowMenuButton
                  label={`More for ${f.split('/').pop()}`}
                  onOpen={(anchor) => setMenu({ anchor, folder: f })}
                />
              </li>
            ))}
            {files.map((f) => (
              <li
                key={`${f.space}/${f.id}`}
                className="flex items-center gap-3 py-2"
                data-testid="files-row"
              >
                <button
                  type="button"
                  data-testid="files-open"
                  data-list-item
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => openFile(f)}
                >
                  <Icon name={iconFor(f.mime)} className="size-5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{f.name}</span>
                    <span className="block truncate text-xs text-ink-faint">
                      {kind === 'recent' || q
                        ? `${f.space === personal ? 'My files' : 'Team files'}${f.folder ? ` / ${f.folder}` : ''} · `
                        : ''}
                      {f.createdBy.split('@')[0]} · {DATE.format(new Date(f.updatedAt))}
                      {f.shareToken ? ' · Shared' : ''}
                    </span>
                  </span>
                  <span className="hidden w-20 shrink-0 text-right text-xs text-ink-faint tabular-nums sm:block">
                    {formatBytes(f.size)}
                  </span>
                </button>
                <RowMenuButton
                  label={`More for ${f.name}`}
                  onOpen={(anchor) => setMenu({ anchor, file: f })}
                />
              </li>
            ))}
          </ul>
        </div>
      </section>
      <UploadTray />

      {menu?.file ? (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          label={`Actions for ${menu.file.name}`}
        >
          <FileMenuItems
            file={menu.file}
            personal={personal}
            close={() => setMenu(null)}
            onRename={(file) => setDialog({ kind: 'rename', file })}
            onMove={(file) => setDialog({ kind: 'move', file })}
            onDelete={(file) => setDialog({ kind: 'delete', file })}
            onShare={copyShare}
            onMoveSpace={(file, to) =>
              act(
                () => filesApi.move(file.space, file.id, to),
                `Moved to ${to === personal ? 'My files' : 'Team files'}`,
              )
            }
          />
        </Menu>
      ) : null}
      {menu?.folder !== undefined ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label="Folder actions">
          <MenuItem
            icon="pencil"
            onSelect={() => {
              setDialog({ kind: 'rename-folder', folder: menu.folder ?? '' })
              setMenu(null)
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon="trash"
            danger
            onSelect={() => {
              setDialog({ kind: 'delete-folder', folder: menu.folder ?? '' })
              setMenu(null)
            }}
          >
            Delete folder
          </MenuItem>
        </Menu>
      ) : null}

      {open ? (
        <FileDialog
          file={open}
          personal={personal}
          onClose={closeFile}
          onShare={copyShare}
          onUnshare={(file) =>
            act(
              async () => setOpen(await filesApi.share(file.space, file.id, false)),
              'Link turned off',
            )
          }
          onRename={(file) => setDialog({ kind: 'rename', file })}
          onDelete={(file) => setDialog({ kind: 'delete', file })}
        />
      ) : null}

      {dialog?.kind === 'new-folder' ? (
        <NameDialog
          title="New folder"
          initial=""
          action="Create"
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            act(async () => {
              const made = await filesApi.createFolder(space, folder ? `${folder}/${name}` : name)
              setDialog(null)
              goFolder(made.folder)
            })
          }
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <NameDialog
          title="Rename file"
          initial={dialog.file.name}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            act(async () => {
              const f = await filesApi.update(dialog.file.space, dialog.file.id, { name })
              if (open?.id === f.id) setOpen(f)
              setDialog(null)
            })
          }
        />
      ) : null}
      {dialog?.kind === 'rename-folder' ? (
        <NameDialog
          title="Rename folder"
          initial={dialog.folder.split('/').pop() ?? ''}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            act(async () => {
              const parent = dialog.folder.split('/').slice(0, -1).join('/')
              await filesApi.renameFolder(space, dialog.folder, parent ? `${parent}/${name}` : name)
              setDialog(null)
            })
          }
        />
      ) : null}
      {dialog?.kind === 'move' ? (
        <NameDialog
          title="Move to folder"
          hint="A folder path, such as Contracts/2026. Leave empty for the top."
          initial={dialog.file.folder}
          action="Move"
          allowEmpty
          onClose={() => setDialog(null)}
          onSubmit={(to) =>
            act(
              async () => {
                await filesApi.update(dialog.file.space, dialog.file.id, { folder: to })
                setDialog(null)
              },
              `Moved to ${to || 'the top folder'}`,
            )
          }
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title="Delete file?"
          body={`“${dialog.file.name}” moves to the trash. It can be brought back from its history.`}
          action="Delete"
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act(async () => {
              await filesApi.remove(dialog.file.space, dialog.file.id)
              setDialog(null)
              if (open?.id === dialog.file.id) closeFile()
            }, 'File deleted')
          }
        />
      ) : null}
      {dialog?.kind === 'delete-folder' ? (
        <ConfirmDialog
          title="Delete folder?"
          body={`“${dialog.folder.split('/').pop()}” and every file in it move to the trash.`}
          action="Delete folder"
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act(async () => {
              await filesApi.removeFolder(space, dialog.folder)
              setDialog(null)
            }, 'Folder deleted')
          }
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          data-testid="files-toast"
          className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-sm text-paper-raised shadow-float md:bottom-6"
        >
          {toast}
        </div>
      ) : null}
    </>
  )
}

function RowMenuButton({ label, onOpen }: { label: string; onOpen: (a: MenuAnchor) => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid="files-row-menu"
      className="grid size-8 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-paper-sunk hover:text-ink"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        onOpen({ x: r.right - 200, y: r.bottom + 4 })
      }}
    >
      <Icon name="more" />
    </button>
  )
}

function FileMenuItems({
  file,
  personal,
  close,
  onRename,
  onMove,
  onDelete,
  onShare,
  onMoveSpace,
}: {
  file: DriveFile
  personal: string | null
  close: () => void
  onRename: (f: DriveFile) => void
  onMove: (f: DriveFile) => void
  onDelete: (f: DriveFile) => void
  onShare: (f: DriveFile) => void
  onMoveSpace: (f: DriveFile, to: string) => void
}) {
  const run = (fn: () => void) => () => {
    close()
    fn()
  }
  const other = file.space === 'team' ? personal : 'team'
  return (
    <>
      <MenuItem icon="download" onSelect={run(() => window.open(file.downloadUrl, '_self'))}>
        Download
      </MenuItem>
      <MenuItem icon="link" testId="files-copy-link" onSelect={run(() => onShare(file))}>
        Copy share link
      </MenuItem>
      <MenuItem icon="pencil" onSelect={run(() => onRename(file))}>
        Rename
      </MenuItem>
      <MenuItem icon="move" onSelect={run(() => onMove(file))}>
        Move to folder
      </MenuItem>
      {other ? (
        <MenuItem icon="share" onSelect={run(() => onMoveSpace(file, other))}>
          {other === 'team' ? 'Move to Team files' : 'Move to My files'}
        </MenuItem>
      ) : null}
      <MenuItem icon="trash" danger testId="files-delete" onSelect={run(() => onDelete(file))}>
        Delete
      </MenuItem>
    </>
  )
}

function FileDialog({
  file,
  personal,
  onClose,
  onShare,
  onUnshare,
  onRename,
  onDelete,
}: {
  file: DriveFile
  personal: string | null
  onClose: () => void
  onShare: (f: DriveFile) => void
  onUnshare: (f: DriveFile) => void
  onRename: (f: DriveFile) => void
  onDelete: (f: DriveFile) => void
}) {
  return (
    <Dialog title={file.name} onClose={onClose} testId="file-dialog" wide>
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="flex min-h-[40vh] min-w-0 flex-1 items-center justify-center">
          <FilePreview file={file} space={file.space} />
        </div>
        <aside className="flex w-full shrink-0 flex-col gap-3 text-sm md:w-60">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-soft">
            <dt className="text-ink-faint">Where</dt>
            <dd className="truncate">
              {file.space === personal ? 'My files' : 'Team files'}
              {file.folder ? ` / ${file.folder}` : ''}
            </dd>
            <dt className="text-ink-faint">Size</dt>
            <dd>{formatBytes(file.size)}</dd>
            <dt className="text-ink-faint">Added by</dt>
            <dd className="truncate">{file.createdBy}</dd>
            <dt className="text-ink-faint">Updated</dt>
            <dd>{DATE.format(new Date(file.updatedAt))}</dd>
            <dt className="text-ink-faint">Search</dt>
            <dd>
              {file.textStatus === 'extracted'
                ? 'Text is searchable'
                : file.textStatus === 'failed'
                  ? 'Couldn’t read its text'
                  : 'Name only'}
            </dd>
          </dl>
          <a href={file.downloadUrl} className={`${primaryButton} h-9`} data-testid="file-download">
            <Icon name="download" />
            Download
          </a>
          <button
            type="button"
            className={`${secondaryButton} h-9`}
            onClick={() => onShare(file)}
            data-testid="file-share"
          >
            <Icon name="link" />
            {file.shareUrl ? 'Copy share link' : 'Get share link'}
          </button>
          {file.shareUrl ? (
            <p className="text-xs text-ink-faint">
              Anyone signed in to {product()} with the link can open this file.{' '}
              <button
                type="button"
                className="underline hover:text-ink"
                onClick={() => onUnshare(file)}
                data-testid="file-unshare"
              >
                Turn off link
              </button>
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              className={`${secondaryButton} h-9 flex-1`}
              onClick={() => onRename(file)}
            >
              Rename
            </button>
            <button
              type="button"
              className={`${secondaryButton} h-9 flex-1`}
              onClick={() => onDelete(file)}
              data-testid="file-delete"
            >
              Delete
            </button>
          </div>
        </aside>
      </div>
    </Dialog>
  )
}

function NameDialog({
  title,
  hint,
  initial,
  action,
  allowEmpty = false,
  onClose,
  onSubmit,
}: {
  title: string
  hint?: string
  initial: string
  action: string
  allowEmpty?: boolean
  onClose: () => void
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Dialog title={title} onClose={onClose} testId="files-name-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (allowEmpty || value.trim()) onSubmit(value.trim())
        }}
        className="flex flex-col gap-3"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={title}
          data-testid="files-name-input"
          className="h-10 rounded-lg border border-ash bg-paper px-3 text-sm"
        />
        {hint ? <p className="text-xs text-ink-faint">{hint}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryButton} data-testid="files-name-submit">
            {action}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function ConfirmDialog({
  title,
  body,
  action,
  onClose,
  onConfirm,
}: {
  title: string
  body: string
  action: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog title={title} onClose={onClose} testId="files-confirm">
      <p className="mb-4 text-sm text-ink-soft">{body}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          onClick={onConfirm}
          data-testid="files-confirm-ok"
        >
          {action}
        </button>
      </div>
    </Dialog>
  )
}

/** Uploads in progress, bottom right, until cleared. */
function UploadTray() {
  const uploads = useUploads()
  if (uploads.length === 0) return null
  const busy = uploads.some((u) => u.status === 'uploading')
  return (
    <div
      className="fixed right-4 bottom-20 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-ash bg-paper-raised p-3 shadow-float md:bottom-4"
      data-testid="upload-tray"
    >
      <div className="mb-2 flex items-center justify-between text-sm font-medium text-ink">
        {busy ? 'Uploading…' : 'Uploads'}
        {!busy ? (
          <button
            type="button"
            className="text-xs text-ink-soft hover:text-ink"
            onClick={clearFinishedUploads}
          >
            Clear
          </button>
        ) : null}
      </div>
      <ul className="flex max-h-60 flex-col gap-2 overflow-y-auto">
        {uploads.map((u) => (
          <li key={u.key} className="text-xs" data-testid="upload-item" data-status={u.status}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ink">{u.name}</span>
              {u.status === 'uploading' ? (
                <button type="button" className="text-ink-faint hover:text-ink" onClick={u.cancel}>
                  Cancel
                </button>
              ) : (
                <span className={u.status === 'done' ? 'text-ink-faint' : 'text-ember-strong'}>
                  {u.status === 'done' ? 'Done' : u.error}
                </span>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-paper-sunk">
              <div
                className="h-full bg-ember transition-[width]"
                style={{ width: `${u.total ? Math.round((u.sent / u.total) * 100) : 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
