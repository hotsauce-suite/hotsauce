import { deflateSync } from 'node:zlib'
import { expect, test } from './fixtures'

// docs/PLAN-rail-account-menu.md R12, R13: a member adds a profile photo from the account menu; it
// shows on the rail at once, is still there after a reload, and can be removed.

/** A real PNG: `size` pixels square, one flat colour. */
function png(size: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size, 0)
  head.writeUInt32BE(size, 4)
  head.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0)])
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('a member adds a profile photo, keeps it across a reload, and removes it', async ({
  page,
}) => {
  await page.goto('/docs')
  const face = page.getByTestId('account-menu').getByTestId('member-face')
  await expect(face).not.toHaveAttribute('data-photo', '')

  await page.getByTestId('account-menu').click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('photo-change').click()
  await (await chooser).setFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: png(640, [30, 120, 90]),
  })
  await expect(face).toHaveAttribute('data-photo', '')
  // The menu stayed open through the file dialog, and now offers to remove it.
  await expect(page.getByTestId('photo-remove')).toBeVisible()
  // What's kept is the small square, not the original.
  const kept = await face.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)
  expect(kept).toBe(256)

  await page.reload()
  await expect(page.getByTestId('account-menu').getByTestId('member-face')).toHaveAttribute(
    'data-photo',
    '',
  )

  await page.getByTestId('account-menu').click()
  await page.getByTestId('photo-remove').click()
  await expect(page.getByTestId('account-menu').getByTestId('member-face')).not.toHaveAttribute(
    'data-photo',
    '',
  )
})
