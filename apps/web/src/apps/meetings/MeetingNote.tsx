import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { DocumentView, type ExtraPanel } from '../../components/DocumentView'
import { PANES_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { ChatPanel } from './components/ChatPanel'
import { MeetingHeader } from './components/MeetingHeader'
import { TranscriptPanel } from './components/TranscriptPanel'
import { aiRanges } from './editor/aiRanges'
import { isTranscriptPath } from './format'
import { meetingsApp } from './manifest'

function decode(splat: string): string {
  try {
    return decodeURIComponent(splat)
  } catch {
    return splat
  }
}

/**
 * /meetings/:space/* — a meeting note in the Docs editor, with the Meetings header (Enhance),
 * the transcript beside it, AI-written lines muted, and an ask bar for this meeting.
 */
export default function MeetingNote() {
  const params = useParams()
  const space = params.space ?? ''
  const path = decode(params['*'] ?? '')
  const key = `${space}:${path}`
  // A transcript opened from a citation is just a file: no header, no ask bar.
  if (isTranscriptPath(path)) {
    return <DocumentView key={key} app={meetingsApp} space={space} path={path} />
  }
  return <MeetingDocument key={key} space={space} path={path} />
}

function MeetingDocument({ space, path }: { space: string; path: string }) {
  const roomy = useMediaQuery(PANES_QUERY)
  const location = useLocation()
  const navigate = useNavigate()
  const autoEnhance = (location.state as { enhance?: boolean } | null)?.enhance === true
  const [enhancing, setEnhancing] = useState(false)
  const extensions = useMemo(() => [aiRanges()], [])
  const panels = useMemo<ExtraPanel[]>(
    () => [
      {
        id: 'transcript',
        label: 'Transcript',
        icon: 'transcript',
        testId: 'transcript-toggle',
        render: (close, doc) => (
          <TranscriptPanel space={space} notePath={path} doc={doc} onClose={close} />
        ),
      },
    ],
    [space, path],
  )

  return (
    <DocumentView
      app={meetingsApp}
      space={space}
      path={path}
      extensions={extensions}
      readOnly={enhancing}
      panels={panels}
      // Beside the note on a wide screen. Narrower (an upright iPad) it would float over the note,
      // and on a phone it's a sheet: there it opens on a tap.
      initialPanel={roomy ? 'transcript' : null}
      header={(doc) => (
        <MeetingHeader
          doc={doc}
          space={space}
          path={path}
          autoEnhance={autoEnhance}
          onEnhancing={setEnhancing}
          // So a reload doesn't enhance again.
          onAutoEnhance={() =>
            navigate(`${location.pathname}${location.hash}`, { replace: true, state: null })
          }
        />
      )}
      footer={() => (
        <ChatPanel
          variant="dock"
          scope={{ space, meetingPath: path }}
          placeholder="Ask about this meeting"
        />
      )}
    />
  )
}
