import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PHOTO_BYTES } from '../../src/api/photo.js'
import { createApp } from '../../src/app.js'
import { type Config, loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

/** Profile photos (docs/PLAN-rail-account-menu.md, requirements 12, 13 and 16). */

const ALICE = 'alice@acme.example'
const BOB = 'bob@acme.example'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 9, 9])
const WEBP = Uint8Array.from([
  ...Buffer.from('RIFF'),
  4,
  0,
  0,
  0,
  ...Buffer.from('WEBP'),
  ...Buffer.from('VP8 '),
])

/** What the member's sign-in has for a picture; null for none. */
let signInPicture: Uint8Array | null = null

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  signInPicture = null
  root = await makeTempDir('hotsauce-photo-')
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'acme.example',
  })
  services = createServices(config, { photoFetch: async () => signInPicture })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  services.index.close()
  services.account.close()
  await removeDir(root)
})

const as = (user: string) => ({ 'x-hearth-dev-user': user })

function put(bytes: Uint8Array<ArrayBuffer>, type: string, user = ALICE) {
  return app.request('/api/me/photo', {
    method: 'PUT',
    headers: { ...as(user), 'content-type': type },
    body: bytes,
  })
}

async function me(user = ALICE): Promise<{ photo: string | null }> {
  const res = await app.request('/api/me', { headers: as(user) })
  // biome-ignore lint/suspicious/noExplicitAny: test reads loosely shaped JSON
  return (await res.json()) as any
}

describe('profile photos', () => {
  it('R12: a member with no photo has none; an upload shows at once, to them and to others', async () => {
    expect((await me()).photo).toBeNull()

    const res = await put(PNG, 'image/png')
    expect(res.status).toBe(200)
    const { photo } = (await res.json()) as { photo: string }
    expect(photo).toMatch(/^\/api\/members\/alice%40acme\.example\/photo\?v=[0-9a-f]+$/)
    expect((await me()).photo).toBe(photo)

    // Another member sees it, as the image that was sent, and may keep it: its address changes
    // when the photo does.
    const got = await app.request(photo, { headers: as(BOB) })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG)
    // Bob's own stays empty.
    expect((await me(BOB)).photo).toBeNull()
  })

  it('R12: a new photo replaces the old one under a new address', async () => {
    const first = ((await (await put(PNG, 'image/png')).json()) as { photo: string }).photo
    const second = ((await (await put(JPEG, 'image/jpeg')).json()) as { photo: string }).photo
    expect(second).not.toBe(first)
    const got = await app.request(second, { headers: as(ALICE) })
    expect(got.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG)
    expect((await put(WEBP, 'image/webp')).status).toBe(200)
  })

  it('R13: removing the photo brings back none', async () => {
    const { photo } = (await (await put(PNG, 'image/png')).json()) as { photo: string }
    const res = await app.request('/api/me/photo', { method: 'DELETE', headers: as(ALICE) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ photo: null })
    expect((await me()).photo).toBeNull()
    expect((await app.request(photo, { headers: as(ALICE) })).status).toBe(404)
  })

  it('R16: only an image is taken, by what the bytes are and not what they claim', async () => {
    const text = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    for (const type of ['image/svg+xml', 'image/png', 'text/html']) {
      const res = await put(text, type)
      expect(res.status, type).toBe(400)
    }
    expect((await put(new Uint8Array(0), 'image/png')).status).toBe(400)
    expect((await me()).photo).toBeNull()
    // A PNG sent as a JPEG is served as what it is.
    const { photo } = (await (await put(PNG, 'image/jpeg')).json()) as { photo: string }
    const got = await app.request(photo, { headers: as(ALICE) })
    expect(got.headers.get('content-type')).toBe('image/png')
  })

  it('R16: a photo that is too big is refused, and the old one stays', async () => {
    const { photo } = (await (await put(PNG, 'image/png')).json()) as { photo: string }
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1)
    big.set(PNG)
    const res = await put(big, 'image/png')
    expect(res.status).toBe(413)
    expect((await me()).photo).toBe(photo)
  })

  it('R16: nobody without a session sees or changes a photo', async () => {
    const { photo } = (await (await put(PNG, 'image/png')).json()) as { photo: string }
    expect((await app.request(photo)).status).toBe(401)
    const res = await app.request('/api/me/photo', { method: 'PUT', body: PNG })
    expect(res.status).toBe(401)
  })

  it('a member with no photo is simply not found', async () => {
    const res = await app.request(`/api/members/${encodeURIComponent(BOB)}/photo`, {
      headers: as(ALICE),
    })
    expect(res.status).toBe(404)
  })

  it('R14: the sign-in picture stands in until an upload, and comes back when the upload is removed', async () => {
    signInPicture = JPEG
    await services.signInPhotos.offer(ALICE, 'https://img.example/alice')
    const first = (await me()).photo
    expect(first).toMatch(/photo\?v=/)
    const got = await app.request(first as string, { headers: as(BOB) })
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG)

    const { photo: own } = (await (await put(PNG, 'image/png')).json()) as { photo: string }
    expect(own).not.toBe(first)
    // Sign-in saying so again changes nothing while her own photo is there.
    await services.signInPhotos.offer(ALICE, 'https://img.example/alice')
    expect((await me()).photo).toBe(own)

    const res = await app.request('/api/me/photo', { method: 'DELETE', headers: as(ALICE) })
    expect(await res.json()).toEqual({ photo: first })
    expect((await me()).photo).toBe(first)
  })

  it('R15: members can see who has a photo, and nobody else can', async () => {
    const list = async (user?: string) =>
      app.request('/api/members/photos', user ? { headers: as(user) } : {})
    expect(await (await list(BOB)).json()).toEqual({ photos: {} })
    const { photo } = (await (await put(PNG, 'image/png')).json()) as { photo: string }
    expect(await (await list(BOB)).json()).toEqual({ photos: { [ALICE]: photo } })
    expect((await list()).status).toBe(401)
  })
})
