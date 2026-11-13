import { Command } from 'cmdk'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import type { SearchResult } from '../api/types'
import { APPS, railLinks } from '../apps/registry'
import { GO_KEYS, type GoTarget, SHORTCUTS } from '../keyboard/catalog'
import {
  type Command as Action,
  type CommandGroup,
  GROUP_TITLES,
  matchCommands,
  useCommandList,
} from '../keyboard/commands'
import { Keys } from '../keyboard/Keys'
import { displayName, fileUrl, isTaskFile, meetingFileKind } from '../lib/paths'
import { useSession } from '../state/session'
import { appHref } from './AppRail'
import { Icon, type IconName } from './Icon'

const SEARCH_DEBOUNCE_MS = 120
const MAX_TITLES = 8

interface Hit {
  space: string
  path: string
  title: string
  snippet?: string
}

const KIND_LABEL = {
  doc: 'Doc',
  meeting: 'Meeting',
  transcript: 'Transcript',
  task: 'Task',
} as const

const terms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)

function titleMatches(title: string, query: string): boolean {
  const lower = title.toLowerCase()
  return terms(query).every((term) => lower.includes(term))
}

interface Jump {
  id: string
  name: string
  icon: IconName
  /** An in-app path, or an external URL that opens in a new tab. */
  to: string
  external: boolean
}

/** "Go to <app>" for every app and rail link whose name matches the query (all of them for none). */
function jumpsFor(query: string): Jump[] {
  const all: Jump[] = [
    ...APPS.map((app) => ({
      id: app.id,
      name: app.name,
      icon: app.icon,
      to: appHref(app),
      external: false,
    })),
    ...railLinks().map((link) => ({
      id: link.id,
      name: link.name,
      icon: link.icon,
      to: link.href,
      external: true,
    })),
  ]
  const words = terms(query)
  return all.filter((jump) => {
    // Each typed word must start a word of "go to <name>", so "e" or "meet" in a doc title
    // search doesn't drag every app in.
    const vocabulary = `go to open ${jump.name}`.toLowerCase().split(/\s+/)
    return words.every((word) => vocabulary.some((known) => known.startsWith(word)))
  })
}

/** Renders alternating plain/hit parts (hits at odd indexes) as text; never as HTML. */
function marked(parts: string[]): ReactNode {
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: split parts are positional.
      <mark key={i} className="rounded-sm bg-transparent font-semibold text-ember-strong">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/** Marks the query terms in a title. */
function highlight(text: string, query: string): ReactNode {
  const words = terms(query).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (words.length === 0) return text
  return marked(text.split(new RegExp(`(${words.join('|')})`, 'gi')))
}

const HIT_START = '\u0002'
const HIT_END = '\u0003'

/** The server marks snippet hits with \u0002 … \u0003; fall back to marking the query. */
function snippet(text: string, query: string): ReactNode {
  if (!text.includes(HIT_START)) return highlight(text, query)
  return marked(text.replaceAll(HIT_END, HIT_START).split(HIT_START))
}

/**
 * Cmd-K: titles first (instant, from docs already seen, then confirmed by the server),
 * then full-text matches with snippets. Enter opens the selected doc.
 */
export default function CommandK({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const session = useSession()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ query: string; hits: SearchResult[] } | null>(null)
  const [error, setError] = useState(false)
  const spaces = useMemo(() => session.spaces.map((s) => s.name), [session.spaces])

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let live = true
    const timer = setTimeout(() => {
      api.search(q, spaces).then(
        (hits) => {
          if (!live) return
          setError(false)
          setResults({ query: q, hits })
        },
        () => live && setError(true),
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, spaces])

  const { titles, fullText } = useMemo(() => {
    const q = query.trim()
    if (!q) return { titles: [] as Hit[], fullText: [] as Hit[] }
    const seen = new Set<string>()
    const titleHits: Hit[] = []
    const add = (hit: Hit, list: Hit[]) => {
      const key = `${hit.space}:${hit.path}`
      if (seen.has(key)) return
      seen.add(key)
      list.push(hit)
    }
    const server = results?.query === q ? results.hits : []
    for (const hit of server) if (titleMatches(hit.title, q)) add(hit, titleHits)
    const local = [
      ...session.recents.map((r) => ({
        space: r.space,
        path: r.path,
        title: r.title ?? displayName(r.path),
      })),
      ...session.stars.map((s) => ({
        space: s.space,
        path: s.path,
        title: s.title ?? displayName(s.path),
      })),
      ...session.tree.knownDocs().map((d) => ({ ...d, title: displayName(d.path) })),
    ]
    for (const hit of local) if (titleMatches(hit.title, q)) add(hit, titleHits)
    const bodyHits: Hit[] = []
    for (const hit of server) add(hit, bodyHits)
    return { titles: titleHits.slice(0, MAX_TITLES), fullText: bodyHits }
  }, [query, results, session.recents, session.stars, session.tree])

  const openDoc = (hit: { space: string; path: string }) => {
    onOpenChange(false)
    setQuery('')
    navigate(fileUrl(hit.space, hit.path))
  }

  const jumps = jumpsFor(query)
  const [confirming, setConfirming] = useState<Action | null>(null)
  const actions = matchCommands(useCommandList(), query)
  const close = () => {
    onOpenChange(false)
    setQuery('')
    setConfirming(null)
  }
  const runAction = (action: Action) => {
    if (action.confirm && confirming?.id !== action.id) {
      setConfirming(action)
      return
    }
    const typed = query.trim()
    close()
    action.run(typed)
  }
  const actionGroup = (group: CommandGroup) => {
    const items = actions.filter((a) => a.group === group)
    if (!items.length) return null
    return (
      <Command.Group key={group} heading={GROUP_TITLES[group]}>
        {items.map((action) => (
          <ActionItem key={action.id} action={action} onSelect={() => runAction(action)} />
        ))}
      </Command.Group>
    )
  }
  const jump = (target: Jump) => {
    close()
    if (target.external) window.open(target.to, '_blank', 'noopener,noreferrer')
    else navigate(target.to)
  }
  const jumpGroup = jumps.length ? (
    <Command.Group heading="Apps">
      {jumps.map((target) => (
        <Command.Item
          key={target.id}
          value={`app:${target.id}`}
          onSelect={() => jump(target)}
          data-testid={`cmdk-app-${target.id}`}
          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink"
        >
          <Icon name={target.icon} className="size-4 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate">Go to {target.name}</span>
          {target.external ? (
            <span className="shrink-0 text-xs text-ink-faint">Opens in a new tab</span>
          ) : target.id in GO_KEYS ? (
            <Keys spec={`g ${GO_KEYS[target.id as GoTarget]}`} className="shrink-0" />
          ) : null}
        </Command.Item>
      ))}
    </Command.Group>
  ) : null

  const searching = query.trim() !== '' && results?.query !== query.trim() && !error
  const recent = session.recents.slice(0, 6)

  // Keep the top row selected as results arrive: the app jumps render at once and the doc
  // results a moment later, above them, and Enter should open the best doc, not an app.
  const topHit = query.trim() === '' ? recent[0] : (titles[0] ?? fullText[0])
  const firstAction = query.trim() === '' ? undefined : actions[0]
  const top = topHit
    ? `${topHit.space}:${topHit.path}`
    : jumps[0]
      ? `app:${jumps[0].id}`
      : firstAction
        ? `command:${firstAction.id}`
        : ''
  const [selected, setSelected] = useState(top)
  useEffect(() => setSelected(top), [top])

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      value={selected}
      onValueChange={setSelected}
      label="Search and commands"
      shouldFilter={false}
      loop
      data-testid="cmdk"
      contentClassName="outline-none"
      className="overflow-hidden rounded-xl border border-ash bg-paper-raised shadow-float"
    >
      <div className="flex items-center gap-2.5 border-b border-ash px-4">
        <Icon name="search" className="size-4 text-ink-faint" />
        <Command.Input
          data-testid="cmdk-input"
          value={query}
          onValueChange={setQuery}
          placeholder="Search, or type a command"
          className="h-12 w-full bg-transparent text-[0.95rem] text-ink outline-none placeholder:text-ink-faint focus-visible:shadow-none"
        />
      </div>
      <Command.List className="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5">
        {query.trim() === '' ? (
          recent.length ? (
            <Command.Group heading="Recent">
              {recent.map((r) => (
                <ResultItem
                  key={`${r.space}:${r.path}`}
                  hit={{ space: r.space, path: r.path, title: r.title ?? displayName(r.path) }}
                  spaceLabel={session.spaceLabel(r.space)}
                  query=""
                  onSelect={openDoc}
                />
              ))}
            </Command.Group>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-ink-faint">
              Type to search every doc and meeting you can see.
            </p>
          )
        ) : null}
        {titles.length ? (
          <Command.Group heading="Titles">
            {titles.map((hit) => (
              <ResultItem
                key={`t:${hit.space}:${hit.path}`}
                hit={hit}
                spaceLabel={session.spaceLabel(hit.space)}
                query={query}
                onSelect={openDoc}
              />
            ))}
          </Command.Group>
        ) : null}
        {fullText.length ? (
          <Command.Group heading="In the text">
            {fullText.map((hit) => (
              <ResultItem
                key={`b:${hit.space}:${hit.path}`}
                hit={hit}
                spaceLabel={session.spaceLabel(hit.space)}
                query={query}
                onSelect={openDoc}
              />
            ))}
          </Command.Group>
        ) : null}
        {confirming ? (
          <Command.Group heading={confirming.confirm}>
            <Command.Item
              value={`confirm:${confirming.id}`}
              onSelect={() => runAction(confirming)}
              data-testid="cmdk-confirm"
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-ember-strong"
            >
              <Icon name="check" className="size-4" />
              Yes, {confirming.title.toLowerCase()}
            </Command.Item>
            <Command.Item
              value="confirm:cancel"
              onSelect={() => setConfirming(null)}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink"
            >
              <Icon name="close" className="size-4 text-ink-faint" />
              Cancel
            </Command.Item>
          </Command.Group>
        ) : null}
        {query.trim() === '' ? (
          <>
            {actionGroup('page')}
            {actionGroup('create')}
          </>
        ) : (
          <>
            {actionGroup('page')}
            {actionGroup('create')}
            {actionGroup('ask')}
          </>
        )}
        {/* App jumps after the docs, so Enter still opens the best doc when a title matches too. */}
        {jumpGroup}
        {query.trim() === '' ? null : (
          <>
            {actionGroup('go')}
            {actionGroup('prefs')}
          </>
        )}
        {query.trim() &&
        !searching &&
        jumps.length === 0 &&
        actions.length === 0 &&
        titles.length === 0 &&
        fullText.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-faint">
            {error
              ? 'Search is unavailable right now. Try again in a moment.'
              : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : null}
        {searching ? <p className="px-3 py-2 text-xs text-ink-faint">Searching the text…</p> : null}
      </Command.List>
    </Command.Dialog>
  )
}

function ResultItem({
  hit,
  spaceLabel,
  query,
  onSelect,
}: {
  hit: Hit
  spaceLabel: string
  query: string
  onSelect: (hit: Hit) => void
}) {
  return (
    <Command.Item
      value={`${hit.space}:${hit.path}`}
      onSelect={() => onSelect(hit)}
      data-testid="search-result"
      data-path={hit.path}
      className="flex cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2"
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {highlight(hit.title, query)}
        </span>
        <span className="shrink-0 text-xs text-ink-faint">
          {KIND_LABEL[isTaskFile(hit.path) ? 'task' : (meetingFileKind(hit.path) ?? 'doc')]} ·{' '}
          {spaceLabel}
        </span>
      </span>
      {hit.snippet ? (
        <span className="line-clamp-2 text-xs text-ink-soft">{snippet(hit.snippet, query)}</span>
      ) : null}
      <span className="truncate font-mono text-[0.68rem] text-ink-faint">
        {hit.path.replace(/^(docs|meetings)\//, '')}
      </span>
    </Command.Item>
  )
}

function ActionItem({ action, onSelect }: { action: Action; onSelect: () => void }) {
  const spec = action.shortcut ? SHORTCUTS[action.shortcut].keys[0] : undefined
  return (
    <Command.Item
      value={`command:${action.id}`}
      onSelect={onSelect}
      data-testid={`cmdk-command-${action.id}`}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink"
    >
      {action.icon ? <Icon name={action.icon} className="size-4 text-ink-faint" /> : null}
      <span className="min-w-0 flex-1 truncate">{action.title}</span>
      {spec ? <Keys spec={spec} className="shrink-0" /> : null}
    </Command.Item>
  )
}
