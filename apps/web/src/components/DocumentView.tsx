import type { Extension, Text } from '@codemirror/state'
import {
  extractTitle,
  newDoc,
  parseFrontmatter,
  relativeLink,
  resolveRelative,
} from '@hearth/format'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createRoot } from 'react-dom/client'
import { Link, useBlocker, useLocation, useNavigate } from 'react-router'
import { api } from '../api/client'
import { docsApp } from '../apps/docs/manifest'
import type { AppManifest } from '../apps/registry'
import { product } from '../brand/product'
import type { LinkTarget } from '../editor/wikiLink'
import { type DocumentHandle, GONE_WHILE_EDITING, useDocument } from '../hooks/useDocument'
import { ImageUrls } from '../lib/assets'
import { firstHeading, isUntitledPath, NEW_DOC_TITLE, renameTarget } from '../lib/format'
import { registerOpenDoc } from '../lib/openDoc'
import {
  boardUrl,
  dirname,
  displayName,
  isBoardFile,
  isExternalHref,
  isMarkdown,
  openExternal,
} from '../lib/paths'
import { useSession } from '../state/session'
import { freeDocPath } from '../state/treeStore'
import { useShell } from './AppShell'
import { ConflictBanner, DraftBanner } from './Banners'
import { ConflictResolver } from './ConflictResolver'
import { FilePicker } from './FilePicker'
import { type EditorBridge, type EditorSelectionJSON, MarkdownEditor } from './MarkdownEditor'
import { PropertiesPanel } from './PropertiesPanel'
import { TaskQueryList } from './TaskQueryList'
import { type PanelToggle, type SidePanel, TopBar } from './TopBar'

const ReadingView = lazy(() => import('./ReadingView'))
const HistoryPanel = lazy(() => import('./HistoryPanel'))

/** How long typing must pause before the heading is re-read for the rename offer. */
const HEADING_PAUSE_MS = 400
/**
 * How long typing must pause, off the heading line, before an untitled doc takes its name. Kept
 * shorter than the idle commit, so a new doc is created under its name, never as untitled.md.
 */
const autoNamePauseMs = (idleCommitMs: number) => Math.min(1200, idleCommitMs / 2)

/** What a doc's URL carries in history state. */
interface DocLocationState {
  /** Opened from "New doc". */
  newDoc?: boolean
  /** The cursor to restore: the doc was just auto-named, which remounts the editor. */
  selection?: EditorSelectionJSON
}

/** A side panel a page adds next to History and Properties. */
export interface ExtraPanel extends PanelToggle {
  render: (close: () => void, doc: DocumentHandle) => ReactNode
}

export interface DocumentViewProps {
  space: string
  path: string
  /** The app the document is open in: its name titles the tab, its URLs open links. */
  app?: AppManifest
  /** Shown above the text, in its column (Meetings: date, attendees, Enhance). */
  header?: (doc: DocumentHandle) => ReactNode
  /** Shown under the text once it has loaded (Meetings: ask about this meeting). */
  footer?: (doc: DocumentHandle) => ReactNode
  panels?: ExtraPanel[]
  initialPanel?: SidePanel
  /** More CodeMirror extensions for this document's editor. */
  extensions?: Extension[]
  /** Holds the editor read-only (Meetings: while Enhance rewrites the note). */
  readOnly?: boolean
}

/** One open document: top bar, banners, editor or reading view, side panels, resolver. */
export function DocumentView({
  space,
  path,
  app = docsApp,
  header,
  footer,
  panels,
  initialPanel = null,
  extensions,
  readOnly = false,
}: DocumentViewProps) {
  const session = useSession()
  const shell = useShell()
  const location = useLocation()
  const navigate = useNavigate()
  const locationState = (location.state as DocLocationState | null) ?? {}
  const isNew = locationState.newDoc === true
  const [carriedSelection] = useState(() => locationState.selection)
  // Frontmatter with an id, title and created time, made once per opened doc.
  const [newDocText] = useState(() => newDoc(NEW_DOC_TITLE).text)
  const doc = useDocument(space, path, {
    idleCommitMs: session.idleCommitMs,
    isNew,
    newDocText,
  })
  const { state } = doc
  const [reading, setReading] = useState(false)
  const [panel, setPanel] = useState<SidePanel>(initialPanel)
  const editor = useRef<EditorBridge | null>(null)
  const [picking, setPicking] = useState(false)

  const { refreshRecents } = session
  const opened = state.status === 'ready' && !state.isNew
  useEffect(() => {
    if (opened) api.addRecent(space, path).then(refreshRecents, () => {})
  }, [opened, space, path, refreshRecents])

  // Leaving the doc commits pending edits first; a conflict keeps the user here to resolve it.
  // An untitled doc that has a heading takes its name on the way out too.
  const autoNameOnLeave = useRef<(() => string | null) | null>(null)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname &&
      (doc.isDirty() || (autoNameOnLeave.current?.() ?? null) !== null),
  )
  const { commit } = doc
  useEffect(() => registerOpenDoc(space, path, () => commit()), [space, path, commit])
  // A save refused because the doc is gone is the one save error that needs the member to act.
  const { saveError } = state
  useEffect(() => {
    if (saveError === GONE_WHILE_EDITING) session.notify(GONE_WHILE_EDITING)
  }, [saveError, session.notify])
  // biome-ignore lint/correctness/useExhaustiveDependencies: takeName is recreated each render.
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    void (async () => {
      const stem = autoNameOnLeave.current?.() ?? null
      if (stem) {
        if ((await takeName(stem)) === 'conflict') return blocker.reset()
      } else if ((await commit()) === 'conflict') return blocker.reset()
      blocker.proceed()
    })()
  }, [blocker, commit])

  const onReady = useCallback(
    (bridge: EditorBridge | null) => {
      editor.current = bridge
      doc.bindEditor(bridge)
    },
    [doc.bindEditor],
  )

  // This doc's image blobs, freed when the doc closes.
  const images = useMemo(() => new ImageUrls(space, path), [space, path])
  useEffect(() => () => images.release(), [images])

  const { notify, tree } = session
  const personalSpace = session.spaces.find((s) => s.kind === 'personal')?.name ?? null
  const services = useMemo(
    () => ({
      // A `tasks` block's live list is its own React root inside the editor's widget.
      mountTaskList: (source: string, host: HTMLElement) => {
        const root = createRoot(host)
        root.render(
          <TaskQueryList source={source} personalSpace={personalSpace} onOpen={navigate} />,
        )
        // Not synchronously: CodeMirror may drop the widget while React is rendering.
        return () => queueMicrotask(() => root.unmount())
      },
      resolveImage: (src: string) => images.resolve(src),
      openLink: (href: string) => {
        // A Hearth Files attachment (§18.4) opens in Files.
        if (/^\/files\//.test(href)) {
          navigate(href)
          return
        }
        if (isExternalHref(href)) {
          if (!openExternal(href)) notify(`This link can’t be opened from ${product()}: ${href}`)
          return
        }
        const target = resolveRelative(path, href)
        if (isBoardFile(target)) navigate(boardUrl(space, target))
        else if (isMarkdown(target)) navigate(app.urlFor(space, target))
        else notify(`Only links to docs open here: ${href}`)
      },
      upload: async (file: File) => {
        const { path: assetPath } = await api.uploadAsset(space, file)
        return relativeLink(path, assetPath)
      },
      findTargets: async (query: string): Promise<LinkTarget[]> => {
        const known = tree
          .knownDocs()
          .filter((d) => d.space === space)
          .map((d) => ({ path: d.path, title: displayName(d.path) }))
        const q = query.trim().toLowerCase()
        if (!q) return known.slice(0, 20)
        const hits = await api.search(q, [space]).catch(() => [])
        const targets = new Map<string, LinkTarget>()
        for (const hit of hits) targets.set(hit.path, { path: hit.path, title: hit.title })
        for (const doc of known) {
          if (!targets.has(doc.path) && doc.title.toLowerCase().includes(q))
            targets.set(doc.path, doc)
        }
        return [...targets.values()].slice(0, 20)
      },
      onError: notify,
    }),
    [space, path, app, images, navigate, notify, tree, personalSpace],
  )

  const togglePanel = (next: string) => setPanel((current) => (current === next ? null : next))
  const extraPanel = panels?.find((p) => p.id === panel)

  // `#L12` (a chat citation) puts the cursor on line 12 once the text is in the editor.
  const lineMatch = /^#L(\d+)$/.exec(location.hash)
  const revealLine = lineMatch ? Number(lineMatch[1]) : null
  const ready = state.status === 'ready'
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when a load mounts a new editor.
  useEffect(() => {
    if (ready && revealLine !== null) editor.current?.revealLine(revealLine)
  }, [ready, revealLine, state.loadKey])

  const saveVersion = async (label: string) => {
    const outcome = await doc.commit(label ? { label } : {})
    if (outcome === 'committed') notify(label ? `Saved version “${label}”.` : 'Version saved.')
    if (outcome === 'noop') notify('No changes since the last commit.')
    return outcome
  }

  const conflict = state.conflict
  const showConflictBanner = conflict !== null || state.serverConflicts.length > 0
  const title =
    state.status === 'ready'
      ? (extractTitle(doc.getText()) ?? displayName(path))
      : displayName(path)

  useEffect(() => {
    document.title = `${title} · ${app.name}`
    return () => {
      document.title = app.name
    }
  }, [title, app.name])

  // Docs PRD §5: a retitled doc offers to take its new title's file name. The heading is read
  // when typing pauses, so the offer needs no commit and costs nothing per keystroke.
  const [heading, setHeading] = useState<string | null>(null)
  const headingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { edit } = doc
  const { idleCommitMs } = session
  const onChange = useCallback(
    (text: Text) => {
      edit(text)
      if (headingTimer.current) clearTimeout(headingTimer.current)
      headingTimer.current = setTimeout(
        () => setHeading(firstHeading(text.toString())),
        HEADING_PAUSE_MS,
      )
      if (autoNameTimer.current) clearTimeout(autoNameTimer.current)
      autoNameTimer.current = setTimeout(
        () => void autoNameRef.current(),
        autoNamePauseMs(idleCommitMs),
      )
    },
    [edit, idleCommitMs],
  )
  const autoNameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const autoNameRef = useRef<() => Promise<void>>(async () => {})
  useEffect(
    () => () => {
      if (headingTimer.current) clearTimeout(headingTimer.current)
      if (autoNameTimer.current) clearTimeout(autoNameTimer.current)
    },
    [],
  )
  const openedHeading = useMemo(
    () => (state.status === 'ready' ? firstHeading(state.initialText) : null),
    [state.status, state.initialText],
  )
  // A meeting note's transcript wouldn't move with it, so it isn't offered (ARCHITECTURE §7.5).
  const isMeeting = useMemo(
    () => state.status === 'ready' && parseFrontmatter(state.initialText).data.type === 'meeting',
    [state.status, state.initialText],
  )
  const [keptName, setKeptName] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const renameTo = isMeeting ? null : renameTarget(path, openedHeading, heading)
  // A doc still called untitled takes its heading's name on its own (no offer to answer).
  const untitled = isUntitledPath(path) && !isMeeting

  /** The file name an untitled doc should take now, or null. Read fresh from the editor. */
  const autoNameStem = (): string | null => {
    if (!untitled || state.status !== 'ready' || conflict || renaming) return null
    const target = renameTarget(path, openedHeading, firstHeading(doc.getText()))
    if (!target || firstHeading(doc.getText()) === NEW_DOC_TITLE) return null
    const name = target.slice(target.lastIndexOf('/') + 1, -'.md'.length)
    return name === '' || isUntitledPath(target) ? null : name
  }
  autoNameOnLeave.current = autoNameStem

  /**
   * Saves an untitled doc under a free `stem.md` beside it: a doc not saved yet is created there
   * (so `untitled.md` never enters Git), a saved one is committed and moved (links into it are
   * rewritten server-side). The new path, or what stopped it. One at a time: the pause timer and
   * leaving the doc can both ask, and the second waits for the first.
   */
  const naming = useRef<Promise<string | 'conflict' | 'error'> | null>(null)
  const takeName = (stem: string): Promise<string | 'conflict' | 'error'> => {
    naming.current ??= nameFile(stem).finally(() => {
      naming.current = null
    })
    return naming.current
  }
  const nameFile = async (stem: string): Promise<string | 'conflict' | 'error'> => {
    const dir = dirname(path)
    // A name can be taken between picking it and saving; the second try reads the folder again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const to = await freeDocPath(tree, space, dir, stem, { own: path, fresh: true })
      const created = await doc.createAt(to)
      if (created === 'taken') continue
      if (created === 'committed') {
        tree.refreshPaths(space, [to])
        return to
      }
      if (created !== 'not-new') return created === 'conflict' ? 'conflict' : 'error'
      const outcome = await doc.commit()
      if (outcome === 'conflict' || outcome === 'error') return outcome
      return moveFile(to)
    }
    return 'error'
  }

  /** Moves the committed file; the new path, or 'error' after saying why. */
  const moveFile = async (to: string): Promise<string | 'error'> => {
    try {
      await api.move(space, path, to)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Couldn’t rename the file.')
      return 'error'
    }
    tree.refreshPaths(space, [path, to])
    return to
  }

  /** The "Rename file" offer: commits, moves the file, and follows it. */
  const renameFile = async (to: string) => {
    setRenaming(true)
    const outcome = await doc.commit()
    const moved = outcome === 'conflict' || outcome === 'error' ? outcome : await moveFile(to)
    if (moved === 'conflict' || moved === 'error') return setRenaming(false)
    navigate(app.urlFor(space, moved), { replace: true })
  }

  // Once typing pauses with the cursor off the heading, an untitled doc takes the heading's
  // name, and the editor comes back with the cursor where it was.
  autoNameRef.current = async () => {
    if (editor.current?.cursorOnHeading() ?? true) return
    const stem = autoNameStem()
    if (!stem) return
    editor.current?.freeze()
    setRenaming(true)
    const to = await takeName(stem)
    // Gone already (the member left while it saved): don't pull them back.
    if (!mounted.current) return
    if (to === 'conflict' || to === 'error') return setRenaming(false)
    // Read after the save, which may have adopted the server's text in place.
    const selection = editor.current?.selection()
    navigate(app.urlFor(space, to), {
      replace: true,
      ...(selection ? { state: { selection } satisfies DocLocationState } : {}),
    })
  }

  return (
    <>
      <TopBar
        space={space}
        path={path}
        compact={shell.compact}
        save={{
          state: state.saveState,
          isNew: state.isNew,
          lastCommittedAt: state.lastCommittedAt,
          error: state.saveError,
        }}
        reading={reading}
        onToggleReading={() => setReading((r) => !r)}
        panel={panel}
        onTogglePanel={togglePanel}
        {...(panels ? { extraPanels: panels } : {})}
        onSaveVersion={saveVersion}
        beforeShare={() => doc.commit()}
        getText={() => doc.getText()}
        onOpenDrawer={shell.openDrawer}
        {...(state.status === 'ready' && !reading ? { onAttachFile: () => setPicking(true) } : {})}
        rename={
          !untitled && renameTo && renameTo !== keptName && !conflict && !renaming
            ? {
                to: renameTo,
                onRename: () => void renameFile(renameTo),
                onKeep: () => setKeptName(renameTo),
              }
            : null
        }
      />

      {picking ? (
        <FilePicker
          targetSpace={space}
          onClose={() => setPicking(false)}
          onPick={(a) => {
            setPicking(false)
            editor.current?.insertBlock?.(a.markdown)
          }}
        />
      ) : null}
      {showConflictBanner ? (
        <ConflictBanner
          onResolve={() => {
            const ref = state.serverConflicts[0]?.ref
            if (ref) void doc.openConflict(ref)
          }}
        />
      ) : null}
      {state.draft ? (
        <DraftBanner
          savedAt={state.draft.savedAt}
          onRestore={doc.restoreDraft}
          onDiscard={doc.discardDraft}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {header?.(doc)}
          <div className="relative min-h-0 flex-1">
            {state.status === 'loading' ? <EditorSkeleton /> : null}
            {state.status === 'error' ? (
              <div className="mx-auto max-w-[var(--measure)] px-6 py-16">
                <h1 className="font-display text-2xl font-semibold">
                  {state.error?.status === 404 ? 'This doc isn’t here' : 'This doc didn’t load'}
                </h1>
                <p className="mt-2 text-ink-soft">
                  {state.error?.status === 404
                    ? 'It may have been moved, renamed, or deleted. Its history is still in Git.'
                    : state.error?.message}
                </p>
                <Link to={app.route} className="mt-4 inline-block text-ember-strong underline">
                  Back to {app.label.toLowerCase()}
                </Link>
              </div>
            ) : null}
            {state.status === 'ready' ? (
              <div className={reading ? 'hidden' : 'h-full'}>
                <MarkdownEditor
                  key={state.loadKey}
                  initialText={state.initialText}
                  path={path}
                  readOnly={conflict !== null || renaming || readOnly}
                  autoFocus={isNew}
                  {...(carriedSelection ? { initialSelection: carriedSelection } : {})}
                  {...(extensions ? { extensions } : {})}
                  onChange={onChange}
                  onReady={onReady}
                  {...services}
                />
              </div>
            ) : null}
            {state.status === 'ready' && reading ? (
              <div className="h-full overflow-y-auto">
                <Suspense fallback={null}>
                  <ReadingView
                    markdown={doc.getText()}
                    personalSpace={personalSpace}
                    space={space}
                    path={path}
                    resolveImage={services.resolveImage}
                  />
                </Suspense>
              </div>
            ) : null}
          </div>
          {state.status === 'ready' ? footer?.(doc) : null}
        </div>

        {panel === 'history' ? (
          <Suspense fallback={null}>
            <HistoryPanel
              space={space}
              path={path}
              refreshKey={state.lastCommittedAt}
              resolveImage={services.resolveImage}
              onRestore={doc.restoreVersion}
              onClose={() => setPanel(null)}
            />
          </Suspense>
        ) : null}
        {panel === 'properties' ? (
          <PropertiesPanel
            text={doc.getText()}
            onEditSource={() => {
              setReading(false)
              editor.current?.revealFrontmatter()
            }}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {extraPanel?.render(() => setPanel(null), doc)}
      </div>

      {conflict ? (
        <ConflictResolver
          key={conflict.ref ?? 'local'}
          path={path}
          ours={conflict.ours}
          theirs={conflict.theirs}
          onResolve={doc.resolveConflict}
          {...(conflict.ref ? { onCancel: doc.dismissConflict } : {})}
        />
      ) : null}
    </>
  )
}

function EditorSkeleton() {
  return (
    <div aria-hidden="true" className="mx-auto max-w-[var(--measure)] px-6 pt-10">
      <div className="h-9 w-2/3 rounded-md bg-ash/50" />
      <div className="mt-6 space-y-3">
        {[92, 85, 96, 60].map((w) => (
          <div key={w} className="h-3.5 rounded-full bg-ash/40" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}
