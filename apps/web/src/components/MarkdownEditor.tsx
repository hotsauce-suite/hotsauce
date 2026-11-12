import { Compartment, EditorState, type Extension, type Text, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { bodyStart, setFrontmatterFolded } from '../editor/livePreview'
import { type EditorServices, editorExtensions, remoteChange } from '../editor/setup'

/** Imperative handle: useDocument reads and adopts text; the page can unfold frontmatter. */
export interface EditorBridge {
  getText: () => string
  setText: (text: string) => void
  revealFrontmatter: () => void
  /** Puts the cursor at the start of a 1-based line and scrolls it to the middle. */
  revealLine: (line: number) => void
  /** Where the cursor is, to carry across a remount (auto-naming moves the file). */
  selection: () => EditorSelectionJSON
  /** True while the cursor is on a `# ` heading line, i.e. the title may still be mid-typing. */
  cursorOnHeading: () => boolean
  /** Stops typing at once, before React re-renders with `readOnly`. */
  freeze: () => void
  /** Puts `text` on its own line after the cursor's line (an attached file's link). */
  insertBlock?: (text: string) => void
}

export interface EditorSelectionJSON {
  anchor: number
  head: number
}

/** Replaces the document with the smallest single change, so the cursor maps through it. */
export function adoptText(view: EditorView, next: string): void {
  const current = view.state.doc.toString()
  if (current === next) return
  const max = Math.min(current.length, next.length)
  let start = 0
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++
  let endCurrent = current.length
  let endNext = next.length
  while (
    endCurrent > start &&
    endNext > start &&
    current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)
  ) {
    endCurrent--
    endNext--
  }
  view.dispatch({
    changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) },
    annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
  })
}

export interface MarkdownEditorProps extends Omit<EditorServices, 'onChange' | 'currentPath'> {
  initialText: string
  path: string
  readOnly: boolean
  autoFocus?: boolean
  /** Mount with this selection (clamped to the text) instead of the default, and focus. */
  initialSelection?: EditorSelectionJSON
  /** Tighter margins and smaller headings, for a notepad beside other things (Meetings). */
  compact?: boolean
  /** More CodeMirror extensions, read once at mount. */
  extensions?: Extension[]
  onChange: (text: Text) => void
  onReady: (bridge: EditorBridge | null) => void
}

/**
 * CodeMirror owns the text while mounted. Remount (via `key`) to load a different document;
 * use the bridge to adopt server text in place.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const editable = useMemo(() => new Compartment(), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: mounts once; later props are read through `latest`.
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const services: EditorServices = {
      onChange: (text) => latest.current.onChange(text),
      upload: (file) => latest.current.upload(file),
      findTargets: (query) => latest.current.findTargets(query),
      currentPath: () => latest.current.path,
      onError: (message) => latest.current.onError(message),
      resolveImage: (src) =>
        latest.current.resolveImage?.(src) ?? Promise.reject(new Error('no image resolver')),
      openLink: (href) => latest.current.openLink?.(href),
      ...(props.mountTaskList
        ? {
            mountTaskList: (source: string, host: HTMLElement) =>
              latest.current.mountTaskList?.(source, host) ?? (() => {}),
          }
        : {}),
    }
    const created = EditorState.create({
      doc: props.initialText,
      extensions: [
        editorExtensions(services),
        props.extensions ?? [],
        editable.of(EditorView.editable.of(!props.readOnly)),
      ],
    })
    // Start below the folded frontmatter, so typing never lands above it. A new doc starts
    // with its "Untitled" heading selected, ready to be typed over.
    const start = bodyStart(created)
    let firstLine = created.doc.lineAt(start)
    while (firstLine.text.trim() === '' && firstLine.number < created.doc.lines) {
      firstLine = created.doc.line(firstLine.number + 1)
    }
    const clamp = (n: number) => Math.min(Math.max(0, n), created.doc.length)
    const selection = props.initialSelection
      ? { anchor: clamp(props.initialSelection.anchor), head: clamp(props.initialSelection.head) }
      : props.autoFocus && firstLine.text.startsWith('# ')
        ? { anchor: firstLine.from + 2, head: firstLine.to }
        : { anchor: start }
    const state = created.update({
      selection,
      ...(props.initialSelection ? { scrollIntoView: true } : {}),
    }).state
    const editor = new EditorView({ state, parent })
    view.current = editor
    if (props.autoFocus || props.initialSelection) editor.focus()
    latest.current.onReady({
      getText: () => editor.state.doc.toString(),
      setText: (text) => adoptText(editor, text),
      revealFrontmatter: () => {
        editor.dispatch({ effects: setFrontmatterFolded.of(false), selection: { anchor: 0 } })
        editor.focus()
      },
      insertBlock: (text) => {
        const line = editor.state.doc.lineAt(editor.state.selection.main.head)
        const insert = `${line.text.trim() === '' ? '' : '\n'}${text}\n`
        const at = line.text.trim() === '' ? line.from : line.to
        editor.dispatch({
          changes: { from: at, insert },
          selection: { anchor: at + insert.length },
          scrollIntoView: true,
        })
        editor.focus()
      },
      revealLine: (line) => {
        const doc = editor.state.doc
        const target = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines))
        editor.dispatch({
          selection: { anchor: target.from },
          effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
        })
      },
      selection: () => {
        const { anchor, head } = editor.state.selection.main
        return { anchor, head }
      },
      freeze: () =>
        editor.dispatch({ effects: editable.reconfigure(EditorView.editable.of(false)) }),
      cursorOnHeading: () =>
        /^#\s/.test(editor.state.doc.lineAt(editor.state.selection.main.head).text),
    })
    return () => {
      latest.current.onReady(null)
      editor.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.reconfigure(EditorView.editable.of(!props.readOnly)),
    })
  }, [props.readOnly, editable])

  return (
    <div
      ref={host}
      data-testid="editor"
      className={props.compact ? 'hearth-editor hearth-editor-compact' : 'hearth-editor'}
    />
  )
}
