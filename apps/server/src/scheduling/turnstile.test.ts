import { describe, expect, it } from 'vitest'
import { FakeGoogle } from '../meetings/calendar/fake-google.js'
import { GoogleBookingHttp } from './google.js'
import { FakeRobotCheck, Turnstile } from './turnstile.js'

const ALICE = { userId: 'u1', email: 'a@x.test', name: 'A', handle: 'a', isAdmin: false }

describe('Turnstile', () => {
  it('posts the secret, token and IP to siteverify and passes only success: true', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const answer = { success: true }
    const turnstile = new Turnstile({
      siteKey: 'site',
      secret: 'shh',
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: String(init?.body) })
        return Response.json(answer)
      },
    })
    expect(turnstile.widget).toEqual({ kind: 'turnstile', siteKey: 'site' })
    expect(await turnstile.verify('tok', '203.0.113.1')).toBe(true)
    expect(sent[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(new URLSearchParams(sent[0]?.body)).toEqual(
      new URLSearchParams({ secret: 'shh', response: 'tok', remoteip: '203.0.113.1' }),
    )
    answer.success = false
    expect(await turnstile.verify('tok', null)).toBe(false)
    expect(await turnstile.verify('', null)).toBe(false)
    expect(sent).toHaveLength(2) // an empty token isn't sent
  })

  it('a Cloudflare outage is an error, not a pass', async () => {
    const down = new Turnstile({
      siteKey: 's',
      secret: 'k',
      fetch: async () => new Response('', { status: 500 }),
    })
    await expect(down.verify('tok', null)).rejects.toMatchObject({ code: 'host_error' })
  })

  it('the dev stand-in passes only dev-pass', async () => {
    const fake = new FakeRobotCheck()
    expect(await fake.verify('dev-pass')).toBe(true)
    expect(await fake.verify('anything')).toBe(false)
  })
})

describe('GoogleBookingHttp.canWrite', () => {
  it('needs calendar.events; unknown scopes are left to Google', async () => {
    const withScopes = (scopes: string[] | null) =>
      new GoogleBookingHttp({ grant: async () => ({ token: 't', scopes }) })
    expect(
      await withScopes(['https://www.googleapis.com/auth/calendar.readonly']).canWrite(ALICE),
    ).toBe(false)
    expect(
      await withScopes(['https://www.googleapis.com/auth/calendar.events']).canWrite(ALICE),
    ).toBe(true)
    expect(await withScopes(null).canWrite(ALICE)).toBe(true)
    expect(await new GoogleBookingHttp({ grant: async () => null }).canWrite(ALICE)).toBe(false)
  })
})

describe('GoogleBookingHttp.insert', () => {
  it('the same event id twice is a conflict, not a second event', async () => {
    const fake = new FakeGoogle({ seed: false })
    const google = new GoogleBookingHttp({
      grant: async (p) => ({ token: `fake-token:${p.email}`, scopes: null }),
      fetch: fake.fetch,
    })
    const booking = {
      id: 'hbabc123',
      slug: 'intro',
      title: 'Intro: Jo',
      start: '2030-01-07T15:00:00.000Z',
      end: '2030-01-07T15:30:00.000Z',
      description: 'x',
      booker: { name: 'Jo', email: 'jo@x.test' },
      requestId: 'r1',
    }
    expect(await google.insert(ALICE, booking)).toMatchObject({ id: 'hbabc123' })
    await expect(google.insert(ALICE, { ...booking, requestId: 'r2' })).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(fake.requests.filter((r) => r.includes('insert'))).toEqual([
      'a@x.test primary insert sendUpdates=all',
      'a@x.test primary insert duplicate',
    ])
  })
})
