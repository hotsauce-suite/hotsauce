import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type CheckinInput, type CheckinItem, checkinsApi } from '../../api/checkins'
import { hearthSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { CheckinForm } from './CheckinForm'
import { DEFAULTS } from './format'

const BLANK: CheckinInput = {
  title: '',
  days: ['mon'],
  time: '09:00',
  room: null,
  skip: [],
  paused: false,
}

/** `/checkins`: the team's check-ins, and for admins the way to set them up (ARCHITECTURE §24.6). */
export default function CheckinsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<CheckinItem[] | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CheckinInput | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    checkinsApi.list().then(
      (r) => {
        setItems(r.checkins)
        setCanManage(r.canManage)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t load check-ins'),
    )
  }, [])

  useEffect(() => {
    document.title = `Check-ins · ${product()}`
    load()
    const off = hearthSocket.onChanged(load)
    return off
  }, [load])

  const create = async (input: CheckinInput) => {
    setBusy(true)
    setError(null)
    try {
      const made = await checkinsApi.create(input)
      navigate(`/checkins/${made.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t set it up')
      setBusy(false)
    }
  }

  const missingDefaults = DEFAULTS.filter((d) => !(items ?? []).some((i) => i.title === d.title))

  return (
    <>
      <MeetingsPageHeader title="Check-ins" menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            A question the team answers on a schedule, like “What will you get done this week?”.
            Everyone gets a reminder, answers by typing or speaking, and one summary goes to the
            team’s chat room.
          </p>
          {error ? (
            <p role="alert" className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {canManage ? (
            <div className="mb-6 flex flex-wrap gap-2" data-testid="checkin-presets">
              {missingDefaults.map((d) => (
                <button
                  key={d.title}
                  type="button"
                  className={secondaryButton}
                  data-testid="checkin-preset"
                  onClick={() => setDraft({ ...BLANK, ...d })}
                >
                  <Icon name="plus" />
                  {d.title}
                </button>
              ))}
              <button
                type="button"
                className={primaryButton}
                data-testid="new-checkin"
                onClick={() => setDraft(BLANK)}
              >
                <Icon name="plus" />
                New check-in
              </button>
            </div>
          ) : null}
          {items && items.length === 0 ? (
            <p className="text-sm text-ink-faint" data-testid="checkins-empty">
              {canManage
                ? 'No check-ins yet. Start with one of the two above.'
                : 'No check-ins yet. An admin sets them up.'}
            </p>
          ) : null}
          <ul className="divide-y divide-ash/70" data-testid="checkins-list">
            {(items ?? []).map((c) => (
              <li key={c.id}>
                <Link
                  to={`/checkins/${c.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-3 hover:bg-paper-sunk"
                >
                  <Icon name="checklist" className="size-4 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{c.title}</span>
                  <span className="flex items-center gap-2 text-xs text-ink-faint">
                    <span>{c.schedule}</span>
                    {c.paused ? (
                      <span className="rounded-full bg-paper-sunk px-2 py-0.5">Paused</span>
                    ) : c.current && !c.current.answered ? (
                      <span className="rounded-full bg-ember-wash px-2 py-0.5 text-ink">
                        Answer now
                      </span>
                    ) : c.current ? (
                      <span className="rounded-full bg-paper-sunk px-2 py-0.5">Answered</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {draft ? (
        <Dialog title="New check-in" onClose={() => setDraft(null)} testId="checkin-dialog" wide>
          <CheckinForm
            initial={draft}
            submitLabel="Start asking"
            busy={busy}
            onSubmit={(input) => void create(input)}
            onCancel={() => setDraft(null)}
          />
        </Dialog>
      ) : null}
    </>
  )
}
