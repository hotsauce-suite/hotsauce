import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PHOTO_BYTES, SignInPhotos, sizedPhotoUrl } from './signInPhotos.js'
import { AccountStore } from './store.js'

/** The sign-in photo as a default (docs/PLAN-rail-account-menu.md, requirement 14). */

const ADA = 'ada@acme.example'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7])
const URL_A = 'https://img.example/a'
const URL_B = 'https://img.example/b'

let dir: string
let account: AccountStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hotsauce-signin-photo-'))
  account = new AccountStore(join(dir, 'account.sqlite'))
})
afterEach(() => {
  account.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sign-in photos', () => {
  it('R14: a member with no photo gets the one from their sign-in, fetched once', async () => {
    const fetchPhoto = vi.fn(async () => PNG)
    const photos = new SignInPhotos(account, fetchPhoto)
    await photos.offer('Ada@Acme.example', URL_A)
    expect(account.getPhoto(ADA)?.type).toBe('image/png')
    expect(new Uint8Array(account.getPhoto(ADA)?.bytes ?? [])).toEqual(PNG)
    await photos.offer(ADA, URL_A)
    expect(fetchPhoto).toHaveBeenCalledTimes(1)
  })

  it('R14: it follows a new sign-in photo, and goes when the sign-in has none', async () => {
    const fetchPhoto = vi.fn(async (url: string) => (url === URL_A ? PNG : JPEG))
    const photos = new SignInPhotos(account, fetchPhoto)
    await photos.offer(ADA, URL_A)
    await photos.offer(ADA, URL_B)
    expect(account.getPhoto(ADA)?.type).toBe('image/jpeg')
    await photos.offer(ADA, null)
    expect(account.getPhoto(ADA)).toBeNull()
  })

  it("R14: a member's own upload is never replaced, and removing it brings the sign-in photo back", async () => {
    const fetchPhoto = vi.fn(async () => PNG)
    const photos = new SignInPhotos(account, fetchPhoto)
    account.setPhoto(ADA, 'image/jpeg', JPEG, new Date())
    await photos.offer(ADA, URL_A)
    expect(account.getPhoto(ADA)?.type).toBe('image/jpeg')
    expect(fetchPhoto).not.toHaveBeenCalled()

    account.deletePhoto(ADA)
    await photos.restore(ADA)
    expect(account.getPhoto(ADA)?.type).toBe('image/png')
  })

  it('R14: restoring with no sign-in photo known leaves none', async () => {
    const photos = new SignInPhotos(account, async () => PNG)
    await photos.restore(ADA)
    expect(account.getPhoto(ADA)).toBeNull()
  })

  it('R16: a sign-in photo that is not an image, is too big or cannot be fetched is left out', async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1)
    big.set(PNG)
    for (const bytes of [new TextEncoder().encode('<svg/>'), big, null]) {
      const photos = new SignInPhotos(account, async () => bytes)
      await photos.offer(ADA, URL_A)
      expect(account.getPhoto(ADA)).toBeNull()
    }
    const failing = new SignInPhotos(account, async () => {
      throw new Error('offline')
    })
    await expect(failing.offer(ADA, URL_A)).resolves.toBeUndefined()
    expect(account.getPhoto(ADA)).toBeNull()
  })

  it('asks the sign-in service for a small square, over https only', () => {
    expect(sizedPhotoUrl('https://img.example/a?x=1')).toBe(
      'https://img.example/a?x=1&width=256&height=256&fit=crop&quality=85',
    )
    expect(sizedPhotoUrl('http://img.example/a')).toBeNull()
    expect(sizedPhotoUrl('not a url')).toBeNull()
  })
})
