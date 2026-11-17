// Placing fields on a PDF's pages (docs/PLAN-sign.md R9). Positions are fractions of the page from
// its top-left corner, as the envelope file keeps them, so they don't depend on the screen.

import type { SignField, SignFieldType } from '../../api/sign'

export const FIELD_LABEL: Record<SignFieldType, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date signed',
  text: 'Text',
  checkbox: 'Checkbox',
}

export const FIELD_TYPES = Object.keys(FIELD_LABEL) as SignFieldType[]

/** A new field's size in points, before it's turned into fractions of its page. */
const SIZE_PT: Record<SignFieldType, { w: number; h: number }> = {
  signature: { w: 180, h: 44 },
  initials: { w: 70, h: 40 },
  date: { w: 110, h: 24 },
  text: { w: 180, h: 24 },
  checkbox: { w: 18, h: 18 },
}

/** The smallest a field may be, as the format allows. */
const MIN_W = 0.01
const MIN_H = 0.005

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const tidy = (n: number) => Math.round(n * 10_000) / 10_000

/** Keeps a field whole and on its page: at least the smallest size, never past an edge. */
export function keepOnPage<T extends Pick<SignField, 'x' | 'y' | 'width' | 'height'>>(f: T): T {
  const width = tidy(clamp(f.width, MIN_W, 1))
  const height = tidy(clamp(f.height, MIN_H, 1))
  return {
    ...f,
    width,
    height,
    x: tidy(clamp(f.x, 0, 1 - width)),
    y: tidy(clamp(f.y, 0, 1 - height)),
  }
}

/** The next free field id: f1, f2, … */
export function nextFieldId(fields: readonly Pick<SignField, 'id'>[]): string {
  const used = new Set(fields.map((f) => f.id))
  let n = fields.length + 1
  while (used.has(`f${n}`)) n++
  return `f${n}`
}

/**
 * A new field of `type` for `signer`, centred where the member clicked (`at`, as fractions of
 * the page), sized for a page of `pageSize` points.
 */
export function newField(
  type: SignFieldType,
  signer: string,
  page: number,
  at: { x: number; y: number },
  pageSize: { width: number; height: number },
  existing: readonly Pick<SignField, 'id'>[],
): SignField {
  const size = SIZE_PT[type]
  const width = size.w / pageSize.width
  const height = size.h / pageSize.height
  return keepOnPage({
    id: nextFieldId(existing),
    signer,
    type,
    page,
    x: at.x - width / 2,
    y: at.y - height / 2,
    width,
    height,
    required: type !== 'checkbox',
  })
}

/** The field moved by a fraction of its page, kept on the page. */
export function moveField<T extends Pick<SignField, 'x' | 'y' | 'width' | 'height'>>(
  f: T,
  dx: number,
  dy: number,
): T {
  return keepOnPage({ ...f, x: f.x + dx, y: f.y + dy })
}

/** The field resized from its bottom-right corner, kept on the page. */
export function resizeField<T extends Pick<SignField, 'x' | 'y' | 'width' | 'height'>>(
  f: T,
  dw: number,
  dh: number,
): T {
  return keepOnPage({
    ...f,
    width: Math.min(f.width + dw, 1 - f.x),
    height: Math.min(f.height + dh, 1 - f.y),
  })
}

/** Only where a field sits, for saving a draft: filled-in values come when someone signs. */
export function placement(f: SignField): SignField {
  const { value: _v, checked: _c, input: _i, image: _img, filled_at: _f, ...rest } = f
  return rest as SignField
}
