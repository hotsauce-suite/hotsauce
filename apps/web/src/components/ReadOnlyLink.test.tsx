import { fireEvent, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { server } from '../test/mockServer'
import { renderWithSession } from '../test/renderWithSession'
import { forgetLinkSetting, ReadOnlyLinkItems, useReadOnlyLink } from './ReadOnlyLink'

// Making a read-only link asks who it's for and when it ends (docs/PLAN-outside-links.md R1, R5).

function Harness() {
  const link = useReadOnlyLink('team', 'docs/plan.md')
  return (
    <div>
      <button type="button" onClick={() => link.refresh()}>
        refresh
      </button>
      <ReadOnlyLinkItems link={link} close={() => {}} />
      {link.dialog}
    </div>
  )
}

let sent: unknown = null

function serve(allowed: boolean) {
  forgetLinkSetting()
  sent = null
  server.use(
    http.get('/api/sharing', () => HttpResponse.json({ publicShareLinks: allowed })),
    http.get('/api/shares', () => HttpResponse.json({ token: null, url: null, link: null })),
    http.post('/api/shares', async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json({
        token: 'tok_abcdefghijklmnop',
        url: '/s/tok_abcdefghijklmnop',
        link: { anyone: true, expiresAt: '2026-12-17T00:00:00Z', ended: false },
      })
    }),
  )
}

describe('ReadOnlyLink', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: () => Promise.resolve() } })
  })

  it('defaults to members and 30 days, and sends what was picked', async () => {
    serve(true)
    renderWithSession(<Harness />)
    fireEvent.click(await screen.findByTestId('read-only-link-on'))
    await screen.findByTestId('link-dialog')
    expect((screen.getByTestId('link-who-org') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('link-expiry') as HTMLSelectElement).value).toBe('30')
    const anyone = screen.getByTestId('link-who-anyone') as HTMLInputElement
    await waitFor(() => expect(anyone.disabled).toBe(false))
    fireEvent.click(anyone)
    fireEvent.change(screen.getByTestId('link-expiry'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('link-make'))
    await waitFor(() =>
      expect(sent).toEqual({
        space: 'team',
        path: 'docs/plan.md',
        on: true,
        anyone: true,
        expiresDays: 7,
      }),
    )
    expect(await screen.findByTestId('link-about')).toBeTruthy()
    expect(screen.getByTestId('link-about').textContent).toMatch(/^Anyone with the link · ends /)
  })

  it('can’t pick anyone while the organization has it off, and says why', async () => {
    serve(false)
    renderWithSession(<Harness />)
    fireEvent.click(await screen.findByTestId('read-only-link-on'))
    await waitFor(() =>
      expect(screen.getByTestId('link-who-anyone-note').textContent).toMatch(/^Turned off for /),
    )
    expect((screen.getByTestId('link-who-anyone') as HTMLInputElement).disabled).toBe(true)
  })
})
