import { describe, expect, it } from 'vitest'
import { opensSetup, shortcutFor, steps, updateNote } from './setup'

const server = { url: 'https://hotsauce.acme.com', name: 'Hotsauce' }

describe('setup steps', () => {
  it('ticks nothing on a fresh install', () => {
    const list = steps({ server: null, pinned: false, tried: false }, 'Hotsauce')
    expect(list.map((s) => [s.id, s.done])).toEqual([
      ['connect', false],
      ['pin', false],
      ['try', false],
    ])
    expect(list[0]?.hint).toContain('hotsauce.acme.com')
  })
  it('ticks each step from what is so', () => {
    const list = steps({ server, pinned: true, tried: true }, 'Hotsauce')
    expect(list.every((s) => s.done)).toBe(true)
    expect(list[0]?.hint).toBe('Connected to hotsauce.acme.com.')
  })
  it('leaves Pin open when Chrome can’t say', () => {
    expect(steps({ server, pinned: null, tried: false }, 'Acme')[1]?.done).toBe(false)
    expect(steps({ server, pinned: null, tried: false }, 'Acme')[1]?.hint).toContain('Acme')
  })
})

describe('shortcut', () => {
  it('is the popup’s shortcut, or null when Chrome has none', () => {
    expect(shortcutFor([{ name: '_execute_action', shortcut: '⌥⇧H' }])).toBe('⌥⇧H')
    expect(shortcutFor([{ name: '_execute_action', shortcut: '' }])).toBeNull()
    expect(shortcutFor([{ name: 'other', shortcut: 'Ctrl+K' }])).toBeNull()
  })
})

describe('updates', () => {
  it('says the Web Store updates it, or where to get a new copy', () => {
    expect(updateNote('normal', server)).toContain('by itself')
    expect(updateNote('admin', null)).toContain('by itself')
    expect(updateNote('development', server)).toContain('hotsauce.acme.com/meetings/extension')
    expect(updateNote(undefined, null)).toContain('your workspace')
  })
})

describe('opening the setup page', () => {
  it('opens on install only', () => {
    expect(opensSetup('install')).toBe(true)
    expect(opensSetup('update')).toBe(false)
    expect(opensSetup('chrome_update')).toBe(false)
  })
})
