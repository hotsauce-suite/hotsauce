import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { type OrgState, orgEditor, waitForRestart } from '../api/org'
import { primaryButton } from '../apps/meetings/components/common'
import { OrgWeatherSection } from '../apps/today/WeatherSettings'
import { product } from '../brand/product'
import { useSession } from '../state/session'
import { AssistantSection } from './org/AssistantSection'
import { BackupsSection } from './org/BackupsSection'
import { ChatRoomsSection } from './org/ChatRoomsSection'
import { Callout, messageOf } from './org/fields'
import { LinkSharingSection } from './org/LinkSharingSection'
import {
  AiSection,
  BrandSection,
  OrgSection,
  type SectionProps,
  SignInSection,
  StorageSection,
  Summary,
} from './org/sections'
import { UpdatesSection } from './org/UpdatesSection'
import { ORG_PAGES, type OrgPageId, orgPageOf } from './settings/pages'

/**
 * Whether a save is waiting for the server to restart. Kept outside the component so the banner
 * is still there when an admin visits General or Apps and comes back; applying reloads the page,
 * which clears it.
 */
let unapplied = false

/** For tests: forget a save left waiting by an earlier test. */
export function forgetUnapplied() {
  unapplied = false
}

/**
 * `/settings/organization` and its pages, for admins: the setup wizard's sections and the
 * organization's other settings, grouped (ARCHITECTURE §11.2, docs/PLAN-settings-pages.md O1–O6).
 * Brand changes show at once; settings and keys take effect when the server restarts, which the
 * Apply button does. A save waiting to be applied follows the admin from page to page.
 */
export default function OrgSettingsRoute() {
  const page = orgPageOf(useParams().page)
  const editor = useMemo(() => orgEditor(null), [])
  const me = useSession().me
  const isAdmin = me ? me.principal.isAdmin : null
  const [state, setState] = useState<OrgState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPendingState] = useState(unapplied)
  const setPending = (on: boolean) => {
    unapplied = on
    setPendingState(on)
  }
  const [applying, setApplying] = useState<'idle' | 'restarting' | 'slow'>('idle')

  const label = ORG_PAGES.find((p) => p.id === page)?.label ?? 'Organization'
  useEffect(() => {
    document.title = `${label} · Organization · ${product()}`
  }, [label])

  useEffect(() => {
    if (isAdmin) editor.state().then(setState, (err: unknown) => setError(messageOf(err)))
  }, [editor, isAdmin])

  const apply = async () => {
    setError(null)
    try {
      await editor.apply()
      setApplying('restarting')
      const ok = await waitForRestart()
      if (ok) window.location.reload()
      else setApplying('slow')
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const props = (onSaved: 'restart' | 'live'): SectionProps | null =>
    state
      ? {
          state,
          editor,
          onState: (next) => {
            setState(next)
            if (onSaved === 'restart') setPending(true)
          },
          submitLabel: 'Save',
          onDone: onSaved === 'live' ? () => window.location.reload() : undefined,
        }
      : null

  return (
    <div className="flex flex-col gap-10" data-testid="org-settings" data-page={page ?? ''}>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      {isAdmin === false ? (
        <p className="text-ink-soft" data-testid="org-admins-only">
          Only admins can change the organization’s settings.
        </p>
      ) : page === null ? (
        <p className="text-ink-soft">There’s no settings page at this address.</p>
      ) : !state ? null : (
        <>
          {pending || applying !== 'idle' ? (
            <div
              data-testid="apply-banner"
              className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-ember/40 bg-paper-raised p-3.5 shadow-sm"
            >
              <p className="min-w-0 flex-1 text-sm text-ink">
                {applying === 'restarting'
                  ? 'Restarting with the new settings…'
                  : applying === 'slow'
                    ? 'The server is slow to come back. Reload in a minute.'
                    : 'Saved. Apply to restart the server with the new settings; it takes about ten seconds.'}
              </p>
              {applying === 'idle' ? (
                <button
                  type="button"
                  data-testid="apply"
                  className={primaryButton}
                  onClick={() => void apply()}
                >
                  Apply now
                </button>
              ) : null}
            </div>
          ) : null}
          <OrgPage
            page={page}
            state={state}
            restart={props('restart') as SectionProps}
            live={props('live') as SectionProps}
          />
          <Callout>
            Values set in the server’s environment always win and show as locked here. Keys are
            stored encrypted on the server and are never shown again.
          </Callout>
        </>
      )}
    </div>
  )
}

/** What each organization page holds, in order. */
function OrgPage({
  page,
  state,
  restart,
  live,
}: {
  page: OrgPageId
  state: OrgState
  restart: SectionProps
  live: SectionProps
}) {
  switch (page) {
    case 'workspace':
      return (
        <>
          <Summary state={state} />
          <OrgSection {...restart} part="names" />
          <OrgWeatherSection />
          <OrgSection {...restart} part="chat" />
          <ChatRoomsSection />
        </>
      )
    case 'brand':
      return <BrandSection {...live} />
    case 'people':
      return (
        <>
          <OrgSection {...restart} part="people" />
          <SignInSection {...restart} />
          <LinkSharingSection />
        </>
      )
    case 'ai':
      return (
        <>
          <AiSection {...restart} />
          <AssistantSection />
        </>
      )
    case 'data':
      return (
        <>
          <StorageSection {...restart} />
          <BackupsSection />
          <UpdatesSection />
        </>
      )
  }
}
