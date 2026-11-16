import { useEffect, useState } from 'react'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { LoadError } from '../../components/LoadError'
import { MeetingsPageHeader } from '../meetings/components/common'
import { ForYouList, type ForYouToast, ForYouToastBar } from './ForYouList'
import { refreshForYou, useForYou } from './store'

/** `/for-you`: every item where someone @mentioned the member (docs/PLAN-comments.md slice 2). */
export default function ForYouPage() {
  const { status, view } = useForYou()
  const [toast, setToast] = useState<ForYouToast | null>(null)
  useEffect(() => {
    document.title = `${view.unseen > 0 ? `(${view.unseen}) ` : ''}For you · ${product()}`
  }, [view.unseen])
  return (
    <>
      <MeetingsPageHeader title="For you" menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            Everything where someone @mentioned you in a comment, newest first. Opening one marks it
            read. Done takes it off the list until someone mentions you there again; Later hides it
            until 9 AM tomorrow or next Monday.
          </p>
          {status === 'error' ? (
            <LoadError things="list" onRetry={() => void refreshForYou()} className="mb-4" />
          ) : null}
          {status === 'ready' && !view.canMark && view.items.length > 0 ? (
            <p className="mb-4 rounded-lg bg-paper-sunk px-3 py-2 text-sm text-ink-soft">
              Done and Later need your personal space, which isn’t set up yet.
            </p>
          ) : null}
          {status === 'ready' && view.items.length === 0 ? (
            <EmptyState icon="at" title="Nothing waiting on you" testId="for-you-empty">
              When a teammate types @ and your name in a comment on a doc, meeting note or task, it
              shows up here.
            </EmptyState>
          ) : null}
          <ForYouList items={view.items} canMark={view.canMark} onToast={setToast} />
        </div>
      </div>
      <ForYouToastBar toast={toast} onClose={() => setToast(null)} />
    </>
  )
}
