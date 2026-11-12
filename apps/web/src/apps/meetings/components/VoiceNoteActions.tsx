import { parseFrontmatter } from '@hearth/format'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { meetingsApi } from '../../../api/meetings'
import { tasksApi } from '../../../api/tasks'
import { Icon } from '../../../components/Icon'
import type { DocumentHandle } from '../../../hooks/useDocument'
import { markdownForCopy } from '../../../lib/copyNote'
import { useSession } from '../../../state/session'

const button =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember disabled:opacity-50'

/**
 * A voice note's own buttons, under its header: Copy text, Share (the phone's share sheet),
 * Send to-dos to Tasks, and Delete. Moving it to the team is in the Share menu, as for any note.
 */
export function VoiceNoteActions({
  doc,
  space,
  path,
}: {
  doc: DocumentHandle
  space: string
  path: string
}) {
  const { notify } = useSession()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<'tasks' | 'delete' | null>(null)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const text = () => markdownForCopy(doc.getText())
  const title = () => {
    const value = parseFrontmatter(doc.getText()).data.title
    return typeof value === 'string' ? value : 'Voice note'
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text())
      notify('Copied. Paste it anywhere.')
    } catch {
      notify('Couldn’t copy. Your browser blocked the clipboard.')
    }
  }

  const share = async () => {
    try {
      await navigator.share({ title: title(), text: text() })
    } catch (err) {
      // Closing the share sheet isn't an error worth saying anything about.
      if (err instanceof DOMException && err.name === 'AbortError') return
      notify('Couldn’t open sharing. Use Copy text instead.')
    }
  }

  const sendToTasks = async () => {
    setBusy('tasks')
    try {
      // What's on screen first: the to-dos are read from the note as saved. Only to-dos no task
      // came from yet, so sending twice adds nothing twice.
      await doc.commit()
      const mine = (await tasksApi.fromMeetings({ space, path })).find(
        (m) => m.space === space && m.path === path,
      )
      const items = mine?.items ?? []
      if (items.length === 0) {
        notify('No to-dos left to send. They’re already in Tasks, or the note has none.')
        return
      }
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      let added = 0
      for (const item of items) {
        await tasksApi.quick({
          text: item.text,
          tz,
          source: { kind: 'meeting', space, path, line: item.line, text: item.text },
        })
        added += 1
      }
      notify(`Added ${added} ${added === 1 ? 'to-do' : 'to-dos'} to Tasks.`)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Couldn’t add the to-dos. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this voice note, its transcript and any kept audio?')) return
    setBusy('delete')
    try {
      await meetingsApi.deleteNote(space, path)
      notify('Voice note deleted.')
      navigate('/dictate/voice', { replace: true })
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Couldn’t delete it. Try again.')
      setBusy(null)
    }
  }

  return (
    <div data-testid="voice-note-actions" className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" data-testid="voice-copy" onClick={() => void copy()} className={button}>
        <Icon name="copy" />
        Copy text
      </button>
      {canShare ? (
        <button
          type="button"
          data-testid="voice-share"
          onClick={() => void share()}
          className={button}
        >
          <Icon name="share" />
          Share
        </button>
      ) : null}
      <button
        type="button"
        data-testid="voice-to-tasks"
        disabled={busy !== null}
        onClick={() => void sendToTasks()}
        className={button}
      >
        <Icon name="tasks" />
        {busy === 'tasks' ? 'Adding…' : 'Send to-dos to Tasks'}
      </button>
      <button
        type="button"
        data-testid="voice-delete"
        disabled={busy !== null}
        onClick={() => void remove()}
        className={`${button} text-ink-soft hover:border-ember-strong hover:text-ember-strong`}
      >
        <Icon name="trash" />
        {busy === 'delete' ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  )
}
