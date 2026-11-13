import { describe, expect, it } from 'vitest'
import { rememberSaveTab, SAVE_TAB_TTL_MS, savable, savePageUrl, takeSaveTab } from './save'

const HEARTH = ['https://office.example.com']

describe('save to Hearth', () => {
  it('saves web pages only, never Chrome’s own pages or Hearth itself', () => {
    expect(savable('https://example.com/a', HEARTH)).toBe(true)
    expect(savable('http://example.com', HEARTH)).toBe(true)
    expect(savable('chrome://extensions', HEARTH)).toBe(false)
    expect(savable('https://office.example.com/links', HEARTH)).toBe(false)
    expect(savable('file:///x.pdf', HEARTH)).toBe(false)
    expect(savable(undefined, HEARTH)).toBe(false)
  })

  it('opens the save page with the address, a tidy title and where it came from', () => {
    const url = new URL(
      savePageUrl('https://office.example.com', {
        url: 'https://ex.com/a?b=1&c=2#d',
        title: ' A \n title ',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://office.example.com/links/save')
    expect(url.searchParams.get('url')).toBe('https://ex.com/a?b=1&c=2#d')
    expect(url.searchParams.get('title')).toBe('A title')
    expect(url.searchParams.get('via')).toBe('extension')
    expect(
      new URL(
        savePageUrl('https://office.example.com', { url: 'https://x.test' }),
      ).searchParams.has('title'),
    ).toBe(false)
  })

  it('remembers the tabs it opened, and forgets old ones', () => {
    let list = rememberSaveTab([], { saveTabId: 5, fromTabId: 1, at: 0 })
    list = rememberSaveTab(list, { saveTabId: 6, fromTabId: 2, at: SAVE_TAB_TTL_MS + 1 })
    expect(list.map((s) => s.saveTabId)).toEqual([6])
    const { entry, rest } = takeSaveTab(list, 6)
    expect(entry?.fromTabId).toBe(2)
    expect(rest).toEqual([])
    expect(takeSaveTab(list, 99).entry).toBeNull()
  })
})
