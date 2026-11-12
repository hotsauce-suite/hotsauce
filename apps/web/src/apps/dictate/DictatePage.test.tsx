import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectLink } from '../../api/dictation'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'

const opened = vi.hoisted(() => ({ links: [] as string[] }))
vi.mock('./openAppLink', () => ({ openAppLink: (link: string) => opened.links.push(link) }))

afterEach(() => {
  opened.links = []
})

describe('Hearth Dictate page', () => {
  it('points to the source when this server has no Mac app build', async () => {
    server.use(
      http.head('/downloads/HearthDictate.dmg', () => new HttpResponse(null, { status: 404 })),
    )
    renderApp('/dictate')
    expect(await screen.findByTestId('dictate-build-from-source')).toHaveAttribute(
      'href',
      expect.stringContaining('apps/dictate-mac/README.md'),
    )
    expect(screen.queryByTestId('dictate-download')).toBeNull()
    expect(screen.queryByTestId('dictate-download-zip')).toBeNull()
  })

  it('offers the Mac download, the how-to and the team words', async () => {
    renderApp('/dictate')
    expect(await screen.findByTestId('dictate-download')).toHaveAttribute(
      'href',
      '/downloads/HearthDictate.dmg',
    )
    expect(screen.getByTestId('dictate-download-zip')).toHaveAttribute(
      'href',
      '/downloads/HearthDictate.zip',
    )
    expect(screen.getByTestId('dictate-install-steps')).toHaveTextContent('Open Anyway')
    expect(screen.getByTestId('dictate-open-privacy')).toHaveAttribute(
      'href',
      'x-apple.systempreferences:com.apple.preference.security',
    )
    expect(screen.getByText(/Double-tap/)).toBeInTheDocument()
    expect(await screen.findByTestId('dictate-no-devices')).toBeInTheDocument()
    const team = screen.getByTestId('dictate-words-team')
    expect(await within(team).findByText('Acme')).toBeInTheDocument()
    expect(screen.getByTestId('app-switch-dictate')).toHaveAttribute('aria-current', 'page')
  })

  it('connects this Mac: opens the app link and shows the code to paste', async () => {
    const user = userEvent.setup()
    renderApp('/dictate')
    await user.click(await screen.findByTestId('dictate-connect'))
    const code = await screen.findByTestId('dictate-connect-code')
    expect(code.textContent).toMatch(/^hearth-dictate:\/\/connect\?token=hdt_mock/)
    expect(opened.links).toEqual([code.textContent])
    const devices = await screen.findByTestId('dictate-devices')
    expect(within(devices).getByText(/Mac connected/)).toBeInTheDocument()

    await user.click(within(devices).getByRole('button', { name: /Disconnect/ }))
    expect(await screen.findByTestId('dictate-no-devices')).toBeInTheDocument()
  })

  it('adds and removes my words', async () => {
    const user = userEvent.setup()
    renderApp('/dictate')
    const mine = await screen.findByTestId('dictate-words-mine')
    await within(mine).findByText('None yet.')
    await user.type(within(mine).getByRole('textbox'), 'Zorblax, Fly.io{Enter}')
    expect(await within(mine).findByText('Zorblax')).toBeInTheDocument()
    expect(within(mine).getByText('Fly.io')).toBeInTheDocument()
    await user.click(within(mine).getByRole('button', { name: 'Remove Zorblax' }))
    await waitFor(() => expect(within(mine).queryByText('Zorblax')).not.toBeInTheDocument())
  })
})

describe('connectLink', () => {
  it('carries the token and server as query parameters', () => {
    const url = new URL(connectLink('hdt_abc', 'https://office.example.com'))
    expect(url.protocol).toBe('hearth-dictate:')
    expect(url.searchParams.get('token')).toBe('hdt_abc')
    expect(url.searchParams.get('server')).toBe('https://office.example.com')
  })
})
