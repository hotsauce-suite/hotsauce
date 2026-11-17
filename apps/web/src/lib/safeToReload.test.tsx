import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLeaveGuard } from '../hooks/useLeaveGuard'
import { dialogOpen, guardsLeaving, holdsTyping, reloadBlocker } from './safeToReload'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('reloadBlocker (R4)', () => {
  it('lets an untouched page reload', () => {
    document.body.innerHTML = '<main><h1>Docs</h1><input type="checkbox" checked></main>'
    expect(reloadBlocker({ recordingMeeting: false })).toBeNull()
  })

  it('waits while a meeting is recorded', () => {
    expect(reloadBlocker({ recordingMeeting: true })).toBe('meeting')
  })

  it('waits while anything guards leaving the page', () => {
    const guard = (e: Event) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    try {
      expect(guardsLeaving()).toBe(true)
      expect(reloadBlocker({ recordingMeeting: false })).toBe('guarded')
    } finally {
      window.removeEventListener('beforeunload', guard)
    }
    expect(guardsLeaving()).toBe(false)
  })

  it('waits while a text box holds text', () => {
    document.body.innerHTML = '<textarea></textarea><input type="text" value="">'
    expect(holdsTyping()).toBe(false)
    const box = document.querySelector('textarea') as HTMLTextAreaElement
    box.value = 'half a comment'
    expect(reloadBlocker({ recordingMeeting: false })).toBe('typing')
  })

  it('ignores empty, disabled and read-only fields, and the doc editor', () => {
    document.body.innerHTML = `
      <input type="text" value="x" disabled>
      <input type="text" value="x" readonly>
      <input type="hidden" value="x">
      <div class="cm-editor"><div contenteditable="true">saved doc text</div></div>`
    expect(holdsTyping()).toBe(false)
  })

  it('waits while a dialog is open', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true">Rename</div>'
    expect(dialogOpen()).toBe(true)
    expect(reloadBlocker({ recordingMeeting: false })).toBe('dialog')
  })
})

describe('useLeaveGuard (R8)', () => {
  function Recorder({ on }: { on: boolean }) {
    useLeaveGuard(on)
    return null
  }

  it('guards leaving only while active', () => {
    const view = render(<Recorder on={false} />)
    expect(guardsLeaving()).toBe(false)
    act(() => view.rerender(<Recorder on />))
    expect(guardsLeaving()).toBe(true)
    act(() => view.rerender(<Recorder on={false} />))
    expect(guardsLeaving()).toBe(false)
  })
})
