import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../api/updates'
import { server } from '../../test/mockServer'
import { UpdatesSection } from './UpdatesSection'

const base: UpdateStatus = {
  current: '0.2.0',
  latest: {
    version: '0.3.0',
    notes: '- Tables can sort by date',
    url: 'https://github.com/hotsauce-suite/hotsauce/releases/tag/v0.3.0',
    publishedAt: '2026-11-12T00:00:00Z',
  },
  updateAvailable: true,
  checkedAt: '2026-11-12T00:00:00Z',
  mode: 'fly',
  auto: true,
  updating: null,
  failed: null,
  flyApp: 'acme-office',
}

function serve(status: UpdateStatus) {
  let current = status
  server.use(
    http.get('*/api/admin/org/updates', () => HttpResponse.json(current)),
    http.post('*/api/admin/org/updates/start', () => {
      current = { ...current, updating: { from: '0.2.0', to: '0.3.0', at: 'now' } }
      return HttpResponse.json(current)
    }),
    http.put('*/api/admin/org/updates/auto', async ({ request }) => {
      const { on } = (await request.json()) as { on: boolean }
      current = { ...current, auto: on }
      return HttpResponse.json(current)
    }),
  )
}

describe('Settings → Organization → Updates', () => {
  it('shows the new release with its notes, and Update starts it', async () => {
    serve(base)
    render(<UpdatesSection />)
    const card = await screen.findByTestId('update-available')
    expect(card).toHaveTextContent('Version 0.3.0 is out')
    expect(card).toHaveTextContent('Tables can sort by date')
    await userEvent.click(screen.getByTestId('update-now'))
    expect(await screen.findByTestId('update-running')).toHaveTextContent('Updating to 0.3.0')
    expect(screen.queryByTestId('update-now')).toBeNull()
  })

  it('turns automatic updates off', async () => {
    serve(base)
    render(<UpdatesSection />)
    const box = await screen.findByTestId('auto-updates')
    expect(box).toBeChecked()
    await userEvent.click(box)
    await waitFor(() => expect(screen.getByTestId('auto-updates')).not.toBeChecked())
  })

  it('says when an update was rolled back', async () => {
    serve({ ...base, failed: { from: '0.2.0', to: '0.3.0', at: 'then' } })
    render(<UpdatesSection />)
    expect(await screen.findByTestId('update-failed')).toHaveTextContent(
      'Updating to 0.3.0 didn’t work',
    )
  })

  it('gives the steps instead of a button where the server can’t update itself', async () => {
    serve({ ...base, mode: 'manual' })
    render(<UpdatesSection />)
    expect(await screen.findByTestId('update-steps')).toHaveTextContent('docker compose pull')
    expect(screen.queryByTestId('update-now')).toBeNull()
    expect(screen.getByTestId('auto-updates')).toBeDisabled()
  })

  it('on Fly without a token, shows the command with the app’s name', async () => {
    serve({ ...base, mode: 'fly-needs-token' })
    render(<UpdatesSection />)
    expect(await screen.findByTestId('update-steps')).toHaveTextContent(
      'fly secrets set -a acme-office FLY_API_TOKEN="$(fly tokens create deploy -a acme-office)"',
    )
  })

  it('says it is the newest release when nothing is newer', async () => {
    serve({
      ...base,
      updateAvailable: false,
      latest: base.latest && { ...base.latest, version: '0.2.0' },
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/It’s the newest release/)).toBeInTheDocument()
  })
})
