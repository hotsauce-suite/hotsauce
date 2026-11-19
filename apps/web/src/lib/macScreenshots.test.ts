import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriveFile } from '../api/files'
import {
  decodePng,
  installMacScreenshots,
  type ScreenshotShareDeps,
  screenshotName,
  shareScreenshot,
} from './macScreenshots'

// docs/PLAN-screenshots.md R5.

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3))

const stored = (over: Partial<DriveFile> = {}): DriveFile =>
  ({
    id: '01JSHOT0000000000000000000',
    space: 'ada',
    name: 'Shot.png',
    shareUrl: null,
    shareLink: null,
    deleteAfter: '2026-12-19T12:00:00Z',
    ...over,
  }) as DriveFile

function deps(over: Partial<ScreenshotShareDeps> = {}): ScreenshotShareDeps {
  return {
    personalSpace: async () => 'ada',
    origin: 'https://hotsauce.example',
    publicLinksAllowed: async () => true,
    upload: vi.fn(async () => stored()),
    share: vi.fn(async (_s, _i, _on, choice) =>
      stored({
        shareUrl: choice.anyone ? '/s/tok' : '/files/s/tok',
        shareLink: { anyone: choice.anyone, expiresAt: '2026-12-19T12:00:00Z', ended: false },
      }),
    ),
    ...over,
  }
}

afterEach(() => {
  delete (window as { hotsauceMac?: unknown }).hotsauceMac
})

describe('sharing a screenshot from the Mac app', () => {
  it('uploads to personal Screenshots for 30 days and answers with a public link', async () => {
    const d = deps()
    const result = await shareScreenshot(d, 'Screenshot 2026-11-19 at 14.30.05.png', PNG)
    expect(result).toEqual({
      ok: true,
      url: 'https://hotsauce.example/s/tok',
      anyone: true,
      deleteAfter: '2026-12-19T12:00:00Z',
    })
    const [file, target] = vi.mocked(d.upload).mock.calls[0] ?? []
    expect(file?.name).toBe('Screenshot 2026-11-19 at 14.30.05.png')
    expect(file?.type).toBe('image/png')
    expect(file?.size).toBe(11)
    expect(target).toEqual({ space: 'ada', folder: 'Screenshots', deleteAfterDays: 30 })
    expect(d.share).toHaveBeenCalledWith('ada', '01JSHOT0000000000000000000', true, {
      anyone: true,
      expiresDays: 30,
    })
  })

  it('makes a members-only link when the organization keeps links inside', async () => {
    for (const publicLinksAllowed of [
      async () => false,
      async () => {
        throw new Error('offline')
      },
    ]) {
      const result = await shareScreenshot(deps({ publicLinksAllowed }), 'a.png', PNG)
      expect(result).toMatchObject({
        ok: true,
        anyone: false,
        url: 'https://hotsauce.example/files/s/tok',
      })
    }
  })

  it('falls back to a members link when a public one is refused', async () => {
    const share = vi.fn(
      async (_s: string, _i: string, _on: boolean, choice: { anyone: boolean }) => {
        if (choice.anyone) throw new Error('Links anyone can open are turned off')
        return stored({
          shareUrl: '/files/s/tok',
          shareLink: { anyone: false, expiresAt: '2026-12-19T12:00:00Z', ended: false },
        })
      },
    )
    const result = await shareScreenshot(deps({ share }), 'a.png', PNG)
    expect(result).toMatchObject({ ok: true, anyone: false })
    expect(share).toHaveBeenCalledTimes(2)
  })

  it('says why instead of throwing', async () => {
    expect(await shareScreenshot(deps({ personalSpace: async () => null }), 'a.png', PNG)).toEqual({
      ok: false,
      error: 'Sign in to Hotsauce to share a screenshot.',
    })
    const d = deps()
    for (const bad of ['not base64 !!', btoa('GIF89a not a png'), '', 42, null]) {
      expect((await shareScreenshot(d, 'a.png', bad)).ok).toBe(false)
    }
    expect(d.upload).not.toHaveBeenCalled()
    const failing = deps({
      upload: async () => {
        throw new Error('The server’s disk is too full for this upload right now.')
      },
    })
    expect(await shareScreenshot(failing, 'a.png', PNG)).toEqual({
      ok: false,
      error: 'The server’s disk is too full for this upload right now.',
    })
  })

  it('cleans the name', () => {
    expect(screenshotName('a/b\\c.PNG')).toBe('a b c.png')
    expect(screenshotName('')).toBe('Screenshot.png')
    expect(screenshotName(undefined)).toBe('Screenshot.png')
    expect(screenshotName('x'.repeat(400)).length).toBe(154)
    expect(decodePng(PNG)?.length).toBe(11)
  })

  it('is installed where the Mac app looks, and removed again', async () => {
    const remove = installMacScreenshots(() => deps())
    const hooks = (window as { hotsauceMac?: { shareScreenshot?: (...a: unknown[]) => unknown } })
      .hotsauceMac
    expect(await hooks?.shareScreenshot?.('a.png', PNG)).toMatchObject({ ok: true })
    remove()
    expect(hooks?.shareScreenshot).toBeUndefined()
  })
})
