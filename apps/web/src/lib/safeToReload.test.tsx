import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLeaveGuard } from '../hooks/useLeaveGuard'
import { registerLeaveGuard, trackWrite } from './leaveGuards'
import {
  dialogOpen,
  guardsLeaving,
  holdsTyping,
  reloadBlocker,
  watching,
  watchTyping,
} from './safeToReload'

watchTyping()

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

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

  it('waits while a text box holds text someone typed', () => {
    document.body.innerHTML = '<textarea></textarea><input type="text" value="">'
    expect(holdsTyping()).toBe(false)
    typeInto(document.querySelector('textarea') as HTMLTextAreaElement, 'half a comment')
    expect(reloadBlocker({ recordingMeeting: false })).toBe('typing')
  })

  it('ignores saved values a form shows, and fields emptied again', () => {
    document.body.innerHTML = '<input type="text" value="Haven"><textarea></textarea>'
    expect(holdsTyping()).toBe(false)
    const box = document.querySelector('textarea') as HTMLTextAreaElement
    typeInto(box, 'x')
    typeInto(box, '')
    expect(holdsTyping()).toBe(false)
  })

  it('ignores disabled and read-only fields, and the doc editor', () => {
    document.body.innerHTML = `
      <input id="a" type="text" disabled>
      <input id="b" type="text" readonly>
      <div class="cm-editor"><textarea id="c"></textarea></div>`
    for (const id of ['a', 'b', 'c']) typeInto(document.getElementById(id) as HTMLInputElement, 'x')
    expect(holdsTyping()).toBe(false)
  })

  it('waits while uploads run or a save is on its way, outside any page', async () => {
    const remove = registerLeaveGuard(() => true)
    expect(reloadBlocker({ recordingMeeting: false })).toBe('busy')
    remove()
    let answer: () => void = () => {}
    const save = trackWrite(new Promise<void>((r) => (answer = r)))
    expect(reloadBlocker({ recordingMeeting: false })).toBe('busy')
    answer()
    await save
    expect(reloadBlocker({ recordingMeeting: false })).toBeNull()
  })

  it('closing the tab asks first while a guard holds', () => {
    const remove = registerLeaveGuard(() => true)
    expect(guardsLeaving()).toBe(true)
    remove()
    expect(guardsLeaving()).toBe(false)
  })

  it('waits while audio or video plays, but not for a camera preview', () => {
    document.body.innerHTML = '<video></video>'
    const video = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    expect(watching()).toBe(true)
    expect(reloadBlocker({ recordingMeeting: false })).toBe('watching')
    Object.defineProperty(video, 'srcObject', { value: {}, configurable: true })
    expect(watching()).toBe(false)
  })

  it('waits while something is full screen', () => {
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.body,
      configurable: true,
    })
    try {
      expect(watching()).toBe(true)
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    }
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
