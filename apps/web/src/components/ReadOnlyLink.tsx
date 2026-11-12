import { useCallback, useState } from 'react'
import { absoluteShareUrl, type ShareState, sharesApi } from '../api/shares'
import { org } from '../brand/product'
import { useSession } from '../state/session'
import { MenuItem } from './Menu'

// Read-only links (ARCHITECTURE §20): the Share menu's items for a doc or meeting note, and the
// note editor's. The link always shows the latest version; turning it off stops it at once.

let whoCache: Promise<boolean> | null = null
/** Whether links open for anyone (signed out too); asked once per page load. */
function linksArePublic(): Promise<boolean> {
  whoCache ??= sharesApi.sharing().then(
    (s) => s.publicShareLinks,
    () => false,
  )
  return whoCache
}
/** Settings → Organization changed it: ask again next time. */
export function forgetLinkSetting(): void {
  whoCache = null
}

export async function whoCanOpen(): Promise<string> {
  return (await linksArePublic())
    ? 'Anyone with the link can read it.'
    : `Anyone signed in to ${org() || 'your organization'} can read it.`
}

export function useReadOnlyLink(space: string, path: string) {
  const { notify } = useSession()
  const [state, setState] = useState<ShareState | null>(null)

  const refresh = useCallback(() => {
    sharesApi.state(space, path).then(setState, () => setState(null))
  }, [space, path])

  const copy = useCallback(
    async (url: string, lead: string) => {
      // Write first, while the click still counts as the person's gesture (Safari needs it).
      const writing =
        navigator.clipboard?.writeText(absoluteShareUrl(url)) ??
        Promise.reject(new Error('No clipboard'))
      try {
        const [, who] = await Promise.all([writing, whoCanOpen()])
        notify(`${lead} ${who}`)
      } catch {
        notify(`Couldn’t copy the link. It is ${absoluteShareUrl(url)}`)
      }
    },
    [notify],
  )

  const turnOn = useCallback(
    async (before?: () => Promise<unknown>) => {
      try {
        await before?.()
        const next = await sharesApi.set(space, path, true)
        setState(next)
        if (next.url) await copy(next.url, 'Read-only link copied.')
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Couldn’t make a read-only link.')
      }
    },
    [space, path, copy, notify],
  )

  const turnOff = useCallback(async () => {
    try {
      setState(await sharesApi.set(space, path, false))
      notify('Read-only link turned off. It no longer opens.')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Couldn’t turn the link off.')
    }
  }, [space, path, notify])

  return { state, refresh, turnOn, turnOff, copy }
}

/** The menu items: one to make a link, or two to copy it and turn it off. */
export function ReadOnlyLinkItems({
  link,
  close,
  before,
}: {
  link: ReturnType<typeof useReadOnlyLink>
  close: () => void
  /** Commits pending edits first, so the link shows the current text. */
  before?: () => Promise<unknown>
}) {
  const { state } = link
  if (state?.url) {
    const url = state.url
    return (
      <>
        <MenuItem
          icon="link"
          testId="read-only-link-copy"
          onSelect={() => {
            close()
            void link.copy(url, 'Read-only link copied.')
          }}
        >
          Copy read-only link
        </MenuItem>
        <MenuItem
          icon="close"
          testId="read-only-link-off"
          danger
          onSelect={() => {
            close()
            void link.turnOff()
          }}
        >
          Turn off read-only link
        </MenuItem>
      </>
    )
  }
  return (
    <MenuItem
      icon="link"
      testId="read-only-link-on"
      onSelect={() => {
        close()
        void link.turnOn(before)
      }}
    >
      Share read-only link
    </MenuItem>
  )
}
