// Today's For you tile (docs/PLAN-comments.md R13): the newest few things waiting on the member,
// with Done and Later, and a link to the whole list.

import { useState } from 'react'
import { Link } from 'react-router'
import { ForYouList, type ForYouToast, ForYouToastBar } from '../../for-you/ForYouList'
import { useForYou } from '../../for-you/store'
import { Card, Empty } from './Card'

const SHOWN = 5

export function ForYouTile() {
  const { status, view } = useForYou()
  const [toast, setToast] = useState<ForYouToast | null>(null)
  const more = view.items.length - SHOWN
  return (
    <Card
      title={view.unseen > 0 ? `For you (${view.unseen} new)` : 'For you'}
      icon="at"
      testId="today-for-you"
      action={
        <Link to="/for-you" className="text-xs font-medium text-ember-strong hover:underline">
          {more > 0 ? `All ${view.items.length}` : 'Open'}
        </Link>
      }
    >
      {status === 'ready' && view.items.length === 0 ? (
        <Empty>
          Nothing waiting on you. When someone @mentions you in a comment, it shows here.
        </Empty>
      ) : status === 'error' ? (
        <Empty>Couldn’t load what’s waiting on you.</Empty>
      ) : (
        <ForYouList
          items={view.items.slice(0, SHOWN)}
          canMark={view.canMark}
          onToast={setToast}
          compact
        />
      )}
      <ForYouToastBar toast={toast} onClose={() => setToast(null)} />
    </Card>
  )
}
