import { MAX_DECLINE_REASON } from '@hotsauce/format'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { HotsauceApiError } from '../../api/client'
import { type FilledValue, type PublicEnvelope, type SignField, signLinkApi } from '../../api/sign'
import { product } from '../../brand/product'
import { BrandMark } from '../../components/BrandMark'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import { FieldBox, localDay } from './FieldBox'
import { PdfPages } from './PdfPages'
import { type Signature, SignatureDialog } from './SignaturePad'
import { missingFields, SigningPanel } from './SigningPanel'
import { SignLayout } from './SignLayout'

// `/signing/:token`: the page someone outside the team opens from their emailed signing link
// (docs/PLAN-sign.md R14–R16). No account and no app shell: the link's secret is the key.

type Load =
  | { status: 'loading' }
  | { status: 'ready'; env: PublicEnvelope }
  | { status: 'gone'; message: string }
  | { status: 'error'; message: string }

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

export default function SigningLinkPage() {
  const { token = '' } = useParams()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null)

  useEffect(() => {
    // The link's secret is in this page's address: never send it on as a referrer.
    const meta = document.createElement('meta')
    meta.name = 'referrer'
    meta.content = 'no-referrer'
    document.head.append(meta)
    return () => meta.remove()
  }, [])

  const show = useCallback((env: PublicEnvelope) => {
    setLoad({ status: 'ready', env })
    document.title = `${env.title} · ${product()}`
  }, [])

  useEffect(() => {
    let live = true
    signLinkApi.get(token).then(
      (env) => {
        if (!live) return
        show(env)
        if (env.status === 'ready') {
          signLinkApi.source(token).then(
            (data) => live && setPdf(data),
            (e: unknown) => live && setLoad({ status: 'error', message: message(e, 'Failed') }),
          )
        }
      },
      (e: unknown) => {
        if (!live) return
        if (e instanceof HotsauceApiError && (e.status === 404 || e.status === 409)) {
          setLoad({ status: 'gone', message: e.message })
        } else setLoad({ status: 'error', message: message(e, 'Failed') })
      },
    )
    return () => {
      live = false
    }
  }, [token, show])

  const env = load.status === 'ready' ? load.env : null
  return (
    <div className="min-h-full bg-paper px-3 py-5 md:py-10" data-testid="signing-link">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        {env && env.status === 'ready' ? (
          <Signing token={token} env={env} pdf={pdf} onDone={show} />
        ) : env ? (
          <Card>
            <Outcome env={env} />
          </Card>
        ) : load.status === 'gone' ? (
          <Card>
            <h1 className="font-display text-2xl font-semibold text-ink">This link doesn’t work</h1>
            <p className="mt-2 text-ink-soft" data-testid="signing-gone">
              {load.message}
            </p>
          </Card>
        ) : load.status === 'error' ? (
          <Card>
            <h1 className="font-display text-2xl font-semibold text-ink">
              Couldn’t open the document
            </h1>
            <p className="mt-2 text-ink-soft">{load.message}</p>
          </Card>
        ) : (
          <p className="mt-16 text-center text-sm text-ink-faint">Loading…</p>
        )}
        <p className="flex items-center justify-center gap-1.5 text-xs text-ink-faint">
          <BrandMark className="size-3.5" />
          Signing by {product()}
        </p>
      </main>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl rounded-2xl border border-ash bg-paper-raised p-5 shadow-sm md:p-8">
      {children}
    </div>
  )
}

/** What the link shows once its person has answered, or the envelope has ended. */
function Outcome({ env }: { env: PublicEnvelope }) {
  const lines: Record<PublicEnvelope['status'], { head: string; body: string }> = {
    ready: { head: '', body: '' },
    signed: {
      head: 'You’ve signed',
      body: `Thanks. When everyone has signed, you’ll get the signed PDF by email from ${env.org}.`,
    },
    completed: {
      head: 'Everyone has signed',
      body: 'The signed PDF and its audit certificate were emailed to everyone on it.',
    },
    declined: {
      head: 'Declined',
      body: `This document was declined, so it can’t be signed now. ${env.sender} at ${env.org} has been told.`,
    },
    voided: {
      head: 'Cancelled',
      body: `${env.sender} cancelled this document, so it can’t be signed.`,
    },
  }
  const { head, body } = lines[env.status]
  return (
    <div data-testid={`signing-${env.status}`}>
      <p className="flex items-center gap-2 text-sm font-medium text-moss">
        <Icon name={env.status === 'declined' || env.status === 'voided' ? 'close' : 'check'} />
        {head}
      </p>
      <h1 className="mt-2 font-display text-2xl font-semibold text-ink">{env.title}</h1>
      <p className="mt-2 text-ink-soft">{body}</p>
    </div>
  )
}

function Signing({
  token,
  env,
  pdf,
  onDone,
}: {
  token: string
  env: PublicEnvelope
  pdf: ArrayBuffer | null
  onDone: (env: PublicEnvelope) => void
}) {
  const [signing, setSigning] = useState(false)
  const [values, setValues] = useState<Record<string, FilledValue>>({})
  const [consent, setConsent] = useState(false)
  const [padFor, setPadFor] = useState<SignField | null>(null)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const missing = missingFields(env.fields, values)

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      const dates = env.fields
        .filter((f) => f.type === 'date')
        .map((f) => ({ field: f.id, value: localDay() }))
      onDone(
        await signLinkApi.sign(token, { values: [...Object.values(values), ...dates], consent }),
      )
    } catch (e) {
      setError(message(e, 'Couldn’t sign'))
      setBusy(false)
    }
  }

  const decline = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await signLinkApi.decline(token, reason))
    } catch (e) {
      setError(message(e, 'Couldn’t decline'))
      setDeclining(false)
      setBusy(false)
    }
  }

  return (
    <SignLayout
      rail={
        <>
          <header className="flex flex-col gap-1 px-1">
            <p className="text-sm text-ink-soft">
              {env.sender} at {env.org} asks {env.signer.name} to sign
            </p>
            <h1
              className="font-display text-2xl font-semibold text-ink"
              data-testid="signing-title"
            >
              {env.title}
            </h1>
            <p className="text-xs text-ink-faint">
              {env.source.name} · {env.source.pages.length}{' '}
              {env.source.pages.length === 1 ? 'page' : 'pages'}
            </p>
          </header>

          {error ? (
            <p role="alert" className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}

          {signing ? (
            <SigningPanel
              missing={missing.length}
              consent={consent}
              onConsent={setConsent}
              busy={busy}
              onFinish={() => void finish()}
            >
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={() => setDeclining(true)}
                data-testid="signing-decline"
              >
                Decline
              </button>
            </SigningPanel>
          ) : (
            <section className="flex flex-col gap-3 rounded-xl bg-paper-raised p-4 ring-1 ring-ash">
              <p className="text-sm text-ink">
                Read the document. When you’re ready, press Start signing and fill in the
                highlighted fields. You don’t need an account.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => setSigning(true)}
                  data-testid="signing-start"
                >
                  <Icon name="sign" />
                  Start signing
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => setDeclining(true)}
                  data-testid="signing-decline"
                >
                  Decline
                </button>
              </div>
            </section>
          )}
        </>
      }
    >
      {pdf ? (
        <PdfPages
          data={pdf}
          pages={env.source.pages}
          overlay={(page) =>
            env.fields
              .filter((f) => f.page === page)
              .map((f) => (
                <FieldBox
                  key={f.id}
                  field={f}
                  editable={false}
                  selected={false}
                  signable={signing}
                  value={values[f.id]}
                  onSelect={() => {}}
                  onMove={() => {}}
                  onResize={() => {}}
                  onRemove={() => {}}
                  onFill={() => {
                    if (f.type === 'checkbox') {
                      setValues((v) => ({
                        ...v,
                        [f.id]: { field: f.id, checked: !v[f.id]?.checked },
                      }))
                    } else if (f.type === 'signature' || f.type === 'initials') {
                      setPadFor(f)
                    }
                  }}
                  onText={(text) =>
                    setValues((v) => ({ ...v, [f.id]: { field: f.id, value: text } }))
                  }
                />
              ))
          }
          onPageClick={() => {}}
        />
      ) : (
        <p className="text-sm text-ink-soft">Opening the PDF…</p>
      )}

      {padFor ? (
        <SignatureDialog
          kind={padFor.type === 'initials' ? 'initials' : 'signature'}
          name={env.signer.name}
          onClose={() => setPadFor(null)}
          onDone={(s: Signature) => {
            setValues((v) => ({ ...v, [padFor.id]: { field: padFor.id, ...s } }))
            setPadFor(null)
          }}
        />
      ) : null}

      {declining ? (
        <Dialog title="Decline to sign?" onClose={() => setDeclining(false)}>
          <p className="text-sm text-ink-soft">
            Nobody can sign it after you decline. {env.sender} gets an email saying so, with your
            reason if you give one.
          </p>
          <label className="mt-3 flex flex-col gap-1 text-sm text-ink-soft">
            Reason (optional)
            <textarea
              className="min-h-20 rounded-lg border border-ash-strong bg-paper px-3 py-2 text-[15px] text-ink focus:border-ember focus:outline-none"
              value={reason}
              maxLength={MAX_DECLINE_REASON}
              onChange={(e) => setReason(e.target.value)}
              data-testid="signing-decline-reason"
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setDeclining(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => void decline()}
              data-testid="signing-decline-confirm"
            >
              Decline
            </button>
          </div>
        </Dialog>
      ) : null}
    </SignLayout>
  )
}
