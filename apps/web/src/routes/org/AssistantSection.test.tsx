import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { AssistantSettings, MemberUsage } from '../../api/assistant'
import { server } from '../../test/mockServer'
import { AssistantSection } from './AssistantSection'

const models = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (fast, recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (smartest)' },
]

function serve(settings: Partial<AssistantSettings>, members: MemberUsage[]) {
  let current: AssistantSettings = {
    model: 'claude-sonnet-5-5',
    monthlyLimitUsd: 0,
    models,
    fromEnv: { model: false, monthlyLimitUsd: false },
    ...settings,
  }
  const saves: unknown[] = []
  server.use(
    http.get('*/api/assistant/settings', () => HttpResponse.json(current)),
    http.put('*/api/assistant/settings', async ({ request }) => {
      const patch = (await request.json()) as Partial<AssistantSettings>
      saves.push(patch)
      current = { ...current, ...patch }
      return HttpResponse.json(current)
    }),
    http.get('*/api/assistant/usage', () => HttpResponse.json({ month: '2026-11', members })),
  )
  return saves
}

const bob: MemberUsage = {
  email: 'bob@example.com',
  name: 'Bob',
  questions: 12,
  input: 40000,
  output: 3000,
  costUsd: 1.234,
}

describe('Settings → Organization → Assistant', () => {
  it('saves the model and the monthly limit', async () => {
    const saves = serve({}, [])
    render(<AssistantSection />)
    const select = await screen.findByTestId('assistant-model')
    await waitFor(() => expect(select).toHaveValue('claude-sonnet-5-5'))
    await userEvent.selectOptions(select, 'claude-opus-5-5')
    await userEvent.type(screen.getByTestId('assistant-limit'), '20')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/It applies at once/)).toBeInTheDocument()
    expect(saves).toEqual([{ model: 'claude-opus-5-5', monthlyLimitUsd: 20 }])
    expect(screen.getByTestId('assistant-usage-empty')).toBeInTheDocument()
  })

  it('shows each member’s use this month and a total', async () => {
    serve({}, [bob, { ...bob, email: 'cy@example.com', name: '', questions: 1, costUsd: 0.004 }])
    render(<AssistantSection />)
    const table = await screen.findByTestId('assistant-usage')
    expect(table).toHaveTextContent('Bob12$1.23')
    expect(table).toHaveTextContent('cy@example.com1under $0.01')
    expect(table).toHaveTextContent('Everyone13$1.24')
  })

  it('locks what the environment sets and leaves it out of the save', async () => {
    const saves = serve(
      { model: 'claude-opus-5-5', fromEnv: { model: true, monthlyLimitUsd: false } },
      [],
    )
    render(<AssistantSection />)
    const select = await screen.findByTestId('assistant-model')
    await waitFor(() => expect(select).toBeDisabled())
    expect(screen.getByText(/set by the server’s environment/)).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('assistant-limit'), '5')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saves).toEqual([{ monthlyLimitUsd: 5 }]))
  })
})
