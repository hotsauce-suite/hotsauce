import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { TEST_USER } from '../../test/mockServer'
import { serveOrg } from '../../test/orgSettings'
import { renderApp } from '../../test/renderApp'
import { forgetUnapplied } from '../OrgSettingsRoute'
import { movedSection, orgPageOf } from './pages'

beforeEach(forgetUnapplied)

// docs/PLAN-settings-pages.md: the menu (L1–L3), old addresses (G4), and the organization's
// pages (O1–O6).

const nav = async () => within(await screen.findByTestId('settings-nav'))
const page = (id: string) => screen.findByTestId(id)

describe('Settings: the menu', () => {
  it('gives a member General, Appearance, Connections and Apps, and no organization pages', async () => {
    serveOrg({ admin: false })
    renderApp('/settings')
    const menu = await nav()
    await screen.findByTestId('settings-account')
    expect(menu.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['General', '/settings'],
      ['Appearance', '/settings/appearance'],
      ['Connections', '/settings/connections'],
      ['Apps', '/settings/apps'],
    ])
    expect(screen.queryByTestId('settings-nav-org')).toBeNull()
  })

  it('adds the five organization pages for an admin, under one heading', async () => {
    serveOrg({ admin: true })
    renderApp('/settings')
    await waitFor(() =>
      expect(screen.getByTestId('settings-nav-org')).toHaveTextContent('Organization'),
    )
    const menu = await nav()
    // The heading is hidden on phones; the group names the organization's pages either way.
    expect(
      within(menu.getByRole('group', { name: 'Organization' }))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Workspace', 'Brand', 'People and access', 'AI', 'Data and updates', 'Usage'])
    expect(menu.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['General', '/settings'],
      ['Appearance', '/settings/appearance'],
      ['Connections', '/settings/connections'],
      ['Apps', '/settings/apps'],
      ['Workspace', '/settings/organization'],
      ['Brand', '/settings/organization/brand'],
      ['People and access', '/settings/organization/people'],
      ['AI', '/settings/organization/ai'],
      ['Data and updates', '/settings/organization/data'],
      ['Usage', '/settings/organization/usage'],
    ])
  })

  it('marks only the current page, and moves between pages', async () => {
    serveOrg({ admin: true })
    const { router } = renderApp('/settings')
    const menu = await nav()
    const current = () =>
      menu.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page')
    await waitFor(() => expect(current().map((a) => a.textContent)).toEqual(['General']))

    await userEvent.click(menu.getByRole('link', { name: 'Connections' }))
    await page('settings-connections')
    expect(router.state.location.pathname).toBe('/settings/connections')
    expect(current().map((a) => a.textContent)).toEqual(['Connections'])
    expect(screen.queryByTestId('settings-general')).toBeNull()

    await userEvent.click(await menu.findByRole('link', { name: 'Brand' }))
    await page('brand-section')
    // Workspace's address is a prefix of Brand's; only Brand is current.
    expect(current().map((a) => a.textContent)).toEqual(['Brand'])
  })

  it('tells a member who opens an organization page that it’s for admins', async () => {
    serveOrg({ admin: false })
    renderApp('/settings/organization/people')
    expect(await page('org-admins-only')).toHaveTextContent('Only admins')
    expect(screen.queryByTestId('org-people-section')).toBeNull()
  })
})

describe('Settings: addresses from before the pages', () => {
  it('knows where each old section went', () => {
    expect(movedSection('/settings', '#mac-app')).toBe('/settings/apps#mac-app')
    expect(movedSection('/settings', '#calendars')).toBe('/settings/connections#calendars')
    expect(movedSection('/settings', '#ai-tools')).toBe('/settings/connections#ai-tools')
    // Still on General.
    expect(movedSection('/settings', '#notifications')).toBeNull()
    expect(movedSection('/settings', '#keyboard')).toBeNull()
    expect(movedSection('/settings', '')).toBeNull()
    // Already on its page.
    expect(movedSection('/settings/apps', '#mac-app')).toBeNull()
  })

  it('opens Apps for /settings#mac-app', async () => {
    serveOrg({ admin: false })
    const { router } = renderApp('/settings#mac-app')
    await page('mac-app')
    expect(router.state.location.pathname).toBe('/settings/apps')
    expect(router.state.location.hash).toBe('#mac-app')
  })

  it.each([
    ['/settings#calendars', '/settings/connections', '#calendars'],
    ['/settings#ai-tools', '/settings/connections', '#ai-tools'],
  ])('opens Connections for %s', async (old, pathname, hash) => {
    serveOrg({ admin: false })
    const { router } = renderApp(old)
    await page('settings-connections')
    expect(router.state.location.pathname).toBe(pathname)
    expect(router.state.location.hash).toBe(hash)
    expect(document.getElementById(hash.slice(1))).not.toBeNull()
  })

  it('keeps /settings#notifications on General', async () => {
    serveOrg({ admin: false })
    const { router } = renderApp('/settings#notifications')
    await page('settings-notifications')
    expect(router.state.location.pathname).toBe('/settings')
  })
})

describe('Settings: the organization’s pages', () => {
  it('reads the page from the address', () => {
    expect(orgPageOf(undefined)).toBe('workspace')
    expect(orgPageOf('brand')).toBe('brand')
    expect(orgPageOf('data')).toBe('data')
    expect(orgPageOf('nope')).toBeNull()
  })

  const pages: [string, string[], string[]][] = [
    [
      '/settings/organization',
      [
        'org-summary',
        'org-names-section',
        'org-weather',
        'org-start-here',
        'org-chat-section',
        'org-chat-rooms',
      ],
      ['brand-section', 'org-people-section', 'signin-section', 'ai-section', 'storage-section'],
    ],
    [
      '/settings/organization/brand',
      ['brand-section'],
      ['org-summary', 'org-names-section', 'signin-section', 'ai-section', 'storage-section'],
    ],
    [
      '/settings/organization/people',
      ['org-people-section', 'signin-section', 'org-link-sharing'],
      ['org-summary', 'org-names-section', 'brand-section', 'ai-section', 'storage-section'],
    ],
    [
      '/settings/organization/ai',
      ['ai-section', 'org-assistant'],
      ['org-summary', 'org-people-section', 'brand-section', 'storage-section'],
    ],
    [
      '/settings/organization/data',
      ['storage-section', 'org-backups', 'org-updates'],
      ['org-summary', 'org-people-section', 'brand-section', 'ai-section'],
    ],
  ]
  it.each(pages)('%s holds its sections, in order, and no others', async (path, has, hasNot) => {
    serveOrg({ admin: true })
    renderApp(path)
    const first = has[0] as string
    await page(first)
    const found = has.map((id) => screen.getByTestId(id))
    for (let i = 1; i < found.length; i++)
      expect(
        (found[i - 1] as HTMLElement).compareDocumentPosition(found[i] as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${has[i - 1]} before ${has[i]}`,
      ).toBeTruthy()
    for (const id of hasNot) expect(screen.queryByTestId(id)).toBeNull()
  })

  it('splits “Your organization” across pages: names, people, chat', async () => {
    serveOrg({ admin: true })
    renderApp('/settings/organization')
    const names = within(await page('org-names-section'))
    expect(names.getByTestId('org-name')).toHaveValue('Acme Labs')
    expect(names.getByTestId('product-name')).toBeInTheDocument()
    expect(names.queryByTestId('allowed-domains')).toBeNull()
    expect(names.queryByTestId('chat-url')).toBeNull()
    const chat = within(screen.getByTestId('org-chat-section'))
    expect(chat.getByTestId('chat-url')).toHaveValue('https://chat.acme.test')
    expect(chat.queryByTestId('org-name')).toBeNull()

    await userEvent.click((await nav()).getByRole('link', { name: 'People and access' }))
    const people = within(await page('org-people-section'))
    expect(people.getByTestId('allowed-domains')).toHaveValue('acme.test')
    expect(people.getByTestId('allowed-emails')).toBeInTheDocument()
    expect(people.getByTestId('admin-emails')).toHaveValue(TEST_USER)
    expect(people.queryByTestId('org-name')).toBeNull()
  })

  it('saves only the page’s own fields, and keeps the apply banner across pages', async () => {
    const saves = serveOrg({ admin: true })
    const user = userEvent.setup()
    renderApp('/settings/organization')
    const names = within(await page('org-names-section'))
    await user.clear(names.getByTestId('org-name'))
    await user.type(names.getByTestId('org-name'), 'Acme Research')
    await user.click(names.getByTestId('org-names-section-save'))
    await page('apply-banner')
    expect(saves).toEqual([{ orgName: 'Acme Research', productName: '' }])
    // The summary on the same page shows the saved name.
    expect(screen.getByTestId('org-summary')).toHaveTextContent('Acme Research')

    const chat = within(screen.getByTestId('org-chat-section'))
    await user.clear(chat.getByTestId('chat-url'))
    await user.click(chat.getByTestId('org-chat-section-save'))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]).toEqual({ chatUrl: '' })

    // The save waiting on a restart follows the admin to another organization page.
    await user.click((await nav()).getByRole('link', { name: 'People and access' }))
    const people = within(await page('org-people-section'))
    expect(screen.getByTestId('apply-banner')).toBeInTheDocument()
    await user.type(people.getByTestId('allowed-emails'), 'jo@partner.test')
    await user.click(people.getByTestId('org-people-section-save'))
    await waitFor(() => expect(saves).toHaveLength(3))
    expect(saves[2]).toEqual({
      allowedDomains: 'acme.test',
      allowedEmails: 'jo@partner.test',
      adminEmails: TEST_USER,
    })
    // And the people page saved nothing over the new name.
    await user.click((await nav()).getByRole('link', { name: 'Workspace' }))
    expect(within(await page('org-names-section')).getByTestId('org-name')).toHaveValue(
      'Acme Research',
    )

    // Until it's applied: a look at General and back doesn't lose the banner.
    await user.click((await nav()).getByRole('link', { name: 'General' }))
    await page('settings-account')
    expect(screen.queryByTestId('apply-banner')).toBeNull()
    await user.click((await nav()).getByRole('link', { name: 'AI' }))
    await page('ai-section')
    expect(screen.getByTestId('apply-banner')).toBeInTheDocument()
  })

  it('shows no apply banner when nothing was saved', async () => {
    serveOrg({ admin: true })
    renderApp('/settings/organization')
    await page('org-names-section')
    expect(screen.queryByTestId('apply-banner')).toBeNull()
  })

  it('says so for an address that names no page', async () => {
    serveOrg({ admin: true })
    renderApp('/settings/organization/nope')
    expect(await screen.findByText('There’s no settings page at this address.')).toBeInTheDocument()
  })
})
