// Gathers what a download needs in the browser (docs/PLAN-doc-download.md): the brand, its fonts
// as TTF from the server, every image as PNG or JPEG bytes, and each task list's tasks now.

import { resolveRelative } from '@hotsauce/format'
import { api } from '../../api/client'
import { memberTimeZone, tasksApi } from '../../api/tasks'
import type { PublicBrand } from '../../api/types'
import { org } from '../../brand/product'
import { fileUrl, isBoardFile, isExternalHref } from '../paths'
import { applyTaskQuery, parseTaskQuery } from '../taskQuery'
import type { BrandLook, DownloadInputs, FontFiles, ReadyImage, TaskLine } from './inputs'
import { type DocModel, docModel, imageSources, taskSources } from './model'

const DEFAULT_BRAND: BrandLook = {
  orgName: '',
  primary: '#c63d19',
  displayFont: 'Fraunces',
  uiFont: 'IBM Plex Sans',
  logo: null,
}

/** Links in the file must work outside Hotsauce: doc links point at the doc here. */
export function linkResolver(space: string, path: string, origin: string) {
  return (href: string): string => {
    // Only links a reader can safely open: never javascript: or data:.
    if (/^(https?:|mailto:)/i.test(href)) return href
    if (isExternalHref(href) || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return ''
    const target = resolveRelative(path, href.split('#')[0] ?? '')
    // Each kind of file opens on its own page: a doc, a meeting note, a task, a file.
    return target ? `${origin}${fileUrl(space, target)}` : ''
  }
}

async function font(family: string, weight: 400 | 700, style: 'normal' | 'italic') {
  try {
    const q = new URLSearchParams({ family, weight: String(weight), style })
    const res = await fetch(`/api/org/fonts?${q}`)
    if (!res.ok) return undefined
    const bytes = new Uint8Array(await res.arrayBuffer())
    return isTrueType(bytes) ? bytes : undefined
  } catch {
    return undefined
  }
}

/** A TrueType or OpenType file, not a page a static host answered with instead (the demo). */
export function isTrueType(bytes: Uint8Array): boolean {
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  return tag === '\u0000\u0001\u0000\u0000' || tag === 'true' || tag === 'OTTO'
}

async function fontFiles(family: string): Promise<FontFiles> {
  const [regular, bold, italic, boldItalic] = await Promise.all([
    font(family, 400, 'normal'),
    font(family, 700, 'normal'),
    font(family, 400, 'italic'),
    font(family, 700, 'italic'),
  ])
  return {
    ...(regular ? { regular } : {}),
    ...(bold ? { bold } : {}),
    ...(italic ? { italic } : {}),
    ...(boldItalic ? { boldItalic } : {}),
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image did not load'))
    img.src = url
  })
}

/** PNG and JPEG go in as they are; anything else (GIF, WebP, SVG, a board) is drawn as a PNG. */
export async function readyImage(blob: Blob, scale = 1): Promise<ReadyImage> {
  const kind = blob.type.toLowerCase()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const head = bytes.subarray(0, 4)
  const isPng = head[0] === 0x89 && head[1] === 0x50
  const isJpg = head[0] === 0xff && head[1] === 0xd8
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const width = img.naturalWidth || 600
    const height = img.naturalHeight || 400
    if ((isPng || isJpg) && scale === 1)
      return { bytes, type: isPng ? 'png' : 'jpg', width, height }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    if (kind.includes('svg')) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no png'))), 'image/png'),
    )
    // Sized as it shows on screen; the extra pixels only make it sharper.
    return { bytes: new Uint8Array(await png.arrayBuffer()), type: 'png', width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function dataUrlBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob()
}

async function image(space: string, path: string, src: string): Promise<ReadyImage | null> {
  try {
    if (isExternalHref(src)) {
      // Another site's image: only if it allows it (CORS); otherwise its alt text stands in.
      const res = await fetch(src, { mode: 'cors', credentials: 'omit' })
      if (!res.ok) return null
      return await readyImage(await res.blob())
    }
    const repoPath = resolveRelative(path, src)
    if (isBoardFile(repoPath)) {
      const { boardPreviewUrl } = await import('../../apps/boards/boardPreview')
      const svg = await dataUrlBlob(await boardPreviewUrl(space, repoPath, { light: true }))
      return await readyImage(new Blob([svg], { type: 'image/svg+xml' }), 2)
    }
    return await readyImage(await api.raw(space, repoPath))
  } catch {
    return null
  }
}

async function brandLook(): Promise<BrandLook> {
  let brand: PublicBrand | null = null
  try {
    brand = await api.brand()
  } catch {
    // Offline: the default look.
  }
  if (!brand) return { ...DEFAULT_BRAND, orgName: org() }
  let logo: ReadyImage | null = null
  const logoUrl = brand.logoUrl ?? brand.markUrl
  if (logoUrl) {
    try {
      const res = await fetch(logoUrl)
      if (res.ok) logo = await readyImage(await res.blob(), 2)
    } catch {
      logo = null
    }
  }
  return {
    orgName: brand.orgName || org(),
    primary: /^#[0-9a-f]{6}$/i.test(brand.primary) ? brand.primary : DEFAULT_BRAND.primary,
    displayFont: brand.fonts.display,
    uiFont: brand.fonts.ui,
    logo,
  }
}

async function taskLines(source: string, personalSpace: string | null): Promise<TaskLine[]> {
  try {
    const query = parseTaskQuery(source, memberTimeZone())
    if (query.filter.space?.toLowerCase() === 'personal' && personalSpace) {
      query.filter.space = personalSpace
    }
    const tasks = applyTaskQuery(query, await tasksApi.list(query.filter))
    return tasks.map((t) => ({ title: t.title, done: t.status === 'done' }))
  } catch {
    return []
  }
}

export interface PreparedDownload {
  model: DocModel
  inputs: DownloadInputs
}

export async function prepareDownload(options: {
  space: string
  path: string
  markdown: string
  title: string
  personalSpace: string | null
}): Promise<PreparedDownload> {
  const { space, path, markdown, title, personalSpace } = options
  const model = docModel(markdown, title, linkResolver(space, path, window.location.origin))
  const brand = await brandLook()
  const [display, ui, images, tasks] = await Promise.all([
    brand.displayFont === brand.uiFont
      ? Promise.resolve<FontFiles>({})
      : fontFiles(brand.displayFont),
    fontFiles(brand.uiFont),
    Promise.all(
      imageSources(model).map(async (src) => [src, await image(space, path, src)] as const),
    ),
    Promise.all(
      taskSources(model).map(async (src) => [src, await taskLines(src, personalSpace)] as const),
    ),
  ])
  return {
    model,
    inputs: {
      brand,
      fonts: { display: brand.displayFont === brand.uiFont ? ui : display, ui },
      images: new Map(images),
      tasks: new Map(tasks),
    },
  }
}
