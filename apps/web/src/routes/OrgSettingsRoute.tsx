import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api/client'
import { type OrgState, orgEditor, waitForRestart } from '../api/org'
import { MeetingsPageHeader, primaryButton } from '../apps/meetings/components/common'
import { product } from '../brand/product'
import { Callout, messageOf } from './org/fields'
import {
  AiSection,
  BrandSection,
  OrgSection,
  type SectionProps,
  SignInSection,
  StorageSection,
  Summary,
} from './org/sections'

/**
 * `/settings/organization`: the setup wizard's sections on one page, for admins (ARCHITECTURE
 * §11.2). Brand changes show at once; settings and keys take effect when the server restarts,
 * which the Apply button does.
 */
export default function OrgSettingsRoute() {
  const editor = useMemo(() => orgEditor(null), [])
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [state, setState] = useState<OrgState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [applying, setApplying] = useState<'idle' | 'restarting' | 'slow'>('idle')

  useEffect(() => {
    document.title = `Organization · ${product()}`
    api.me().then(
      (me) => {
        setIsAdmin(me.principal.isAdmin)
        if (me.principal.isAdmin)
          editor.state().then(setState, (err: unknown) => setError(messageOf(err)))
      },
      (err: unknown) => setError(messageOf(err)),
    )
  }, [editor])

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
    <>
      <MeetingsPageHeader title="Organization" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 pt-6 pb-24 md:px-6 md:pt-10">
          <Link to="/settings" className="text-sm text-ink-faint hover:text-ink">
            ← Settings
          </Link>
          {error ? (
            <p role="alert" className="text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
          {isAdmin === false ? (
            <p className="text-ink-soft">Only admins can change the organization’s settings.</p>
          ) : !state ? null : (
            <>
              <Summary state={state} />
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
              <OrgSection {...(props('restart') as SectionProps)} />
              <BrandSection {...(props('live') as SectionProps)} />
              <SignInSection {...(props('restart') as SectionProps)} />
              <AiSection {...(props('restart') as SectionProps)} />
              <StorageSection {...(props('restart') as SectionProps)} />
              <Callout>
                Values set in the server’s environment always win and show as locked here. Keys are
                stored encrypted on the server and are never shown again.
              </Callout>
            </>
          )}
        </div>
      </div>
    </>
  )
}
