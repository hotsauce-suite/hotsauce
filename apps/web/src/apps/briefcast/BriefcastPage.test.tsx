import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'

describe('Briefcast page (R10)', () => {
  it('starts empty, makes today’s briefing, plays it with a speed choice and shows the script', async () => {
    const user = userEvent.setup()
    renderApp('/briefcast')
    expect(await screen.findByTestId('briefcast-empty')).toBeInTheDocument()
    // Its own place in the rail.
    expect(screen.getAllByRole('link', { name: /Briefcast/ }).length).toBeGreaterThan(0)

    await user.click(screen.getByTestId('briefcast-make'))
    const episode = await screen.findByTestId('briefcast-episode')
    expect(within(episode).getByRole('heading', { name: /^Briefcast for / })).toBeInTheDocument()
    expect(screen.getByTestId('briefcast-script')).toHaveTextContent(/Good morning, /)
    const audio = (await screen.findByTestId('briefcast-audio')) as HTMLAudioElement
    expect(audio.tagName).toBe('AUDIO')

    const speeds = screen.getByRole('group', { name: 'Playback speed' })
    await user.click(within(speeds).getByRole('button', { name: '1.5×' }))
    expect(within(speeds).getByRole('button', { name: '1.5×' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('says so when there is nothing to brief on', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/briefcast/refresh', () =>
        HttpResponse.json({ status: 'empty', episode: null }),
      ),
    )
    renderApp('/briefcast')
    // The button is disabled until the page has loaded.
    await screen.findByTestId('briefcast-empty')
    await user.click(screen.getByTestId('briefcast-make'))
    expect(await screen.findByTestId('briefcast-message')).toHaveTextContent(
      /Nothing to brief you on/,
    )
  })

  it('shows a refusal', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/briefcast/refresh', () =>
        HttpResponse.json(
          {
            error: {
              code: 'rate_limited',
              message: 'A Briefcast was just made. Try again in a minute.',
            },
          },
          { status: 429 },
        ),
      ),
    )
    renderApp('/briefcast')
    // The button is disabled until the page has loaded.
    await screen.findByTestId('briefcast-empty')
    await user.click(screen.getByTestId('briefcast-make'))
    expect(await screen.findByTestId('briefcast-error')).toHaveTextContent(/just made/)
  })

  it('makes, copies and turns off the private podcast feed', async () => {
    const user = userEvent.setup()
    renderApp('/briefcast')
    await user.click(await screen.findByTestId('briefcast-feed-make'))
    const url = (await screen.findByTestId('briefcast-feed-url')) as HTMLInputElement
    expect(url.value).toMatch(/^https:\/\/.*\/api\/briefcast\/feed\/.+\.xml$/)
    expect(screen.getByRole('link', { name: 'Open in Apple Podcasts' })).toHaveAttribute(
      'href',
      `podcast://${url.value.replace(/^https:\/\//, '')}`,
    )
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByTestId('briefcast-feed-make')).toBeInTheDocument()
  })

  it('lists past briefings and opens one', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/briefcast', () =>
        HttpResponse.json({
          episodes: [
            {
              date: '2026-11-12',
              title: 'Briefcast for Thursday, November 12',
              generated: '2026-11-12T11:00:00Z',
              seconds: 300,
              audio: true,
            },
            {
              date: '2026-11-11',
              title: 'Briefcast for Wednesday, November 11',
              generated: '2026-11-11T11:00:00Z',
              seconds: null,
              audio: false,
            },
          ],
          latest: {
            date: '2026-11-12',
            title: 'Briefcast for Thursday, November 12',
            generated: '2026-11-12T11:00:00Z',
            seconds: 300,
            audio: true,
            script: 'Today.',
            audioExpired: false,
            model: 'm',
            voice: 'v',
            counts: { events: 1, meetings: 0, tasks: 0, docs: 0 },
          },
          feedUrl: null,
          voice: true,
          readyHour: 6,
        }),
      ),
      http.get('/api/briefcast/episodes/2026-11-11', () =>
        HttpResponse.json({
          date: '2026-11-11',
          title: 'Briefcast for Wednesday, November 11',
          generated: '2026-11-11T11:00:00Z',
          seconds: null,
          audio: false,
          script: 'Yesterday’s script.',
          audioExpired: true,
          model: 'm',
          voice: '',
          counts: { events: 0, meetings: 1, tasks: 0, docs: 0 },
        }),
      ),
    )
    renderApp('/briefcast')
    const past = await screen.findByTestId('briefcast-past')
    expect(within(past).getByText('Script')).toBeInTheDocument()
    await user.click(within(past).getByRole('link', { name: /Wednesday, November 11/ }))
    expect(await screen.findByText('Yesterday’s script.')).toBeInTheDocument()
    expect(screen.getByTestId('briefcast-no-audio')).toHaveTextContent(/deleted after 30 days/)
  })
})
