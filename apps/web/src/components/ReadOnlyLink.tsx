import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type DriveFile, filesApi } from '../api/files'
import {
  absoluteShareUrl,
  type LinkChoice,
  type LinkPolicy,
  type ShareState,
  sharesApi,
} from '../api/shares'
import { primaryButton, secondaryButton } from '../apps/meetings/components/common'
import { org } from '../brand/product'
import { useSession } from '../state/session'
import { Dialog } from './Dialog'
import { MenuItem } from './Menu'

// Read-only links (ARCHITECTURE §20, docs/PLAN-outside-links.md): the Share menu's items for a
// doc, meeting note, note, page, clip or file. Making one asks who it's for and when it ends;
// the link always shows the latest version, and turning it off stops it at once.

let allowCache: Promise<boolean> | null = null
/** Whether members may make links anyone can open; asked once per page load. */
export function anyoneAllowed(): Promise<boolean> {
  allowCache ??= sharesApi.sharing().then(
    (s) => s.publicShareLinks,
    () => false,
  )
  return allowCache
}
/** Settings → Organization changed it: ask again next time. */
export function forgetLinkSetting(): void {
  allowCache = null
}

const orgName = () => org() || 'your organization'

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** "Anyone with the link · ends 16 Dec 2026", for the menu and the copied notice. */
export function describeLink(link: LinkPolicy | null): string {
  const who = link?.anyone ? 'Anyone with the link' : `People in ${orgName()}`
  if (!link?.expiresAt) return `${who} · never ends`
  return `${who} · ${link.ended ? 'ended' : 'ends'} ${day(link.expiresAt)}`
}

/** What a link is on: how to read it and how to turn it on or off. */
export interface LinkTarget {
  key: string
  load(): Promise<ShareState>
  set(on: boolean, choice?: LinkChoice): Promise<ShareState>
}

export const pathLink = (space: string, path: string): LinkTarget => ({
  key: `path:${space}:${path}`,
  load: () => sharesApi.state(space, path),
  set: (on, choice) => sharesApi.set(space, path, on, choice),
})

export const clipLink = (id: string): LinkTarget => ({
  key: `clip:${id}`,
  load: () => sharesApi.clipState(id),
  set: (on, choice) => sharesApi.setClip(id, on, choice),
})

const fileState = (f: DriveFile): ShareState => ({
  token: f.shareToken ?? null,
  url: f.shareUrl,
  link: f.shareLink ?? null,
})

/** A Files item; `changed` hears the file as the server returns it after a change. */
export const fileLink = (file: DriveFile, changed?: (f: DriveFile) => void): LinkTarget => ({
  key: `file:${file.space}:${file.id}`,
  load: async () => fileState(await filesApi.get(file.space, file.id)),
  set: async (on, choice) => {
    const next = await filesApi.share(file.space, file.id, on, choice)
    changed?.(next)
    return fileState(next)
  },
})

export function useReadOnlyLink(space: string, path: string) {
  const target = useMemo(() => pathLink(space, path), [space, path])
  return useLink(target)
}

export function useLink(target: LinkTarget) {
  const { notify } = useSession()
  const [state, setState] = useState<ShareState | null>(null)
  const [choosing, setChoosing] = useState<{ before?: () => Promise<unknown> } | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target

  const refresh = useCallback(() => {
    const t = targetRef.current
    t.load().then(
      (s) => {
        if (targetRef.current.key === t.key) setState(s)
      },
      () => setState(null),
    )
  }, [])

  const copy = useCallback(
    async (url: string, lead: string, link: LinkPolicy | null) => {
      // Write first, while the click still counts as the person's gesture (Safari needs it).
      const writing =
        navigator.clipboard?.writeText(absoluteShareUrl(url)) ??
        Promise.reject(new Error('No clipboard'))
      try {
        await writing
        notify(`${lead} ${describeLink(link)}.`)
      } catch {
        notify(`Couldn’t copy the link. It is ${absoluteShareUrl(url)}`)
      }
    },
    [notify],
  )

  /** Opens the pop-up that asks who it's for and when it ends. */
  const turnOn = useCallback((before?: () => Promise<unknown>) => {
    setChoosing(before ? { before } : {})
  }, [])

  const make = useCallback(
    async (choice: LinkChoice) => {
      const before = choosing?.before
      setChoosing(null)
      try {
        await before?.()
        const next = await targetRef.current.set(true, choice)
        setState(next)
        if (next.url) await copy(next.url, 'Read-only link copied.', next.link)
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Couldn’t make a read-only link.')
      }
    },
    [choosing, copy, notify],
  )

  const turnOff = useCallback(async () => {
    try {
      setState(await targetRef.current.set(false))
      notify('Read-only link turned off. It no longer opens.')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Couldn’t turn the link off.')
    }
  }, [notify])

  const dialog: ReactNode = choosing ? (
    <LinkDialog onCancel={() => setChoosing(null)} onMake={(c) => void make(c)} />
  ) : null

  return { state, refresh, turnOn, turnOff, copy, dialog }
}

/** Who the link is for and when it ends. 30 days is the default (the owner's pick, 2026-11-17). */
function LinkDialog({
  onCancel,
  onMake,
}: {
  onCancel: () => void
  onMake: (choice: LinkChoice) => void
}) {
  const [anyone, setAnyone] = useState(false)
  const [days, setDays] = useState<7 | 30 | 0>(30)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void anyoneAllowed().then((a) => live && setAllowed(a))
    return () => {
      live = false
    }
  }, [])
  const radio = 'mt-1 accent-[var(--ember)]'
  return (
    <Dialog title="Make a read-only link" onClose={onCancel} testId="link-dialog">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          onMake({ anyone: anyone && allowed === true, expiresDays: days })
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">Who can open it</legend>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="radio"
              name="who"
              className={radio}
              checked={!anyone}
              onChange={() => setAnyone(false)}
              data-testid="link-who-org"
            />
            <span>
              People in {orgName()}
              <span className="block text-ink-faint">They sign in to open it.</span>
            </span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${allowed === false ? 'text-ink-faint' : 'text-ink'}`}
          >
            <input
              type="radio"
              name="who"
              className={radio}
              checked={anyone}
              disabled={allowed !== true}
              onChange={() => setAnyone(true)}
              data-testid="link-who-anyone"
            />
            <span>
              Anyone with the link
              <span className="block text-ink-faint" data-testid="link-who-anyone-note">
                {allowed === false
                  ? `Turned off for ${orgName()}. An admin can turn it on in Settings → Organization.`
                  : 'No sign-in needed. Use it for people outside.'}
              </span>
            </span>
          </label>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm text-ink">
          <span className="font-medium">Link ends</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 0)}
            data-testid="link-expiry"
            className="h-10 rounded-lg border border-ash-strong bg-paper-raised px-3 text-ink"
          >
            <option value={7}>In 7 days</option>
            <option value={30}>In 30 days</option>
            <option value={0}>Never</option>
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={primaryButton} data-testid="link-make">
            Make link and copy
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** The menu items: one to make a link, or the link's details, Copy and Turn off. */
export function ReadOnlyLinkItems({
  link,
  close,
  before,
}: {
  link: ReturnType<typeof useLink>
  close: () => void
  /** Commits pending edits first, so the link shows the current text. */
  before?: () => Promise<unknown>
}) {
  const { state } = link
  const about = (
    <p role="none" className="px-3 pt-1 pb-0.5 text-xs text-ink-faint" data-testid="link-about">
      {describeLink(state?.link ?? null)}
    </p>
  )
  if (state?.url && state.link?.ended) {
    return (
      <>
        {about}
        <MenuItem
          icon="link"
          testId="read-only-link-on"
          onSelect={() => {
            close()
            link.turnOn(before)
          }}
        >
          Make a new read-only link
        </MenuItem>
      </>
    )
  }
  if (state?.url) {
    const url = state.url
    return (
      <>
        {about}
        <MenuItem
          icon="link"
          testId="read-only-link-copy"
          onSelect={() => {
            close()
            void link.copy(url, 'Read-only link copied.', state.link)
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
        link.turnOn(before)
      }}
    >
      Share read-only link
    </MenuItem>
  )
}
