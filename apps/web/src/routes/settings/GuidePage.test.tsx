import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { GUIDE } from '../../guide/appGuide'
import { server } from '../../test/mockServer'
import { serveOrg } from '../../test/orgSettings'
import { renderApp } from '../../test/renderApp'

// docs/PLAN-tour-and-101.md H3-H5.

const cards = () => screen.getAllByTestId('guide-card')
const card = (id: string) => cards().find((c) => c.getAttribute('data-entry') === id) as HTMLElement

/** /api/health without the AI and speech-to-text keys. */
function noKeys() {
  server.use(
    http.get('/api/health', () =>
      HttpResponse.json({
        ok: true,
        authMode: 'dev',
        setupRequired: false,
        productName: 'Hotsauce',
        orgName: 'Acme',
        clerkPublishableKey: null,
        chatUrl: null,
        signInDomain: 'example.test',
        features: { ai: false, transcription: false },
        version: '0.8.0',
      }),
    ),
  )
}

describe('Settings → Hotsauce 101', () => {
  it('is in the menu after Apps, with a card for every app', async () => {
    serveOrg({ admin: false })
    const { router } = renderApp('/settings')
    const link = await screen.findByTestId('settings-nav-guide')
    expect(link).toHaveTextContent('Hotsauce 101')
    const apps = screen.getByTestId('settings-nav-apps')
    expect(apps.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(link)
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/101'))
    await screen.findByTestId('settings-guide')
    expect(cards()).toHaveLength(GUIDE.length)
    expect(within(card('docs')).getByRole('heading', { name: 'Docs' })).toBeInTheDocument()
    expect(within(card('docs')).getByTestId('guide-open')).toHaveAttribute('href', '/docs')
  })

  it('plays the loop in place, and Close or Escape puts the picture back', async () => {
    const user = userEvent.setup()
    serveOrg({ admin: false })
    renderApp('/settings/101')
    await screen.findByTestId('settings-guide')
    const docs = card('docs')
    await user.click(within(docs).getByTestId('guide-play'))
    const video = within(docs).getByTestId('guide-video') as HTMLVideoElement
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    expect(video.getAttribute('src')).toMatch(/docs.*\.mp4/)
    await user.click(within(docs).getByTestId('guide-close'))
    expect(within(docs).queryByTestId('guide-video')).toBeNull()
    expect(within(docs).getByTestId('guide-play')).toBeInTheDocument()

    await user.click(within(docs).getByTestId('guide-play'))
    expect(within(docs).getByTestId('guide-close')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(within(docs).queryByTestId('guide-video')).toBeNull()
  })

  it('says everything is ready when the keys are there', async () => {
    serveOrg({ admin: false })
    renderApp('/settings/101')
    await screen.findByTestId('settings-guide')
    for (const c of cards()) expect(c).toHaveAttribute('data-ready', 'true')
    expect(within(card('meeting')).getByTestId('guide-status')).toHaveTextContent('Ready')
  })

  it('puts ready apps first and tells a member what an admin has to add', async () => {
    noKeys()
    serveOrg({ admin: false })
    renderApp('/settings/101')
    await screen.findByTestId('settings-guide')
    const ready = cards().map((c) => c.getAttribute('data-ready'))
    expect(ready.indexOf('false')).toBeGreaterThan(0)
    expect(ready.slice(ready.indexOf('false'))).not.toContain('true')
    const meetings = card('meeting')
    expect(within(meetings).getByTestId('guide-status')).toHaveTextContent(
      'Needs a speech-to-text key and an AI key: ask an admin',
    )
    expect(within(meetings).queryByTestId('guide-add-key')).toBeNull()
  })

  it('gives an admin the way to add the key', async () => {
    noKeys()
    serveOrg({ admin: true })
    renderApp('/settings/101')
    await screen.findByTestId('settings-guide')
    const assistant = card('assistant')
    await waitFor(() =>
      expect(within(assistant).getByTestId('guide-add-key')).toHaveAttribute(
        'href',
        '/settings/organization/ai',
      ),
    )
    expect(within(assistant).getByTestId('guide-status')).not.toHaveTextContent('ask an admin')
  })

  it('sends Dictate to the Mac app download in a browser', async () => {
    serveOrg({ admin: false })
    renderApp('/settings/101')
    await screen.findByTestId('settings-guide')
    expect(within(card('dictate')).getByTestId('guide-open')).toHaveAttribute(
      'href',
      '/settings/apps#mac-app',
    )
  })
})
