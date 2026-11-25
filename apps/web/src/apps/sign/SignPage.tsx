import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type EnvelopeStatus, type EnvelopeSummary, signApi } from '../../api/sign'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { ListBar, ListColumn, ListPanel, matchesName } from '../../components/ListBar'
import { LoadError } from '../../components/LoadError'
import { PageHeader } from '../../components/PageHeader'
import { useLoad } from '../../hooks/useLoad'
import { secondaryButton } from '../meetings/components/common'
import { SavedSignatureCard } from './SavedSignatureCard'

export const STATUS_LABEL: Record<EnvelopeStatus, string> = {
  draft: 'Draft',
  sent: 'Waiting for signatures',
  completed: 'Signed',
  declined: 'Declined',
  voided: 'Cancelled',
}

export const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''

type Tab = 'all' | 'open' | 'signed'

/** `/sign`: every envelope the member can open, newest first (docs/PLAN-sign.md R9). */
export default function SignPage() {
  const list = useLoad(() => signApi.list().then((r) => r.envelopes))
  const envelopes: EnvelopeSummary[] | null = list.data
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const shown = envelopes?.filter(
    (e) =>
      (matchesName(e.title, q) || matchesName(e.sourceName, q)) &&
      (tab === 'all' ||
        (tab === 'signed'
          ? e.status === 'completed'
          : e.status === 'draft' || e.status === 'sent')),
  )

  useEffect(() => {
    document.title = `Sign · ${product()}`
  }, [])

  return (
    <>
      <PageHeader title="Sign" menu={false}>
        <Link to="/files" className={`${secondaryButton} h-9`} data-testid="sign-pick-pdf">
          <Icon name="drive" />
          Pick a PDF in Files
        </Link>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ListColumn width="reading">
          <SavedSignatureCard />
          <ListBar
            tabs={[
              { id: 'all', label: 'All' },
              { id: 'open', label: 'To sign' },
              { id: 'signed', label: 'Signed' },
            ]}
            tab={tab}
            onTab={(t) => setTab(t as Tab)}
            tabsLabel="Which envelopes"
            search={{ value: q, onChange: setQ, label: 'Search envelopes', testId: 'sign-search' }}
          />
          <ListPanel tab={tab}>
            {list.failed ? (
              <LoadError things="envelopes" onRetry={list.reload} className="mb-4" />
            ) : null}
            {!list.failed && envelopes && envelopes.length === 0 ? (
              <EmptyState icon="sign" title="Nothing sent for signature yet" testId="sign-empty">
                Open a PDF in Files and choose Send for signature. You place the fields and sign;
                the sealed copy and its audit certificate are saved in Files next to the original.
              </EmptyState>
            ) : null}
            {!list.failed && envelopes && envelopes.length > 0 && shown?.length === 0 ? (
              <EmptyState icon="sign" title="None match that" testId="sign-no-match">
                Search looks at envelope and PDF names.
              </EmptyState>
            ) : null}
            <ul className="divide-y divide-ash/70" data-testid="sign-list">
              {(shown ?? []).map((e) => (
                <li key={`${e.space}/${e.id}`}>
                  <Link
                    to={`/sign/${encodeURIComponent(e.space)}/${e.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-3 hover:bg-paper-sunk"
                  >
                    <Icon name="sign" className="size-4 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.title}</span>
                    <span className="flex items-center gap-2 text-xs text-ink-faint">
                      <span
                        className="rounded-full bg-paper-sunk px-2 py-0.5"
                        data-testid="sign-status"
                      >
                        {STATUS_LABEL[e.status]}
                      </span>
                      <span className="hidden sm:inline">
                        {when(e.completed ?? e.updated ?? e.created)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </ListPanel>
        </ListColumn>
      </div>
    </>
  )
}
