import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { api } from '../api/client'
import type { Me, RecentItem, Space, StarItem } from '../api/types'
import { hearthSocket } from '../api/ws'
import { TreeStore } from './treeStore'

const DEFAULT_IDLE_COMMIT_MS = 60_000
const SPACE_KEY = 'hearth.space'

export interface Notice {
  id: number
  message: string
}

export interface Session {
  me: Me | null
  spaces: Space[]
  /** The space shown in the sidebar. */
  space: string
  setSpace: (space: string) => void
  spaceLabel: (space: string) => string
  idleCommitMs: number
  tree: TreeStore
  recents: RecentItem[]
  stars: StarItem[]
  isStarred: (space: string, path: string) => boolean
  toggleStar: (space: string, path: string) => Promise<void>
  refreshRecents: () => void
  notices: Notice[]
  notify: (message: string) => void
  dismiss: (id: number) => void
}

const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside SessionProvider')
  return session
}

function storedSpace(): string {
  try {
    return localStorage.getItem(SPACE_KEY) ?? 'team'
  } catch {
    return 'team'
  }
}

let noticeId = 0

export function SessionProvider({ children, tree }: { children: ReactNode; tree?: TreeStore }) {
  const [store] = useState(() => tree ?? new TreeStore())
  const [me, setMe] = useState<Me | null>(null)
  const [space, setSpaceState] = useState(storedSpace)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [stars, setStars] = useState<StarItem[]>([])
  const [notices, setNotices] = useState<Notice[]>([])

  const notify = useCallback((message: string) => {
    noticeId += 1
    const id = noticeId
    setNotices((list) => [...list.slice(-2), { id, message }])
    setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), 6000)
  }, [])

  const dismiss = useCallback((id: number) => {
    setNotices((list) => list.filter((n) => n.id !== id))
  }, [])

  const refreshRecents = useCallback(() => {
    api.recents().then(setRecents, () => {})
  }, [])

  useEffect(() => {
    api.me().then(setMe, () => {})
    refreshRecents()
    api.stars().then(setStars, () => {})
  }, [refreshRecents])

  useEffect(() => {
    hearthSocket.start()
    const offChanged = hearthSocket.onChanged((event) =>
      store.refreshPaths(event.space, event.paths),
    )
    const offReconnect = hearthSocket.onReconnect(() => store.refreshAll())
    return () => {
      offChanged()
      offReconnect()
      hearthSocket.stop()
    }
  }, [store])

  const setSpace = useCallback((next: string) => {
    setSpaceState(next)
    try {
      localStorage.setItem(SPACE_KEY, next)
    } catch {
      // Not remembered across reloads; fine.
    }
  }, [])

  const spaces = useMemo(
    () => me?.spaces ?? [{ name: 'team', kind: 'team' as const, label: 'Team' }],
    [me],
  )

  const spaceLabel = useCallback(
    (name: string) => spaces.find((s) => s.name === name)?.label ?? name,
    [spaces],
  )

  const isStarred = useCallback(
    (s: string, path: string) => stars.some((star) => star.space === s && star.path === path),
    [stars],
  )

  const toggleStar = useCallback(
    async (s: string, path: string) => {
      const starred = !isStarred(s, path)
      setStars((list) =>
        starred
          ? [...list, { space: s, path, title: null }]
          : list.filter((x) => !(x.space === s && x.path === path)),
      )
      try {
        await api.setStar(s, path, starred)
      } catch {
        notify('Couldn’t update Starred. Try again.')
        api.stars().then(setStars, () => {})
      }
    },
    [isStarred, notify],
  )

  // A remembered personal space from another account falls back to Team.
  const visibleSpace = me && !spaces.some((s) => s.name === space) ? 'team' : space

  const value = useMemo<Session>(
    () => ({
      me,
      spaces,
      space: visibleSpace,
      setSpace,
      spaceLabel,
      idleCommitMs: me?.settings.idleCommitMs ?? DEFAULT_IDLE_COMMIT_MS,
      tree: store,
      recents,
      stars,
      isStarred,
      toggleStar,
      refreshRecents,
      notices,
      notify,
      dismiss,
    }),
    [
      me,
      spaces,
      visibleSpace,
      setSpace,
      spaceLabel,
      store,
      recents,
      stars,
      isStarred,
      toggleStar,
      refreshRecents,
      notices,
      notify,
      dismiss,
    ],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
