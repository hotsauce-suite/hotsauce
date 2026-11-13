import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSingleKeys } from './prefs'
import { bindShortcut, installKeyListener } from './shortcuts'

let uninstall: () => void
const unbind: (() => void)[] = []
beforeEach(() => {
  uninstall = installKeyListener()
})
afterEach(() => {
  for (const u of unbind.splice(0)) u()
  uninstall()
  document.body.innerHTML = ''
  setSingleKeys(true)
})

function bind(...args: Parameters<typeof bindShortcut>) {
  const off = bindShortcut(...args)
  unbind.push(off)
  return off
}

/** Dispatches a keydown on `target` (default: body); returns whether the default was prevented. */
function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
  return !fireEvent.keyDown(target, { key, bubbles: true, cancelable: true, ...init })
}

describe('the key listener (K4)', () => {
  it('runs the bound handler and prevents the default', () => {
    const run = vi.fn(() => true)
    bind('global.help', run)
    expect(press('?', { shiftKey: true })).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('passes the spec that matched', () => {
    const run = vi.fn(() => true)
    bind('tasks.priority', run)
    press('3')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ spec: '3' }))
  })

  it('ignores plain keys while typing, but ⌘ keys still work', () => {
    const help = vi.fn(() => true)
    const palette = vi.fn(() => true)
    bind('global.help', help)
    bind('global.commandK', palette)
    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(input, editable)
    expect(press('?', {}, input)).toBe(false)
    press('?', {}, editable)
    expect(help).not.toHaveBeenCalled()
    expect(press('k', { metaKey: true }, input)).toBe(true)
    expect(palette).toHaveBeenCalledOnce()
  })

  it('treats a checkbox as not typing', () => {
    const run = vi.fn(() => true)
    bind('tasks.next', run)
    const box = document.createElement('input')
    box.type = 'checkbox'
    document.body.append(box)
    press('j', {}, box)
    expect(run).toHaveBeenCalledOnce()
  })

  it('ignores plain keys while a dialog or menu is open', () => {
    const run = vi.fn(() => true)
    bind('tasks.next', run)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    press('j')
    expect(run).not.toHaveBeenCalled()
    dialog.setAttribute('role', 'menu')
    press('j')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves Enter and Space on a button or link to the control', () => {
    const open = vi.fn(() => true)
    const complete = vi.fn(() => true)
    bind('tasks.open', open)
    bind('tasks.complete', complete)
    const button = document.createElement('button')
    const link = document.createElement('a')
    link.href = '/x'
    document.body.append(button, link)
    expect(press('Enter', {}, button)).toBe(false)
    press(' ', {}, link)
    expect(open).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    press('Enter')
    expect(open).toHaveBeenCalledOnce()
  })

  it('leaves the arrow keys to a focused video', () => {
    const run = vi.fn(() => true)
    bind('clips.back5', run)
    const video = document.createElement('video')
    document.body.append(video)
    press('ArrowLeft', {}, video)
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves an event someone already handled alone', () => {
    const run = vi.fn(() => true)
    bind('global.commandK', run)
    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (e) => e.preventDefault())
    press('k', { metaKey: true }, editor)
    expect(run).not.toHaveBeenCalled()
  })

  it('needs exactly the modifiers the spec names', () => {
    const run = vi.fn(() => true)
    bind('tasks.next', run)
    press('j', { metaKey: true })
    press('j', { altKey: true })
    press('J', { shiftKey: true })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('handlers (K5)', () => {
  it('a handler that returns false lets the key through', () => {
    bind('tasks.complete', () => false)
    expect(press('x')).toBe(false)
  })

  it('the newest binding wins; removing it restores the one before', () => {
    const outer = vi.fn(() => true)
    const inner = vi.fn(() => true)
    bind('global.help', outer)
    const off = bind('global.help', inner)
    press('?')
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
    off()
    press('?')
    expect(outer).toHaveBeenCalledOnce()
  })
})

describe('single-key shortcuts off (K6)', () => {
  it('turns off character keys only', () => {
    const help = vi.fn(() => true)
    const next = vi.fn(() => true)
    const palette = vi.fn(() => true)
    bind('global.help', help)
    bind('tasks.next', next)
    bind('global.commandK', palette)
    setSingleKeys(false)
    press('?')
    press('j')
    expect(help).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    press('ArrowDown')
    expect(next).toHaveBeenCalledOnce()
    press('k', { ctrlKey: true })
    expect(palette).toHaveBeenCalledOnce()
    expect(localStorage.getItem('hearth:single-keys')).toBe('off')
  })
})
