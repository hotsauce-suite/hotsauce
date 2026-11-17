import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  type DraftPerson,
  type EnvelopeView,
  type FilledValue,
  type SignerView,
  type SignField,
  type SignFieldType,
  type SigningLink,
  type SigningOrder,
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
import { FieldBox, focusField, localDay } from './FieldBox'
import { FIELD_LABEL, FIELD_TYPES, moveField, newField, placement, resizeField } from './fields'
import { PdfPages } from './PdfPages'
import { keptFields, moveUp, nextPersonId, ordered, peopleProblem, shortName } from './people'
import { type Signature, SignatureDialog } from './SignaturePad'
import { missingFields, SigningPanel } from './SigningPanel'
import { STATUS_LABEL, when } from './SignPage'

/** A select sized to its options (the input class stretches to the full width). */
const selectClass = `${inputClass.replace('w-full', '')} h-9 w-auto`
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const draftPerson = ({ id, name, email, order, role }: SignerView): DraftPerson => ({
  id,
  name,
  email,
  order,
  role,
})

/**
 * `/sign/:space/:id`: name who signs and place their fields on a draft, send it or sign it, follow
 * who has signed, or see a finished envelope (docs/PLAN-sign.md R9–R13).
 */
export default function EnvelopePage() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { me, notify } = useSession()
  const [env, setEnv] = useState<EnvelopeView | null>(null)
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fields, setFields] = useState<SignField[]>([])
  const [people, setPeople] = useState<DraftPerson[]>([])
  const [order, setOrder] = useState<SigningOrder>('parallel')
  const [forSigner, setForSigner] = useState<string | null>(null)
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
  const [confirmSend, setConfirmSend] = useState(false)
  const [links, setLinks] = useState<SigningLink[] | null>(null)
  const [replace, setReplace] = useState<{ signer: SignerView; email: boolean } | null>(null)
  const [fix, setFix] = useState<{ signer: SignerView; name: string; email: string } | null>(null)

  const adopt = useCallback((view: EnvelopeView) => {
    setEnv(view)
    setFields(view.fields)
    setTitle(view.title)
    setPeople(view.signerList.map(draftPerson))
    setOrder(view.signingOrder)
    setForSigner((prev) => {
      const signing = view.signerList.filter((s) => s.role !== 'copy')
      return signing.some((s) => s.id === prev) ? prev : (signing[0]?.id ?? null)
    })
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

  const myEmail = me?.principal.email.toLowerCase()
  const meSigner = env.signerList.find((s) => s.email === myEmail && s.role !== 'copy')
  // Anyone who can open a draft can set it up; once sent, only its signers sign, in the app.
  const draft = env.status === 'draft' && !signing
  const signingPeople = people.filter((p) => p.role !== 'copy')
  // A draft only the member signs is signed straight away; anyone else on it needs it sent.
  const onlyMe = signingPeople.length === 1 && signingPeople[0]?.email.toLowerCase() === myEmail
  const named = (signerId: string) =>
    signingPeople.length > 1
      ? shortName(people.find((p) => p.id === signerId)?.name ?? '')
      : undefined
  const mine = fields.filter((f) => f.signer === meSigner?.id)
  const missing = missingFields(mine, values)

  const update = (fieldId: string, fn: (f: SignField) => SignField) => {
    setFields((all) => all.map((f) => (f.id === fieldId ? fn(f) : f)))
    setDirty(true)
  }
  const place = (type: SignFieldType, page: number, at: { x: number; y: number }) => {
    if (!forSigner) {
      setError('Add someone to sign first')
      return
    }
    const size = env.source.pages[page - 1] ?? { width: 612, height: 792 }
    const f = newField(type, forSigner, page, at, size, fields)
    setFields((all) => [...all, f])
    setSelected(f.id)
    setPlacing(null)
    setDirty(true)
    focusField(f.id)
  }
  const removeField = (fieldId: string) => {
    setFields((all) => all.filter((f) => f.id !== fieldId))
    setSelected(null)
    setDirty(true)
  }
  const changePeople = (next: DraftPerson[]) => {
    setPeople(next)
    setFields((all) => keptFields(all, next))
    const signing = next.filter((p) => p.role !== 'copy')
    if (!signing.some((p) => p.id === forSigner)) setForSigner(signing[0]?.id ?? null)
    setDirty(true)
  }

  const save = async (): Promise<EnvelopeView | null> => {
    const problem = peopleProblem(people)
    if (problem) {
      setError(problem)
      return null
    }
    setBusy(true)
    setError(null)
    try {
      const view = await signApi.saveDraft(space, id, {
        title: title.trim() || env.title,
        fields: fields.map(placement),
        signers: ordered(people),
        signingOrder: order,
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

  /** Checks a saved draft is ready to go out: everyone who signs has a signature field. */
  const ready = (view: EnvelopeView): boolean => {
    for (const p of view.signerList.filter((s) => s.role !== 'copy')) {
      if (!view.fields.some((f) => f.signer === p.id && f.type === 'signature')) {
        setForSigner(p.id)
        setError(`Add a signature field for ${p.name}: pick Signature, then click where it goes`)
        return false
      }
    }
    return true
  }

  const startSigning = async () => {
    const view = dirty ? await save() : env
    if (!view || (view.status === 'draft' && !ready(view))) return
    setSelected(null)
    setPlacing(null)
    setSigning(true)
  }

  const askSend = async () => {
    const view = dirty ? await save() : env
    if (view && ready(view)) setConfirmSend(true)
  }

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await signApi.send(space, id, env.blobOid)
      const { links: made, ...view } = out
      adopt(view)
      setConfirmSend(false)
      if (made.length > 0) setLinks(made)
      else notify('Sent')
    } catch (e) {
      setError(message(e, 'Couldn’t send'))
      setConfirmSend(false)
    } finally {
      setBusy(false)
    }
  }

  const newLink = async (signer: SignerView, email: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const made = await signApi.link(space, id, signer.id, email)
      setLinks([made])
      // The page's list shows the new link's state.
      adopt(await signApi.get(space, id))
    } catch (e) {
      setError(message(e, 'Couldn’t make a new link'))
    } finally {
      setBusy(false)
    }
  }

  const correct = async () => {
    if (!fix) return
    setBusy(true)
    setError(null)
    try {
      const { link, ...view } = await signApi.correct(space, id, fix.signer.id, {
        name: fix.name,
        email: fix.email,
      })
      adopt(view)
      setFix(null)
      if (link && !link.emailed) setLinks([link])
      else notify(link ? `New link emailed to ${link.email}` : 'Saved')
    } catch (e) {
      setError(message(e, 'Couldn’t change that'))
      setFix(null)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await signApi.copy(space, id)
      notify('Copied to a new draft')
      navigate(`/sign/${encodeURIComponent(made.space)}/${made.id}`)
    } catch (e) {
      setError(message(e, 'Couldn’t copy this envelope'))
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      // A date field shows the signer's own day; the server keeps it within a day of its own.
      const dates = mine
        .filter((f) => f.type === 'date')
        .map((f) => ({ field: f.id, value: localDay() }))
      const view = await signApi.sign(space, id, {
        values: [...Object.values(values), ...dates],
        consent,
        blobOid: env.blobOid,
      })
      adopt(view)
      setSigning(false)
      if (view.status === 'completed') {
        setPdf(null)
        notify('Signed. The sealed PDF is in Files')
      } else {
        notify('Signed. Everyone gets the sealed PDF when the last person signs')
      }
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

  const overlay = (page: number) =>
    fields
      .filter((f) => f.page === page)
      .map((f) => (
        <FieldBox
          key={f.id}
          field={f}
          owner={named(f.signer)}
          editable={draft}
          selected={selected === f.id}
          signable={signing && f.signer === meSigner?.id}
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
            {onlyMe ? (
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
            ) : (
              <button
                type="button"
                className={`${primaryButton} h-9`}
                disabled={busy}
                onClick={() => void askSend()}
                data-testid="sign-send"
              >
                <Icon name="share" />
                Send
              </button>
            )}
          </>
        ) : env.status === 'sent' && env.canSign && !signing ? (
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
        ) : null}
        {env.status !== 'draft' && !signing ? (
          <button
            type="button"
            className={`${secondaryButton} h-9`}
            disabled={busy}
            onClick={() => void copy()}
            data-testid="sign-copy"
          >
            Copy to a new draft
          </button>
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
                <People
                  people={people}
                  order={order}
                  myEmail={myEmail}
                  myName={me?.principal.name ?? ''}
                  onChange={changePeople}
                  onOrder={(o) => {
                    setOrder(o)
                    setDirty(true)
                  }}
                />
              ) : !signing ? (
                <Progress
                  env={env}
                  myEmail={myEmail}
                  busy={busy}
                  onLink={(signer, email) => setReplace({ signer, email })}
                  onFix={(signer) => setFix({ signer, name: signer.name, email: signer.email })}
                />
              ) : null}

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
                    use the arrow keys; Alt and the arrow keys resize it, and Delete removes it.
                  </p>
                  {signingPeople.length > 1 ? (
                    <label className="flex items-center gap-2 text-sm text-ink-soft">
                      Fields for
                      <select
                        className={selectClass}
                        value={forSigner ?? ''}
                        onChange={(e) => setForSigner(e.target.value)}
                        data-testid="sign-fields-for"
                      >
                        {signingPeople.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.email || 'New person'}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Add a field">
                    {FIELD_TYPES.map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={placing === type}
                        className={`rounded-full px-3 py-1.5 text-sm ring-1 ${placing === type ? 'bg-ember text-paper-raised ring-ember' : 'bg-paper ring-ash-strong hover:ring-ember'}`}
                        onClick={(e) => {
                          // From the keyboard (no pointer position), the field goes in the
                          // middle of the first page, focused, ready for the arrow keys.
                          if (e.detail === 0) {
                            place(type, 1, { x: 0.5, y: 0.5 })
                            return
                          }
                          setPlacing(placing === type ? null : type)
                        }}
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
                    onClick={() => setSigning(false)}
                    disabled={busy}
                  >
                    {env.status === 'draft' ? 'Back to fields' : 'Not now'}
                  </button>
                </SigningPanel>
              ) : null}

              {env.status === 'declined' ? null : pdf ? (
                <div
                  role="application"
                  aria-label="The PDF's pages. Tab to a field; arrow keys move it, Alt with the arrow keys resizes it, and Delete removes it."
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
                    if (m && e.altKey) {
                      e.preventDefault()
                      update(selected, (f) => resizeField(f, m[0], m[1]))
                    } else if (m) {
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
                      if (!draft || !placing) return
                      place(placing, page, at)
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

      {padFor && meSigner ? (
        <SignatureDialog
          kind={padFor.type === 'initials' ? 'initials' : 'signature'}
          name={meSigner.name}
          onClose={() => setPadFor(null)}
          onDone={(s: Signature) => {
            setValues((v) => ({ ...v, [padFor.id]: { field: padFor.id, ...s } }))
            setPadFor(null)
          }}
        />
      ) : null}

      {confirmSend ? (
        <Dialog title="Send for signature?" onClose={() => setConfirmSend(false)}>
          <SendSummary env={env} myEmail={myEmail} />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setConfirmSend(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => void send()}
              data-testid="sign-send-confirm"
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </Dialog>
      ) : null}

      {replace ? (
        <Dialog
          title={replace.email ? 'Email a new link?' : 'Make a new link?'}
          onClose={() => setReplace(null)}
        >
          <p className="text-sm text-ink-soft">
            {replace.signer.name}’s current link stops working, and the new one works for 30 days.
            {replace.email
              ? ` It’s emailed to ${replace.signer.email}.`
              : ' You copy it and send it.'}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setReplace(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => {
                const r = replace
                setReplace(null)
                void newLink(r.signer, r.email)
              }}
              data-testid="sign-new-link-confirm"
            >
              {replace.email ? 'Email it' : 'Make a new link'}
            </button>
          </div>
        </Dialog>
      ) : null}

      {fix ? (
        <Dialog title={`Change ${fix.signer.name}`} onClose={() => setFix(null)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void correct()
            }}
          >
            <p className="text-sm text-ink-soft">
              Fix a misspelled name or a wrong address.
              {fix.signer.role === 'copy'
                ? ' They get the finished copy at the new address.'
                : ` Their current link stops working${
                    env.upNext.includes(fix.signer.id)
                      ? env.canEmail
                        ? ', and a new one is emailed to the address below.'
                        : ', and you get a new one to copy and send.'
                      : '; they get a new one when it’s their turn.'
                  }`}{' '}
              The change is kept in the audit trail.
            </p>
            <label className="flex flex-col gap-1 text-sm text-ink-soft">
              Name
              <input
                className={inputClass}
                value={fix.name}
                maxLength={120}
                onChange={(e) => setFix({ ...fix, name: e.target.value })}
                data-testid="sign-fix-name"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-soft">
              Email
              <input
                className={inputClass}
                type="email"
                value={fix.email}
                maxLength={320}
                onChange={(e) => setFix({ ...fix, email: e.target.value })}
                data-testid="sign-fix-email"
              />
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={() => setFix(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className={primaryButton}
                disabled={busy || !fix.name.trim() || !fix.email.trim()}
                data-testid="sign-fix-confirm"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {links ? <LinksDialog links={links} onClose={() => setLinks(null)} /> : null}

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

/** Who is on a draft: who signs, who gets a copy, and whether they sign in order. */
function People({
  people,
  order,
  myEmail,
  myName,
  onChange,
  onOrder,
}: {
  people: DraftPerson[]
  order: SigningOrder
  myEmail: string | undefined
  myName: string
  onChange: (people: DraftPerson[]) => void
  onOrder: (order: SigningOrder) => void
}) {
  const set = (i: number, patch: Partial<DraftPerson>) =>
    onChange(people.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const add = (name = '', email = '') =>
    onChange([
      ...people,
      { id: nextPersonId(people), name, email, order: people.length + 1, role: 'signer' },
    ])
  const signers = people.filter((p) => p.role !== 'copy').length
  const hasMe = people.some((p) => p.email.trim().toLowerCase() === myEmail)
  return (
    <section
      className="flex flex-col gap-3 rounded-xl bg-paper-raised p-4 ring-1 ring-ash"
      aria-label="People"
      data-testid="sign-people"
    >
      <div>
        <h2 className="text-sm font-medium text-ink">Who signs</h2>
        <p className="text-sm text-ink-soft">
          Each person who signs gets their own link and doesn’t need an account; you sign here.
          Someone who only gets a copy is emailed the signed PDF at the end.
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {people.map((p, i) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-2"
            data-testid={`sign-person-${i + 1}`}
          >
            {order === 'sequential' ? (
              <span className="w-5 text-right text-sm text-ink-faint">{i + 1}.</span>
            ) : null}
            <input
              className={`${inputClass} h-9 min-w-0 flex-1 basis-40`}
              placeholder="Name"
              aria-label="Name"
              value={p.name}
              maxLength={120}
              onChange={(e) => set(i, { name: e.target.value })}
              data-testid="sign-person-name"
            />
            <input
              className={`${inputClass} h-9 min-w-0 flex-[1.4] basis-56`}
              placeholder="Email"
              aria-label="Email"
              type="email"
              value={p.email}
              maxLength={320}
              onChange={(e) => set(i, { email: e.target.value })}
              data-testid="sign-person-email"
            />
            <select
              className={selectClass}
              aria-label="Signs or gets a copy"
              value={p.role}
              onChange={(e) => set(i, { role: e.target.value === 'copy' ? 'copy' : 'signer' })}
              data-testid="sign-person-role"
            >
              <option value="signer">Signs</option>
              <option value="copy">Gets a copy</option>
            </select>
            {order === 'sequential' && i > 0 ? (
              <button
                type="button"
                className="rounded-full px-2 py-1 text-xs text-ink-soft ring-1 ring-ash-strong hover:ring-ember"
                aria-label={`Move ${p.name || 'this person'} up`}
                onClick={() => onChange(moveUp(people, i))}
              >
                Move up
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-full p-1.5 text-ink-soft hover:bg-paper-sunk"
              aria-label={`Remove ${p.name || 'this person'}`}
              onClick={() => onChange(people.filter((_, j) => j !== i))}
              data-testid="sign-person-remove"
            >
              <Icon name="close" className="size-4" />
            </button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={secondaryButton}
          disabled={people.length >= 10}
          onClick={() => add()}
          data-testid="sign-person-add"
        >
          <Icon name="plus" />
          Add a person
        </button>
        {!hasMe && myEmail ? (
          <button
            type="button"
            className={secondaryButton}
            disabled={people.length >= 10}
            onClick={() => add(myName, myEmail)}
          >
            Add me
          </button>
        ) : null}
        {signers > 1 ? (
          <label className="ml-auto flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={order === 'sequential'}
              onChange={(e) => onOrder(e.target.checked ? 'sequential' : 'parallel')}
              data-testid="sign-order"
            />
            Sign one after another, in this order
          </label>
        ) : null}
      </div>
    </section>
  )
}

/** Before sending: who gets a link now, and how. */
function SendSummary({ env, myEmail }: { env: EnvelopeView; myEmail: string | undefined }) {
  const signers = env.signerList.filter((s) => s.role !== 'copy')
  const others = signers.filter((s) => s.email !== myEmail)
  const first =
    env.signingOrder === 'sequential' ? others.filter((s) => s.order === signers[0]?.order) : others
  const copies = env.signerList.filter((s) => s.role === 'copy')
  return (
    <div className="flex flex-col gap-2 text-sm text-ink-soft">
      {first.length > 0 ? (
        <p>
          {env.canEmail ? 'We’ll email' : 'You’ll get'} a signing link for{' '}
          {first.map((s) => s.name).join(', ')}
          {env.canEmail ? '.' : ' to send yourself: email isn’t set up on this server.'}
        </p>
      ) : null}
      {env.signingOrder === 'sequential' && signers.length > 1 ? (
        <p>They sign one after another; each person gets their link when the one before signs.</p>
      ) : null}
      {signers.some((s) => s.email === myEmail) ? (
        <p>You sign here in {product()}, when it’s your turn.</p>
      ) : null}
      {copies.length > 0 ? (
        <p>{copies.map((s) => s.name).join(', ')} will get the signed PDF at the end.</p>
      ) : null}
      <p>Once it’s sent, the document and its fields can’t change.</p>
    </div>
  )
}

/** The signing links just made, to copy and send by hand when they weren't emailed. */
function LinksDialog({ links, onClose }: { links: SigningLink[]; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)
  const emailed = links.every((l) => l.emailed)
  return (
    <Dialog title={emailed ? 'Sent' : 'Send these links'} onClose={onClose}>
      <p className="text-sm text-ink-soft">
        {emailed
          ? 'Each person was emailed their own link. You can copy a link too; it’s only for them.'
          : 'Send each person their own link, by email or a message. A link is only for that person, works for 30 days, and you won’t see it again here.'}
      </p>
      <ul className="mt-3 flex flex-col gap-3" data-testid="sign-links">
        {links.map((l) => (
          <li key={l.signer} className="flex flex-col gap-1">
            <span className="text-sm text-ink">
              {l.name} ({l.email}){l.emailed ? ' · emailed' : ''}
            </span>
            <div className="flex gap-2">
              <input
                className={`${inputClass} h-9 font-mono text-xs`}
                readOnly
                value={l.url}
                aria-label={`Signing link for ${l.name}`}
                onFocus={(e) => e.target.select()}
                data-testid="sign-link-url"
              />
              <button
                type="button"
                className={`${secondaryButton} h-9 shrink-0`}
                onClick={() => {
                  void navigator.clipboard?.writeText(l.url).then(
                    () => setCopied(l.signer),
                    () => {},
                  )
                }}
                data-testid="sign-link-copy"
              >
                {copied === l.signer ? 'Copied' : 'Copy'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <button type="button" className={primaryButton} onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  )
}

/** Where a sent or declined envelope stands, person by person, with new links for the sender. */
function Progress({
  env,
  myEmail,
  busy,
  onLink,
  onFix,
}: {
  env: EnvelopeView
  myEmail: string | undefined
  busy: boolean
  onLink: (signer: SignerView, email: boolean) => void
  onFix: (signer: SignerView) => void
}) {
  const decliner = env.signerList.find((s) => s.status === 'declined')
  const isSender = env.createdBy.toLowerCase() === myEmail
  return (
    <section
      className="flex flex-col gap-3 rounded-xl bg-paper-raised p-4 ring-1 ring-ash"
      aria-label="Who has signed"
      data-testid="sign-progress"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-paper-sunk px-2 py-0.5 text-xs text-ink-soft">
          {STATUS_LABEL[env.status]}
        </span>
        {env.status === 'sent' ? (
          <span className="text-sm text-ink-soft">
            {env.signingOrder === 'sequential' ? 'One after another' : 'Everyone at once'}
          </span>
        ) : null}
      </div>
      {decliner ? (
        <p className="text-sm text-ink" data-testid="sign-declined">
          {decliner.name} declined {when(decliner.declined_at ?? null)}
          {decliner.decline_reason ? `: “${decliner.decline_reason}”` : ', without a reason'}.
          Nobody else can sign it now.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-ash">
        {env.signerList.map((s) => {
          const turn = env.upNext.includes(s.id)
          const isMe = s.email === myEmail
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
              data-testid={`sign-progress-${s.id}`}
            >
              <span className="min-w-0 flex-1 text-sm text-ink">
                {s.name} <span className="text-ink-faint">{s.email}</span>
              </span>
              <span className="text-xs text-ink-soft" data-testid="sign-progress-state">
                {personState(s, turn, isMe)}
              </span>
              {env.status === 'sent' && isSender && s.status === 'pending' ? (
                <button
                  type="button"
                  className="rounded-full px-2 py-1 text-xs text-ink-soft ring-1 ring-ash-strong hover:ring-ember"
                  disabled={busy}
                  onClick={() => onFix(s)}
                  data-testid="sign-fix"
                >
                  Change
                </button>
              ) : null}
              {env.status === 'sent' && turn && !isMe && isSender ? (
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="rounded-full px-2 py-1 text-xs text-ink-soft ring-1 ring-ash-strong hover:ring-ember"
                    disabled={busy}
                    onClick={() => onLink(s, false)}
                    data-testid="sign-new-link"
                  >
                    New link
                  </button>
                  {env.canEmail ? (
                    <button
                      type="button"
                      className="rounded-full px-2 py-1 text-xs text-ink-soft ring-1 ring-ash-strong hover:ring-ember"
                      disabled={busy}
                      onClick={() => onLink(s, true)}
                      data-testid="sign-email-again"
                    >
                      Email again
                    </button>
                  ) : null}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function personState(s: SignerView, turn: boolean, isMe: boolean): string {
  if (s.role === 'copy') return 'Gets a copy'
  if (s.status === 'signed') return `Signed ${when(s.signed_at ?? null)}`
  if (s.status === 'declined') return 'Declined'
  if (!turn) return 'Waits for their turn'
  if (isMe) return 'Your turn'
  if (!s.sent_at) return 'Signs in the app'
  if (s.viewed_at) return `Opened ${when(s.viewed_at)}`
  if (!s.linkActive) return 'Link expired: make a new one'
  return s.sent_at ? `Link sent ${when(s.sent_at)}` : 'Waiting'
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
  declined: 'Declined',
  completed: 'Completed and sealed',
  signer_corrected: 'Changed someone’s name or email',
  copied: 'Copied from an earlier envelope',
}
