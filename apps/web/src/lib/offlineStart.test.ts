import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { loadBoot, ServerUnreachable } from '../brand/boot'
import { server } from '../test/mockServer'
import { isOnline } from './connection'
import {
  forgetMember,
  offlineMe,
  rememberedMember,
  rememberedStart,
  rememberMember,
} from './offlineStart'

const principal = {
  userId: 'u1',
  email: 'ada@example.test',
  name: 'Ada',
  handle: 'ada',
  isAdmin: true,
}

describe('offline start (A2)', () => {
  it('remembers only the member’s id, name, email and workspace, and forgets on sign-out', () => {
    rememberMember(principal, 'Acme')
    expect(JSON.parse(localStorage.getItem('hotsauce.offline.member') ?? '{}')).toEqual({
      userId: 'u1',
      name: 'Ada',
      email: 'ada@example.test',
      workspace: 'Acme',
    })
    forgetMember()
    expect(rememberedMember()).toBeNull()
  })

  it('an offline member is never an admin and sees the Team space', () => {
    rememberMember(principal, 'Acme')
    const me = offlineMe(rememberedMember() ?? { userId: '', name: '', email: '', workspace: null })
    expect(me.principal).toMatchObject({ userId: 'u1', email: 'ada@example.test', isAdmin: false })
    expect(me.spaces.map((s) => s.name)).toEqual(['team'])
  })

  it('a normal start keeps the public start-up facts (A2.1)', async () => {
    const health = await loadBoot()
    expect(health.offlineStart).toBeUndefined()
    expect(rememberedStart()?.health.authMode).toBe(health.authMode)
  })

  it('a start that can’t reach the server uses them, offline (A2.3)', async () => {
    const online = await loadBoot()
    server.use(http.get('/api/health', () => HttpResponse.error()))
    const offline = await loadBoot()
    expect(offline.offlineStart).toBe(true)
    expect(offline.authMode).toBe(online.authMode)
    expect(isOnline()).toBe(false)
  })

  it('a server that answers with an error gets the retry page, not an offline start', async () => {
    await loadBoot()
    server.use(http.get('/api/health', () => new HttpResponse('Bad gateway', { status: 502 })))
    await expect(loadBoot()).rejects.toBeInstanceOf(ServerUnreachable)
  })

  it('with nothing kept from a start, it’s the "isn’t reachable" page as before', async () => {
    server.use(http.get('/api/health', () => HttpResponse.error()))
    await expect(loadBoot()).rejects.toBeInstanceOf(ServerUnreachable)
  })
})
