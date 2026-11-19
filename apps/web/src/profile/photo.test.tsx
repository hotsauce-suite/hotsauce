import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../test/mockServer'
import { renderApp } from '../test/renderApp'
import { PHOTO_SIZE } from './photo'

// Profile photos in the web app (docs/PLAN-rail-account-menu.md, requirements 12, 13 and 16).

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
const picture = (name = 'me.png', type = 'image/png') =>
  new File([new Uint8Array(PNG_BYTES)], name, { type })

let drawn: unknown[][] = []

beforeEach(() => {
  drawn = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:photo-${++n}`)
  // jsdom has no image decoder or canvas: stand-ins that record the crop.
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 400, height: 300, close() {} })),
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        fillRect() {},
        drawImage: (...args: unknown[]) => drawn.push(args),
      }) as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) =>
    done(new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/jpeg' })),
  )
})

async function openMenu() {
  renderApp('/docs')
  await userEvent.click(await screen.findByTestId('account-menu'))
  return screen.getByRole('menu', { name: 'Account' })
}

/**
 * What the file dialog does once a file is chosen. Not `userEvent.upload`: that clicks the hidden
 * field first, which the menu takes for a click outside it; the real dialog opens with no click.
 */
const pick = (file: File, input = screen.getByTestId('photo-input')) =>
  fireEvent.change(input, { target: { files: [file] } })

const railFace = () => within(screen.getByTestId('account-menu')).getByTestId('member-face')

describe('profile photo', () => {
  it('R12: a picked picture is cropped to a small square, sent, and shown at once', async () => {
    const menu = await openMenu()
    expect(railFace()).not.toHaveAttribute('data-photo')
    expect(within(menu).getByTestId('photo-add')).toHaveTextContent('Add a photo')
    expect(within(menu).queryByTestId('photo-remove')).toBeNull()

    pick(picture())
    // On the rail's button and in the menu, without a reload.
    await waitFor(() => expect(railFace()).toHaveAttribute('data-photo'))
    expect(railFace().querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^blob:/))
    await waitFor(() =>
      expect(within(menu).getByTestId('member-face')).toHaveAttribute('data-photo'),
    )
    expect(within(menu).getByTestId('photo-add')).toHaveTextContent('Change photo')
    // The middle square of the 400 by 300 picture, at the size that's kept.
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.slice(1)).toEqual([50, 0, 300, 300, 0, 0, PHOTO_SIZE, PHOTO_SIZE])
  })

  it('R12: clicking the face opens the file picker', async () => {
    const menu = await openMenu()
    const input = screen.getByTestId('photo-input') as HTMLInputElement
    const opened = vi.spyOn(input, 'click')
    await userEvent.click(within(menu).getByTestId('photo-change'))
    expect(opened).toHaveBeenCalled()
    expect(within(menu).getByTestId('photo-change')).toHaveAccessibleName('Add a photo of yourself')
  })

  it('R13: removing the photo brings the initials back', async () => {
    const menu = await openMenu()
    pick(picture())
    await waitFor(() => expect(railFace()).toHaveAttribute('data-photo'))
    await userEvent.click(within(menu).getByTestId('photo-remove'))
    await waitFor(() => expect(railFace()).not.toHaveAttribute('data-photo'))
    expect(railFace()).toHaveTextContent(/^[A-Z]{1,2}$/)
    expect(within(menu).queryByTestId('photo-remove')).toBeNull()
  })

  it('R16: a file that isn’t a picture is refused in plain words, and nothing is sent', async () => {
    let sent = false
    server.use(
      http.put('/api/me/photo', () => {
        sent = true
        return HttpResponse.json({ photo: null })
      }),
    )
    await openMenu()
    // Past the field's own filter, as an old browser would let it.
    pick(new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }))
    expect(await screen.findByTestId('photo-error')).toHaveTextContent(/choose a picture/i)
    expect(sent).toBe(false)
    expect(railFace()).not.toHaveAttribute('data-photo')
  })

  it('R16: the server’s refusal is shown, and the face stays as it was', async () => {
    server.use(
      http.put('/api/me/photo', () =>
        HttpResponse.json(
          { error: { code: 'bad_request', message: 'Profile photos are limited to 500 KB' } },
          { status: 413 },
        ),
      ),
    )
    await openMenu()
    pick(picture())
    expect(await screen.findByTestId('photo-error')).toHaveTextContent('limited to 500 KB')
    expect(railFace()).not.toHaveAttribute('data-photo')
  })

  it('R12: Settings has the same control beside the account', async () => {
    renderApp('/settings')
    const account = await screen.findByTestId('settings-account', {}, { timeout: 5_000 })
    expect(within(account).getByTestId('settings-photo-change')).toHaveTextContent('Add a photo')
    pick(picture(), within(account).getByTestId('photo-input'))
    await waitFor(() =>
      expect(within(account).getByTestId('member-face')).toHaveAttribute('data-photo'),
    )
    // The rail's button shows it too: one photo, wherever it was changed.
    expect(railFace()).toHaveAttribute('data-photo')
    await userEvent.click(within(account).getByTestId('settings-photo-remove'))
    await waitFor(() =>
      expect(within(account).getByTestId('member-face')).not.toHaveAttribute('data-photo'),
    )
  })
})
