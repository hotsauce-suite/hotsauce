import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
import {
  type AssistantEvent,
  type AssistantInfo,
  askAssistant,
  assistantApi,
  type ConversationSummary,
  type DisplayMessage,
  newConversationId,
  type PageContext,
  type ToolView,
} from '../../api/assistant'
import { formatSpec } from '../../keyboard/keys'
import { fileUrl } from '../../lib/paths'
import { Icon } from '../Icon'
import { takePrompt, useAssistantState } from './state'
import { hearthTarget, toolLine } from './tools'

const urlTransform = (url: string) => (url.startsWith('hearth:') ? url : defaultUrlTransform(url))

const components: Components = {
  img: () => null,
  a: ({ href = '', children }) => {
    const target = hearthTarget(href)
    if (target) return <Link to={fileUrl(target.space, target.path)}>{children}</Link>
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  },
}

const zone = (): { tz?: string } => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz ? { tz } : {}
  } catch {
    return {}
  }
}

/** Applies one streamed event to the answer being written (a new object, for React). */
function apply(answer: DisplayMessage, event: AssistantEvent): DisplayMessage {
  const tools = [...(answer.tools ?? [])]
  switch (event.type) {
    case 'text':
      return { ...answer, text: answer.text + event.delta }
    case 'tool':
      tools.push({
        id: event.id,
        name: event.name,
        kind: event.kind,
        input: event.input,
        status: 'running',
      })
      return { ...answer, tools }
    case 'confirm':
      return {
        ...answer,
        tools: tools.map((t) => (t.id === event.id ? { ...t, status: 'waiting' } : t)),
      }
    case 'tool_result':
      return {
        ...answer,
        tools: tools.map((t) =>
          t.id !== event.id || t.status === 'waiting'
            ? t
            : {
                ...t,
                status: event.isError ? 'error' : 'done',
                ...(event.undo ? { undo: event.undo } : {}),
              },
        ),
      }
    case 'error':
      return { ...answer, text: answer.text ? `${answer.text}\n\n${event.message}` : event.message }
    default:
      return answer
  }
}

/**
 * The assistant panel (docs/PLAN-assistant.md): one conversation at a time, its history, the
 * page the member has open as a removable chip, tool activity with Undo and Confirm.
 */
export default function AssistantPanel({
  open,
  page,
  onClose,
}: {
  open: boolean
  page: PageContext | null
  onClose: () => void
}) {
  const { seq } = useAssistantState()
  const [info, setInfo] = useState<AssistantInfo | null>(null)
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const [conversationId, setConversationId] = useState(newConversationId)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [history, setHistory] = useState<ConversationSummary[] | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [attach, setAttach] = useState(true)
  const abort = useRef<AbortController | null>(null)
  // Bumped when the panel switches conversation, so a stopped answer's late events are dropped.
  const generation = useRef(0)
  const [pendingTool, setPendingTool] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const pageKey = page ? `${page.space}/${page.path}` : ''

  useEffect(() => {
    assistantApi.info().then(setInfo, () => setInfo({ name: 'Ask', configured: true }))
  }, [])

  // A new page brings its chip back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the page only.
  useEffect(() => setAttach(true), [pageKey])

  useEffect(() => {
    if (open && view === 'chat') inputRef.current?.focus()
  }, [open, view])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls as the answer grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const context = attach && page ? page : undefined

  const send = useCallback(
    async (text: string, opts: { fresh?: boolean } = {}) => {
      const question = text.trim()
      if (question === '' || busy) return
      const id = opts.fresh ? newConversationId() : conversationId
      if (opts.fresh) setConversationId(id)
      const now = new Date().toISOString()
      const user: DisplayMessage = {
        role: 'user',
        text: question,
        at: now,
        ...(context ? { context } : {}),
      }
      const answer: DisplayMessage = { role: 'assistant', text: '', tools: [], at: now }
      setMessages((prev) => [...(opts.fresh ? [] : prev), user, answer])
      setInput('')
      setNotice(null)
      setView('chat')
      setBusy(true)
      const controller = new AbortController()
      abort.current = controller
      const mine = ++generation.current
      const update = (fn: (m: DisplayMessage) => DisplayMessage) =>
        setMessages((prev) => {
          const last = prev.at(-1)
          if (generation.current !== mine || !last) return prev
          return [...prev.slice(0, -1), fn(last)]
        })
      try {
        await askAssistant(
          id,
          { text: question, ...(context ? { context } : {}), ...zone() },
          (event) => update((m) => apply(m, event)),
          controller.signal,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Something went wrong; try again.'
        update((m) => ({ ...m, text: m.text ? `${m.text}\n\n${message}` : message }))
      } finally {
        if (controller.signal.aborted) update((m) => ({ ...m, text: m.text || 'Stopped.' }))
        abort.current = null
        setBusy(false)
        setHistory(null)
      }
    },
    [busy, conversationId, context],
  )

  // A question handed over by openAssistant(prompt) starts a new conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a prompt is handed over.
  useEffect(() => {
    if (!open) return
    const prompt = takePrompt()
    if (prompt) void send(prompt, { fresh: true })
  }, [open, seq])

  const newChat = () => {
    generation.current++
    abort.current?.abort()
    setConversationId(newConversationId())
    setMessages([])
    setNotice(null)
    setView('chat')
  }

  const showHistory = () => {
    setView('history')
    assistantApi.list().then(
      (r) => setHistory(r.conversations),
      () => setHistory([]),
    )
  }

  const openConversation = async (id: string) => {
    generation.current++
    abort.current?.abort()
    try {
      const conv = await assistantApi.get(id)
      setConversationId(conv.id)
      setMessages(conv.display)
      setView('chat')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not open that conversation')
    }
  }

  const removeConversation = async (id: string) => {
    await assistantApi.remove(id).catch(() => {})
    setHistory((h) => h?.filter((c) => c.id !== id) ?? null)
    if (id === conversationId) newChat()
  }

  const setTool = (toolId: string, patch: Partial<ToolView>) =>
    setMessages((prev) =>
      prev.map((m) =>
        m.tools?.some((t) => t.id === toolId)
          ? { ...m, tools: m.tools.map((t) => (t.id === toolId ? { ...t, ...patch } : t)) }
          : m,
      ),
    )

  const confirm = async (tool: ToolView) => {
    if (pendingTool) return
    setPendingTool(tool.id)
    try {
      const result = await assistantApi.confirm(conversationId, tool.id)
      setTool(tool.id, { status: result.isError ? 'error' : 'confirmed' })
      if (result.isError) setNotice(result.text)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That didn’t work')
    } finally {
      setPendingTool(null)
    }
  }

  const undo = async (tool: ToolView) => {
    if (!tool.undo || pendingTool) return
    setPendingTool(tool.id)
    try {
      await assistantApi.undo(tool.undo)
      setTool(tool.id, { status: 'undone' })
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Couldn’t undo that')
    } finally {
      setPendingTool(null)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(input)
    }
  }

  const name = info?.name ?? 'Ask'

  return (
    <aside
      aria-label={name}
      data-testid="assistant-panel"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      className="fixed inset-0 z-40 flex flex-col bg-paper-raised md:inset-y-0 md:left-auto md:right-0 md:w-[min(28rem,100vw)] md:border-l md:border-ash md:shadow-float"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-ash/70 px-3">
        <Icon name="sparkle" className="size-4 text-ink-soft" />
        <h2 className="ml-1 flex-1 truncate font-display text-base font-semibold text-ink">
          {name}
        </h2>
        <button
          type="button"
          aria-label="Past conversations"
          title="Past conversations"
          onClick={view === 'history' ? () => setView('chat') : showHistory}
          className="flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          aria-label="New conversation"
          title="New conversation"
          onClick={newChat}
          className="flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          aria-label={`Close ${name}`}
          title={`Close (${formatSpec('mod+j').join('')})`}
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="close" />
        </button>
      </header>

      {view === 'history' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="assistant-history">
          <h3 className="px-1 pb-2 text-sm font-semibold text-ink-soft">Past conversations</h3>
          {history === null ? (
            <p className="px-1 text-sm text-ink-faint">Loading…</p>
          ) : history.length === 0 ? (
            <p className="px-1 text-sm text-ink-faint">
              Nothing yet. Your conversations are kept here, visible only to you.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {history.map((c) => (
                <li key={c.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void openConversation(c.id)}
                    className="flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm text-ink hover:bg-paper-sunk"
                  >
                    {c.title}
                    <span className="ml-2 text-xs text-ink-faint">
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete “${c.title}”`}
                    onClick={() => void removeConversation(c.id)}
                    className="flex size-7 items-center justify-center rounded-lg text-ink-faint opacity-60 hover:bg-paper-sunk hover:text-ink group-hover:opacity-100"
                  >
                    <Icon name="trash" className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          data-testid="assistant-messages"
          aria-live="polite"
          aria-busy={busy}
        >
          {messages.length === 0 ? (
            <Empty name={name} configured={info?.configured !== false} />
          ) : (
            messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={`${m.role}-${m.at}`} className="mb-3 flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-paper-sunk px-3 py-2 text-sm text-ink">
                    {m.text}
                    {m.context ? (
                      <div className="mt-1 text-xs text-ink-faint">About: {m.context.title}</div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div key={`${m.role}-${m.at}`} className="mb-4" data-testid="assistant-answer">
                  {m.tools && m.tools.length > 0 ? (
                    <ul className="mb-2 space-y-1">
                      {m.tools.map((t) => (
                        <ToolRow
                          key={t.id}
                          tool={t}
                          disabled={busy || pendingTool !== null}
                          onConfirm={confirm}
                          onUndo={undo}
                        />
                      ))}
                    </ul>
                  ) : null}
                  {m.text ? (
                    <div className="assistant-answer text-sm leading-relaxed text-ink">
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={components}
                        urlTransform={urlTransform}
                      >
                        {m.text}
                      </Markdown>
                    </div>
                  ) : busy && i === messages.length - 1 ? (
                    <p className="text-sm text-ink-faint">Thinking…</p>
                  ) : null}
                </div>
              ),
            )
          )}
          <div ref={endRef} />
        </div>
      )}

      <footer className="shrink-0 border-t border-ash/70 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {notice ? (
          <p role="alert" className="mb-2 text-xs text-ink-soft">
            {notice}
          </p>
        ) : null}
        {page && attach ? (
          <div className="mb-2 flex">
            <span
              data-testid="assistant-context"
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-ash bg-paper px-2 py-0.5 text-xs text-ink-soft"
            >
              <Icon name="file" className="size-3 shrink-0" />
              <span className="truncate">{page.title}</span>
              <button
                type="button"
                aria-label="Don't include this page"
                onClick={() => setAttach(false)}
                className="ml-0.5 text-ink-faint hover:text-ink"
              >
                <Icon name="close" className="size-3" />
              </button>
            </span>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            data-testid="assistant-input"
            aria-label={`Message ${name}`}
            value={input}
            rows={2}
            placeholder={page && attach ? 'Ask about this page or anything else…' : 'Ask anything…'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-ash bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abort.current?.abort()}
              className="h-9 rounded-lg border border-ash px-3 text-sm text-ink hover:bg-paper-sunk"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              data-testid="assistant-send"
              disabled={input.trim() === ''}
              onClick={() => void send(input)}
              className="h-9 rounded-lg bg-ink px-3 text-sm font-medium text-paper disabled:opacity-40"
            >
              Ask
            </button>
          )}
        </div>
      </footer>
    </aside>
  )
}

function Empty({ name, configured }: { name: string; configured: boolean }) {
  if (!configured) {
    return (
      <div className="pt-8 text-center text-sm text-ink-soft" data-testid="assistant-unconfigured">
        <p className="font-medium text-ink">{name} needs an Anthropic API key.</p>
        <p className="mt-1">An admin can add one in Settings, under Organization.</p>
      </div>
    )
  }
  return (
    <div className="pt-6 text-sm text-ink-soft">
      <p className="font-medium text-ink">Ask about anything in your workspace.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>What did we decide about pricing last week?</li>
        <li>Summarize this page and turn the next steps into tasks.</li>
        <li>Draft a doc from my last meeting’s notes.</li>
      </ul>
      <p className="mt-3 text-xs text-ink-faint">
        It sees what you can see. Edits can be undone; deleting or moving files waits for you to
        confirm. {formatSpec('mod+j').join('')} opens and closes this panel.
      </p>
    </div>
  )
}

function ToolRow({
  tool,
  disabled,
  onConfirm,
  onUndo,
}: {
  tool: ToolView
  disabled: boolean
  onConfirm: (t: ToolView) => void
  onUndo: (t: ToolView) => void
}) {
  const line = toolLine(tool)
  const mark =
    tool.status === 'running'
      ? '…'
      : tool.status === 'error'
        ? 'didn’t work'
        : tool.status === 'undone'
          ? 'undone'
          : tool.status === 'confirmed'
            ? 'done'
            : null
  return (
    <li data-testid="assistant-tool" data-status={tool.status} className="text-xs text-ink-soft">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon
          name={tool.status === 'error' ? 'close' : tool.kind === 'read' ? 'search' : 'pencil'}
          className="size-3 shrink-0 text-ink-faint"
        />
        <span className={tool.status === 'undone' ? 'line-through' : ''}>{line}</span>
        {mark ? <span className="text-ink-faint">{mark}</span> : null}
        {tool.status === 'done' && tool.undo ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onUndo(tool)}
            className="rounded border border-ash px-1.5 py-0.5 text-ink hover:bg-paper-sunk disabled:opacity-50"
          >
            Undo
          </button>
        ) : null}
      </div>
      {tool.status === 'waiting' ? (
        <div className="mt-1.5 flex items-center gap-2 pl-5">
          <button
            type="button"
            data-testid="assistant-confirm"
            disabled={disabled}
            onClick={() => onConfirm(tool)}
            className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper disabled:opacity-50"
          >
            Confirm
          </button>
          <span className="text-ink-faint">Nothing happens until you confirm.</span>
        </div>
      ) : null}
    </li>
  )
}
