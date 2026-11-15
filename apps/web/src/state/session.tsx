import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api, HearthApiError } from '../api/client'
import type { Me, RecentItem, Space, StarItem } from '../api/types'
import { hearthSocket } from '../api/ws'
import { org } from '../brand/product'
import { isOnline, onBackOnline } from '../lib/connection'
import { offlineMe, rememberedMember, rememberMember } from '../lib/offlineStart'
import { displayName } from '../lib/paths'
import { sendWaitingDrafts } from '../lib/sendWaiting'
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
  const meFromServer = useRef(false)
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
    api.me().then(
      (next) => {
        meFromServer.current = true
        setMe(next)
        // What an offline start opens as (lib/offlineStart): id, name, email, workspace only.
        rememberMember(next.principal, org() || null)
      },
      (err: unknown) => {
        // Offline: who this device last saw signed in, so the shell still says who you are.
        // Not for an error answer: that member would show without their spaces or admin items.
        if (!(err instanceof HearthApiError && err.code === 'network')) return
        const member = rememberedMember()
        if (member) setMe((current) => current ?? offlineMe(member))
      },
    )
    refreshRecents()
    api.stars().then(setStars, () => {})
  }, [refreshRecents])

  // Doc saves that waited on this device for the connection (docs/PLAN-offline.md, A4.4): sent
  // at start and whenever the connection comes back. An open doc sends its own.
  const userId = me?.principal.userId
  useEffect(() => {
    // Only as the member the server says is signed in: not the offline stand-in.
    if (!userId || !meFromServer.current) return
    const send = () =>
      void sendWaitingDrafts(userId).then(({ sent, conflicts }) => {
        if (sent > 0)
          notify(
            sent === 1
              ? 'A doc you edited offline is saved.'
              : `${sent} docs you edited offline are saved.`,
          )
        for (const path of conflicts)
          notify(
            `${displayName(path)} changed elsewhere while you were offline. Open it to choose what to keep.`,
          )
      })
    if (isOnline()) send()
    return onBackOnline(send)
  }, [notify, userId])

  useEffect(() => {
    hotsauceSocket.start()
    const offChanged = hotsauceSocket.onChanged((event) =>
      store.refreshPaths(event.space, event.paths),
    )
    const offReconnect = hotsauceSocket.onReconnect(() => store.refreshAll())
    return () => {
      offChanged()
      offReconnect()
      hotsauceSocket.stop()
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
