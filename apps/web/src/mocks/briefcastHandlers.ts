// MSW routes for `/api/briefcast` (docs/plans/2026-11-12-briefcast.md), in memory, so the page
// works in dev and tests. The "audio" is a second of silent MP3.

import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { BriefcastOverview, Episode } from '../api/briefcast'
import type { FakeUser } from './fakeRepo'

function silentMp3(frames: number): Uint8Array {
  const out = new Uint8Array(417 * frames)
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0xc4], f * 417)
  return out
}

export class FakeBriefcasts {
  readonly #episodes = new Map<string, Episode[]>()
  readonly #feeds = new Map<string, string>()

  overview(email: string): BriefcastOverview {
    const episodes = this.#episodes.get(email) ?? []
    return {
      episodes: episodes.map(({ date, title, generated, seconds, audio }) => ({
        date,
        title,
        generated,
        seconds,
        audio,
      })),
      latest: episodes[0] ?? null,
      feedUrl: this.#feeds.get(email) ?? null,
      voice: true,
      readyHour: 6,
    }
  }

  episode(email: string, date: string): Episode | null {
    return (this.#episodes.get(email) ?? []).find((e) => e.date === date) ?? null
  }

  write(user: FakeUser, meetings: number, now = new Date()): Episode {
    const date = now.toISOString().slice(0, 10)
    const label = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })
    const episode: Episode = {
      date,
      title: `Briefcast for ${label}`,
      generated: now.toISOString(),
      seconds: 1,
      audio: true,
      audioExpired: false,
      script: `Good morning, ${user.name.split(' ')[0]}. It’s ${label}.\n\nYou have ${meetings} recent meetings to catch up on.\n\nHave a good day.`,
      model: 'fake',
      voice: 'fake',
      counts: { events: 0, meetings, tasks: 0, docs: 0 },
    }
    const rest = (this.#episodes.get(user.email) ?? []).filter((e) => e.date !== date)
    this.#episodes.set(user.email, [episode, ...rest])
    return episode
  }

  /** Test helper: an older episode, to show the past list. */
  add(email: string, episode: Episode): void {
    const list = [...(this.#episodes.get(email) ?? []), episode]
    this.#episodes.set(
      email,
      list.sort((a, b) => b.date.localeCompare(a.date)),
    )
  }

  makeFeed(email: string): string {
    const url = `https://hearth.example.test/api/briefcast/feed/${Math.random().toString(36).slice(2).padEnd(24, 'x')}.xml`
    this.#feeds.set(email, url)
    return url
  }

  removeFeed(email: string): void {
    this.#feeds.delete(email)
  }
}

export function briefcastHandlers(deps: {
  briefcasts: FakeBriefcasts
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
  meetingCount: (user: FakeUser) => number
}): AnyHandler[] {
  const { briefcasts, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  return [
    http.get('/api/briefcast', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      await wait()
      return HttpResponse.json(briefcasts.overview(user.email))
    }),
    http.post('/api/briefcast/refresh', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      await wait()
      const meetings = deps.meetingCount(user)
      if (meetings === 0) return HttpResponse.json({ status: 'empty', episode: null })
      return HttpResponse.json({ status: 'written', episode: briefcasts.write(user, meetings) })
    }),
    http.get('/api/briefcast/episodes/:date', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const episode = briefcasts.episode(user.email, String(params.date))
      return episode
        ? HttpResponse.json(episode)
        : HttpResponse.json(
            { error: { code: 'not_found', message: 'No Briefcast for that day' } },
            { status: 404 },
          )
    }),
    http.get('/api/briefcast/episodes/:date/audio', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      return new HttpResponse(silentMp3(38), { headers: { 'content-type': 'audio/mpeg' } })
    }),
    http.post('/api/briefcast/feed', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ feedUrl: briefcasts.makeFeed(user.email) })
    }),
    http.delete('/api/briefcast/feed', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      briefcasts.removeFeed(user.email)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}
