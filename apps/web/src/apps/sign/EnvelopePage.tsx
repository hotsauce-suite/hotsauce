import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  type EnvelopeView,
  type FilledValue,
  type SignField,
  type SignFieldType,
  signApi,
} from '../../api/sign'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { LoadError } from '../../components/LoadError'
import { PageHeader } from '../../components/PageHeader'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import { FIELD_LABEL, FIELD_TYPES, moveField, newField, placement, resizeField } from './fields'
import { PdfPages } from './PdfPages'
import { type Signature, SignatureDialog } from './SignaturePad'
import { STATUS_LABEL, when } from './SignPage'

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** `/sign/:space/:id`: place fields on a draft, sign it, or see a finished envelope. */
export default function EnvelopePage() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { me, notify } = useSession()
  const [env, setEnv] = useState<EnvelopeView | null>(null)
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fields, setFields] = useState<SignField[]>([])
  const [title, setTitle] = useState('')
  const [dirty, setDirty] = useState(false)
  const [placing, setPlacing] = useState<SignFieldType | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [values, setValues] = useState<Record<string, FilledValue>>({})
  const [consent, setConsent] = useState(false)
  const [padFor, setPadFor] = useState<SignField | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const adopt = useCallback((view: EnvelopeView) => {
    setEnv(view)
    setFields(view.fields)
    setTitle(view.title)
    setDirty(false)
  }, [])

  const load = useCallback(() => {
    setLoadError(null)
    signApi
      .get(space, id)
      .then((view) => {
        adopt(view)
        document.title = `${view.title} · Sign · ${product()}`
        if (view.status === 'draft' || view.status === 'sent') {
          return signApi.source(space, id).then(setPdf)
        }
      })
      .catch((e) => setLoadError(message(e, 'Couldn’t open this envelope')))
  }, [space, id, adopt])

  useEffect(load, [load])

  if (loadError) {
    return (
      <>
        <PageHeader title="Sign" menu={false} back={{ to: '/sign', label: 'Sign' }} />
        <div className="p-6">
          <LoadError things="this envelope" onRetry={load} />
          <p className="mt-2 text-sm text-ink-soft">{loadError}</p>
        </div>
      </>
    )
  }
  if (!env) {
    return <PageHeader title="Sign" menu={false} back={{ to: '/sign', label: 'Sign' }} />
  }

  const draft = env.status === 'draft' && !signing
  const signer =
    env.signerList.find((s) => s.email === me?.principal.email.toLowerCase()) ?? env.signerList[0]
  const mine = fields.filter((f) => f.signer === signer?.id)

  const update = (fieldId: string, fn: (f: SignField) => SignField) => {
    setFields((all) => all.map((f) => (f.id === fieldId ? fn(f) : f)))
    setDirty(true)
  }
  const removeField = (fieldId: string) => {
    setFields((all) => all.filter((f) => f.id !== fieldId))
    setSelected(null)
    setDirty(true)
  }

  const save = async (): Promise<EnvelopeView | null> => {
    setBusy(true)
    setError(null)
    try {
      const view = await signApi.saveDraft(space, id, {
        title: title.trim() || env.title,
        fields: fields.map(placement),
        blobOid: env.blobOid,
      })
      adopt(view)
      return view
    } catch (e) {
      setError(message(e, 'Couldn’t save'))
      return null
    } finally {
      setBusy(false)
    }
  }

  const startSigning = async () => {
    const view = dirty ? await save() : env
    if (!view) return
    if (!view.fields.some((f) => f.signer === signer?.id && f.type === 'signature')) {
      setError('Add a signature field first: pick Signature, then click where it goes')
      return
    }
    setSelected(null)
    setPlacing(null)
    setSigning(true)
  }

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      const view = await signApi.sign(space, id, {
        values: Object.values(values),
        consent,
        blobOid: env.blobOid,
      })
      adopt(view)
      setSigning(false)
      setPdf(null)
      notify('Signed. The sealed PDF is in Files')
    } catch (e) {
      setError(message(e, 'Couldn’t sign'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await signApi.remove(space, id)
      navigate('/sign')
    } catch (e) {
      setError(message(e, 'Couldn’t delete'))
      setBusy(false)
    }
  }

  const missing = mine.filter((f) => {
    const v = values[f.id]
    if (f.type === 'signature' || f.type === 'initials') return !v?.value && !v?.image
    if (f.type === 'text') return f.required && !v?.value?.trim()
    return false
  })

  const overlay = (page: number) =>
    fields
      .filter((f) => f.page === page)
      .map((f) => (
        <FieldBox
          key={f.id}
          field={f}
          editable={draft}
          selected={selected === f.id}
          signable={signing && f.signer === signer?.id}
          value={values[f.id]}
          onSelect={() => setSelected(f.id)}
          onMove={(dx, dy) => update(f.id, (x) => moveField(x, dx, dy))}
          onResize={(dw, dh) => update(f.id, (x) => resizeField(x, dw, dh))}
          onRemove={() => removeField(f.id)}
          onFill={() => {
            if (f.type === 'checkbox') {
              setValues((v) => ({ ...v, [f.id]: { field: f.id, checked: !v[f.id]?.checked } }))
            } else if (f.type === 'signature' || f.type === 'initials') {
              setPadFor(f)
            }
          }}
          onText={(text) => setValues((v) => ({ ...v, [f.id]: { field: f.id, value: text } }))}
        />
      ))

  return (
    <>
      <PageHeader title={env.title} menu={false} back={{ to: '/sign', label: 'Sign' }}>
        {draft ? (
          <>
            <button
              type="button"
              className={`${secondaryButton} h-9`}
              disabled={busy || !dirty}
              onClick={() => void save()}
              data-testid="sign-save"
            >
              {dirty ? 'Save' : 'Saved'}
            </button>
            <button
              type="button"
              className={`${primaryButton} h-9`}
              disabled={busy}
              onClick={() => void startSigning()}
              data-testid="sign-start"
            >
              <Icon name="sign" />
              Sign it
            </button>
          </>
        ) : null}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper-sunk/60">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4">
          {error ? (
            <p role="alert" className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}

          {env.status === 'completed' ? (
            <Finished env={env} />
          ) : (
            <>
              {draft ? (
                <section
                  className="flex flex-col gap-3 rounded-xl bg-paper-raised p-4 ring-1 ring-ash"
                  aria-label="Fields"
                >
                  <label className="flex flex-col gap-1 text-sm text-ink-soft">
                    Name
                    <input
                      className={inputClass}
                      value={title}
                      maxLength={200}
                      onChange={(e) => {
                        setTitle(e.target.value)
                        setDirty(true)
                      }}
                      data-testid="sign-title"
                    />
                  </label>
                  <p className="text-sm text-ink-soft">
                    Pick a field, then click where it goes on the page. Drag a field to move it, or
                    select it and use the arrow keys; Delete removes it.
                  </p>
                  <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Add a field">
                    {FIELD_TYPES.map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={placing === type}
                        className={`rounded-full px-3 py-1.5 text-sm ring-1 ${placing === type ? 'bg-ember text-paper-raised ring-ember' : 'bg-paper ring-ash-strong hover:ring-ember'}`}
                        onClick={() => setPlacing(placing === type ? null : type)}
                        data-testid={`sign-add-${type}`}
                      >
                        {FIELD_LABEL[type]}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-xs text-ink-faint">
                    <span>
                      From {env.sourceName} · {env.source.pages.length}{' '}
                      {env.source.pages.length === 1 ? 'page' : 'pages'}
                    </span>
                    <button
                      type="button"
                      className="text-ink-soft underline"
                      onClick={() => setConfirmDelete(true)}
                      data-testid="sign-delete"
                    >
                      Delete envelope
                    </button>
                  </div>
                </section>
              ) : null}

              {signing ? (
                <section
                  className="sticky top-0 z-10 flex flex-col gap-3 rounded-xl bg-paper-raised p-4 shadow-sm ring-1 ring-ash"
                  aria-label="Signing"
                  data-testid="sign-panel"
                >
                  <p className="text-sm text-ink">
                    Click each highlighted field to fill it in.{' '}
                    {missing.length > 0
                      ? `${missing.length} left.`
                      : 'All done: agree below and finish.'}
                  </p>
                  <label className="flex items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      data-testid="sign-consent"
                    />
                    <span>
                      I agree to sign this document electronically, and that my electronic signature
                      counts the same as one on paper.
                    </span>
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setSigning(false)}
                      disabled={busy}
                    >
                      Back to fields
                    </button>
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={busy || !consent || missing.length > 0}
                      onClick={() => void finish()}
                      data-testid="sign-finish"
                    >
                      {busy ? 'Sealing…' : 'Finish signing'}
                    </button>
                  </div>
                </section>
              ) : null}

              {pdf ? (
                <div
                  role="application"
                  aria-label="The PDF's pages. Tab to a field; arrow keys move it and Delete removes it."
                  className={placing ? 'cursor-crosshair' : ''}
                  onKeyDown={(e) => {
                    if (!draft || !selected) return
                    const step = e.shiftKey ? 0.02 : 0.005
                    const moves: Record<string, [number, number]> = {
                      ArrowLeft: [-step, 0],
                      ArrowRight: [step, 0],
                      ArrowUp: [0, -step],
                      ArrowDown: [0, step],
                    }
                    const m = moves[e.key]
                    if (m) {
                      e.preventDefault()
                      update(selected, (f) => moveField(f, m[0], m[1]))
                    } else if (e.key === 'Delete' || e.key === 'Backspace') {
                      e.preventDefault()
                      removeField(selected)
                    }
                  }}
                >
                  <PdfPages
                    data={pdf}
                    pages={env.source.pages}
                    overlay={overlay}
                    onPageClick={(page, at) => {
                      setSelected(null)
                      if (!draft || !placing || !signer) return
                      const size = env.source.pages[page - 1] ?? { width: 612, height: 792 }
                      const f = newField(placing, signer.id, page, at, size, fields)
                      setFields((all) => [...all, f])
                      setSelected(f.id)
                      setPlacing(null)
                      setDirty(true)
                    }}
                  />
                </div>
              ) : (
                <p className="text-sm text-ink-soft">Opening the PDF…</p>
              )}
            </>
          )}
        </div>
      </div>

      {padFor && signer ? (
        <SignatureDialog
          kind={padFor.type === 'initials' ? 'initials' : 'signature'}
          name={signer.name}
          onClose={() => setPadFor(null)}
          onDone={(s: Signature) => {
            setValues((v) => ({ ...v, [padFor.id]: { field: padFor.id, ...s } }))
            setPadFor(null)
          }}
        />
      ) : null}

      {confirmDelete ? (
        <Dialog title="Delete this envelope?" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-ink-soft">
            It moves to the trash. The PDF it was made from stays in Files.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => void remove()}
              data-testid="sign-delete-confirm"
            >
              Delete
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}

/** One field on a page: a box to drag in a draft, or something to fill in while signing. */
function FieldBox({
  field,
  editable,
  selected,
  signable,
  value,
  onSelect,
  onMove,
  onResize,
  onRemove,
  onFill,
  onText,
}: {
  field: SignField
  editable: boolean
  selected: boolean
  signable: boolean
  value: FilledValue | undefined
  onSelect: () => void
  onMove: (dx: number, dy: number) => void
  onResize: (dw: number, dh: number) => void
  onRemove: () => void
  onFill: () => void
  onText: (text: string) => void
}) {
  const style = {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.width * 100}%`,
    height: `${field.height * 100}%`,
  }
  const drag = (kind: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
    if (!editable) return
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    const page = (
      e.currentTarget.closest('[data-testid^="sign-page-"]') as HTMLElement | null
    )?.getBoundingClientRect()
    if (!page) return
    let last = { x: e.clientX, y: e.clientY }
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - last.x) / page.width
      const dy = (ev.clientY - last.y) / page.height
      last = { x: ev.clientX, y: ev.clientY }
      if (kind === 'move') onMove(dx, dy)
      else onResize(dx, dy)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (signable) {
    if (field.type === 'text') {
      return (
        <input
          className="absolute rounded-sm bg-ember-wash/70 px-1 text-[clamp(8px,1.4vw,14px)] text-ink outline-none ring-2 ring-ember focus:bg-white"
          style={style}
          value={value?.value ?? ''}
          maxLength={5000}
          placeholder="Type here"
          aria-label="Text field"
          onChange={(e) => onText(e.target.value)}
          data-testid={`sign-field-${field.id}`}
        />
      )
    }
    if (field.type === 'date') {
      return (
        <span
          className="absolute flex items-center rounded-sm bg-paper-sunk/80 px-1 text-[clamp(8px,1.4vw,14px)] text-ink-soft ring-1 ring-ash-strong"
          style={style}
          data-testid={`sign-field-${field.id}`}
        >
          {new Date().toISOString().slice(0, 10)}
        </span>
      )
    }
    const filled =
      field.type === 'checkbox' ? value?.checked : Boolean(value?.value || value?.image)
    return (
      <button
        type="button"
        className={`absolute flex items-center justify-center overflow-hidden rounded-sm text-[clamp(8px,1.4vw,14px)] ring-2 ${filled ? 'bg-white/80 ring-ash-strong' : 'animate-pulse bg-ember-wash/80 ring-ember'}`}
        style={style}
        onClick={onFill}
        aria-label={`${FIELD_LABEL[field.type]}${filled ? ', filled' : ''}`}
        data-testid={`sign-field-${field.id}`}
      >
        {field.type === 'checkbox' ? (
          value?.checked ? (
            <Icon name="check" className="size-full" />
          ) : null
        ) : value?.image ? (
          <img src={value.image} alt="" className="size-full object-contain" />
        ) : value?.value ? (
          <span className="sign-script truncate text-ink">{value.value}</span>
        ) : (
          <span className="font-medium text-ink">{FIELD_LABEL[field.type]}</span>
        )}
      </button>
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragged with a pointer; the page's arrow keys move it too
    <div
      className={`absolute flex select-none items-center justify-center rounded-sm border text-[clamp(7px,1.2vw,12px)] ${editable ? 'cursor-move touch-none' : ''} ${selected ? 'border-ember bg-ember-wash/80 text-ink' : 'border-ember/60 bg-ember-wash/50 text-ink-soft'}`}
      style={style}
      onPointerDown={drag('move')}
      data-testid={`sign-field-${field.id}`}
      data-field-type={field.type}
    >
      {editable ? (
        <button
          type="button"
          className="size-full cursor-move truncate px-1 outline-none focus-visible:ring-2 focus-visible:ring-ember"
          onFocus={onSelect}
          aria-label={`${FIELD_LABEL[field.type]} field on page ${field.page}`}
        >
          {FIELD_LABEL[field.type]}
        </button>
      ) : (
        <span className="truncate px-1">{FIELD_LABEL[field.type]}</span>
      )}
      {editable && selected ? (
        <>
          <button
            type="button"
            className="absolute -top-3 -right-3 flex size-6 items-center justify-center rounded-full bg-ink text-paper-raised"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onRemove}
            aria-label={`Remove ${FIELD_LABEL[field.type]}`}
            data-testid="sign-field-remove"
          >
            <Icon name="close" className="size-3" />
          </button>
          <span
            className="absolute right-0 bottom-0 size-3 cursor-se-resize bg-ember"
            onPointerDown={drag('resize')}
            aria-hidden="true"
          />
        </>
      ) : null}
    </div>
  )
}

/** A completed envelope: where its sealed PDF and certificate are, and the audit trail. */
function Finished({ env }: { env: EnvelopeView }) {
  const files = env.result
  return (
    <section
      className="flex flex-col gap-4 rounded-xl bg-paper-raised p-5 ring-1 ring-ash"
      data-testid="sign-finished"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-paper-sunk px-2 py-0.5 text-xs text-ink-soft">
          {STATUS_LABEL[env.status]}
        </span>
        <span className="text-sm text-ink-soft">{when(env.completed)}</span>
      </div>
      <p className="text-sm text-ink">
        The signed PDF is sealed, so any later change to it shows in a PDF reader. It and its audit
        certificate are in Files, next to {env.sourceName}.
      </p>
      {files ? (
        <div className="flex flex-wrap gap-2">
          <Link
            className={primaryButton}
            to={`/files/${encodeURIComponent(files.space)}/${files.signedFile}`}
            data-testid="sign-open-signed"
          >
            <Icon name="file" />
            Open the signed PDF
          </Link>
          <Link
            className={secondaryButton}
            to={`/files/${encodeURIComponent(files.space)}/${files.certificateFile}`}
            data-testid="sign-open-certificate"
          >
            Open the certificate
          </Link>
        </div>
      ) : null}
      <div>
        <h2 className="mb-2 text-sm font-medium text-ink">Signers</h2>
        <ul className="text-sm text-ink-soft">
          {env.signerList.map((s) => (
            <li key={s.id}>
              {s.name} ({s.email}):{' '}
              {s.status === 'signed' ? `signed ${when(s.signed_at ?? null)}` : s.status}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium text-ink">Audit trail</h2>
        <ol className="flex flex-col gap-1 text-sm text-ink-soft" data-testid="sign-audit">
          {env.audit.map((a) => (
            <li key={a.id}>
              {when(a.at)}: {EVENT_LABEL[a.event] ?? a.event}
              {a.email ? ` by ${a.email}` : ''}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-ink-faint" data-testid="sign-audit-check">
          {env.auditIntact
            ? 'Each event is chained to the one before it, and the chain checks out.'
            : 'The audit trail’s chain doesn’t check out: someone edited this envelope’s file by hand.'}
        </p>
      </div>
    </section>
  )
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Made',
  sent: 'Sent',
  viewed: 'Opened',
  consented: 'Agreed to sign electronically',
  signed: 'Signed',
  completed: 'Completed and sealed',
}
