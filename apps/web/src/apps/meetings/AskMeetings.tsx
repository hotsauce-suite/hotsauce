import { useEffect, useState } from 'react'
import type { ChatScope } from '../../api/types'
import { product } from '../../brand/product'
import { useSession } from '../../state/session'
import { ChatPanel } from './components/ChatPanel'
import { MeetingsPageHeader } from './components/common'

/** `/meetings/ask`: questions across every meeting you can see, or one space's. */
export default function AskMeetings() {
  const session = useSession()
  const [space, setSpace] = useState('')
  const scope: ChatScope = space ? { space } : {}

  useEffect(() => {
    document.title = `Ask · ${product()} Meetings`
  }, [])

  return (
    <>
      <MeetingsPageHeader title="Ask across meetings">
        <select
          aria-label="Which meetings"
          value={space}
          onChange={(e) => setSpace(e.target.value)}
          className="h-8 rounded-lg border border-ash bg-paper-raised px-2 text-sm text-ink"
        >
          <option value="">All meetings</option>
          {session.spaces.map((s) => (
            <option key={s.name} value={s.name}>
              {s.label}
            </option>
          ))}
        </select>
      </MeetingsPageHeader>
      <ChatPanel
        key={space}
        variant="page"
        scope={scope}
        placeholder="Ask across your meetings"
        intro="Ask anything your meetings might answer: what a customer asked for, who owns a follow-up, what was decided. Every answer links to the lines it came from."
      />
    </>
  )
}
