import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MAC_PAGE, ORG_PAGES, YOUR_PAGES } from './pages'
import { SETTINGS_INDEX, searchSettings } from './searchIndex'

// docs/PLAN-settings-search.md S2, S3, S6.

const ids = (query: string, admin = true) => searchSettings(query, { admin }).map((e) => e.id)

describe('the list of settings', () => {
  it('names each section once, on a page the menu has', () => {
    const entryIds = SETTINGS_INDEX.map((e) => e.id)
    expect(new Set(entryIds).size).toBe(entryIds.length)
    const pages = new Map(
      [MAC_PAGE, ...YOUR_PAGES, ...ORG_PAGES, { label: 'Help', to: '/settings/whats-new' }].map(
        (p) => [p.to, p.label],
      ),
    )
    for (const entry of SETTINGS_INDEX) expect(pages.get(entry.to)).toBe(entry.page)
  })

  it('marks exactly the Organization pages as admins only', () => {
    for (const entry of SETTINGS_INDEX)
      expect(entry.admin === true).toBe(entry.to.startsWith('/settings/organization'))
  })

  it('marks exactly This Mac as Mac only', () => {
    for (const entry of SETTINGS_INDEX)
      expect(entry.macOnly === true).toBe(entry.to === MAC_PAGE.to)
  })

  it('gives every page of the menu at least one section', () => {
    for (const page of [MAC_PAGE, ...YOUR_PAGES, ...ORG_PAGES])
      expect(SETTINGS_INDEX.some((e) => e.to === page.to)).toBe(true)
  })
})

describe('searching settings', () => {
  it('finds sections by the everyday words people use', () => {
    expect(ids('dark mode')).toEqual(['appearance'])
    expect(ids('logo')).toEqual(['org-brand'])
    expect(ids('backup')[0]).toBe('org-backups')
    expect(ids('sign out')).toContain('account')
    expect(ids('Claude')).toEqual(expect.arrayContaining(['ai-tools', 'connected-apps']))
  })

  it('ignores case, accents and curly quotes', () => {
    expect(ids('APPEARANCE')).toEqual(['appearance'])
    expect(ids('notificátions')).toEqual(['notifications'])
    expect(ids('what’s new')).toEqual(ids("what's new"))
    expect(ids('whats new')[0]).toBe('whats-new')
  })

  it('puts titles that start with what was typed first', () => {
    expect(ids('weather')).toEqual(['weather', 'org-weather'])
    expect(ids('upd')[0]).toBe('org-updates')
  })

  it('gives members only their own pages’ sections', () => {
    expect(ids('backups', false)).toEqual([])
    expect(ids('weather', false)).toEqual(['weather'])
    expect(ids('brand', false)).toEqual([])
  })

  it('shows Mac-only sections only inside the Mac app', () => {
    const index = [
      {
        id: 'm',
        title: 'Dictation shortcut',
        page: 'This Mac',
        to: '/x',
        summary: '',
        words: [],
        macOnly: true as const,
      },
    ]
    expect(searchSettings('dictation', { admin: true, index })).toEqual([])
    expect(
      searchSettings('dictation', { admin: false, mac: true, index }).map((e) => e.id),
    ).toEqual(['m'])
  })

  it('finds nothing for nothing typed, or for nonsense', () => {
    expect(ids('')).toEqual([])
    expect(ids('   ')).toEqual([])
    expect(ids('zzqx')).toEqual([])
  })

  it('finds every section by its own title, for anyone allowed to see it', () => {
    const found = (query: string, admin: boolean, mac: boolean) =>
      searchSettings(query, { admin, mac }).map((e) => e.id)
    for (const entry of SETTINGS_INDEX) {
      expect(found(entry.title, true, true)).toContain(entry.id)
      expect(found(entry.title, false, true).includes(entry.id)).toBe(!entry.admin)
      expect(found(entry.title, true, false).includes(entry.id)).toBe(!entry.macOnly)
    }
  })

  it('narrows as more is typed, and never shows members an admin section', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        fc.string({ maxLength: 6 }),
        fc.boolean(),
        (a, b, admin) => {
          const wide = searchSettings(a, { admin }).map((e) => e.id)
          const narrow = searchSettings(`${a} ${b}`, { admin })
          if (/[\p{L}\p{N}]/u.test(a)) for (const e of narrow) expect(wide).toContain(e.id)
          if (!admin) for (const e of narrow) expect(e.admin).toBeUndefined()
        },
      ),
    )
  })
})
