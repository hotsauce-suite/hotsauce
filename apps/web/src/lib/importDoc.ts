// Turning a file from elsewhere (Markdown, Word, a web page or a Google Docs HTML export) into a
// Hearth doc. Conversion runs in the browser; the converters load only when someone imports.

import { relativeLink, slugify } from '@hearth/format'
import { api, HearthApiError } from '../api/client'
import { freeDocPath, type TreeStore } from '../state/treeStore'
import { firstHeading } from './format'

export interface ConvertedDoc {
  /** The doc's markdown. Images it holds point at `imageToken(i)` until they are uploaded. */
  markdown: string
  /** Images found inside the file (Word, data: URLs in HTML), to upload as assets. */
  images: File[]
  /** The slug the file should be saved under, from its first heading or its file name. */
  stem: string
}

/** Stands in for image `i` until the doc has a path to link the uploaded image from. */
export const imageToken = (i: number) => `hearth-import-image-${i}`

export class UnsupportedImport extends Error {}

const nameWithoutExtension = (name: string) => name.replace(/\.[^.]+$/, '') || 'Imported'

export async function convertFile(file: File): Promise<ConvertedDoc> {
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  const name = nameWithoutExtension(file.name)
  let markdown: string
  let images: File[] = []
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
    // Markdown comes in exactly as written (Hearth never reformats markdown it didn't write).
    markdown = await file.text()
  } else if (ext === 'html' || ext === 'htm') {
    ;({ markdown, images } = await htmlToMarkdown(await file.text()))
    markdown = withHeading(markdown, name)
  } else if (ext === 'docx') {
    ;({ markdown, images } = await docxToMarkdown(await file.arrayBuffer()))
    markdown = withHeading(markdown, name)
  } else {
    throw new UnsupportedImport(
      `${file.name} isn’t a file Docs can import. Use Markdown, Word (.docx) or HTML.`,
    )
  }
  const stem = slugify(firstHeading(markdown) ?? name) || 'imported'
  return { markdown, images, stem }
}

/** A converted doc without a top heading gets one from its file name, so it has a title. */
function withHeading(markdown: string, name: string): string {
  const body = markdown.trim()
  return firstHeading(body) === null ? `# ${name}\n\n${body}\n` : `${body}\n`
}

async function docxToMarkdown(data: ArrayBuffer): Promise<{ markdown: string; images: File[] }> {
  const { default: mammoth } = await import('mammoth')
  const images: File[] = []
  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const bytes = await image.readAsArrayBuffer()
        const type = image.contentType || 'image/png'
        const ext = type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
        images.push(new File([bytes], `image-${images.length + 1}.${ext}`, { type }))
        return { src: imageToken(images.length - 1) }
      }),
    },
  )
  const converted = await htmlToMarkdown(html)
  return { markdown: converted.markdown, images }
}

async function htmlToMarkdown(html: string): Promise<{ markdown: string; images: File[] }> {
  const [{ default: TurndownService }, { gfm }] = await Promise.all([
    import('turndown'),
    import('@joplin/turndown-plugin-gfm'),
  ])
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll('script, style, meta, link, title')) el.remove()

  // Pasted-in images (data: URLs) become files to upload, like Word's.
  const images: File[] = []
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    const file = dataUrlFile(src, images.length + 1)
    if (file) {
      img.setAttribute('src', imageToken(images.length))
      images.push(file)
    }
  }

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  })
  turndown.use(gfm)
  // One space after a list marker ("- item", "1. item"), not turndown's padded "-   item".
  turndown.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null
      let prefix = '- '
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1)
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `
      }
      const indent = ' '.repeat(prefix.length)
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n(?!$)/g, `\n${indent}`)
      return `${prefix}${body}${node.nextSibling && !body.endsWith('\n') ? '\n' : ''}`
    },
  })
  // Google Docs writes bold and italic as styled spans, not <b> and <i>.
  turndown.addRule('styledBold', {
    filter: (node) => node.nodeName === 'SPAN' && /font-weight:\s*(700|bold)/.test(styleOf(node)),
    replacement: (content) => (content.trim() ? `**${content}**` : content),
  })
  turndown.addRule('styledItalic', {
    filter: (node) => node.nodeName === 'SPAN' && /font-style:\s*italic/.test(styleOf(node)),
    replacement: (content) => (content.trim() ? `*${content}*` : content),
  })
  // Google Docs wraps the whole document in a bold <b id="docs-internal-guid-…">.
  turndown.addRule('docsWrapper', {
    filter: (node) => node.nodeName === 'B' && /^docs-internal-guid/.test(node.id),
    replacement: (content) => content,
  })
  const markdown = turndown
    .turndown(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { markdown, images }
}

const styleOf = (node: HTMLElement) => node.getAttribute('style') ?? ''

function dataUrlFile(src: string, n: number): File | null {
  const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src)
  if (!match?.[1] || !match[2]) return null
  const type = match[1]
  const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
  return new File([bytes], `image-${n}.${ext}`, { type })
}

/** Points each image token at its uploaded asset, linked relative to the doc. */
export function linkImages(markdown: string, links: string[]): string {
  return markdown.replace(
    /hearth-import-image-(\d+)/g,
    (token, i: string) => links[Number(i)] ?? token,
  )
}

export interface ImportResult {
  /** The docs created, in the order the files were given. */
  paths: string[]
  /** One message per file that couldn't be imported. */
  errors: string[]
}

/**
 * Imports each file as a new doc in `dir`, named from its first heading, never over an existing
 * doc. Images inside it are uploaded as assets first. One file failing doesn't stop the others.
 */
export async function importFiles(
  files: File[],
  { space, dir, tree }: { space: string; dir: string; tree: TreeStore },
): Promise<ImportResult> {
  const result: ImportResult = { paths: [], errors: [] }
  for (const file of files) {
    try {
      const doc = await convertFile(file)
      const path = await saveNew(doc, { space, dir, tree, taken: result.paths })
      result.paths.push(path)
    } catch (err) {
      const why = err instanceof Error && err.message ? err.message : 'it couldn’t be read'
      result.errors.push(
        err instanceof UnsupportedImport ? why : `Couldn’t import ${file.name}: ${why}`,
      )
    }
  }
  tree.refreshPaths(space, result.paths)
  return result
}

/** Uploads the doc's images and creates it under a free name, never over an existing file. */
async function saveNew(
  doc: ConvertedDoc,
  { space, dir, tree, taken }: { space: string; dir: string; tree: TreeStore; taken: string[] },
): Promise<string> {
  const uploaded: string[] = []
  for (const image of doc.images) uploaded.push((await api.uploadAsset(space, image)).path)
  // A name can be taken between picking it and saving; the second try reads the folder again.
  for (let attempt = 0; ; attempt++) {
    const path = await freeDocPath(tree, space, dir, doc.stem, { taken, fresh: true })
    const links = uploaded.map((asset) => relativeLink(path, asset))
    try {
      await api.putFile(space, { path, content: linkImages(doc.markdown, links), createOnly: true })
      return path
    } catch (err) {
      if (attempt > 0 || !(err instanceof HearthApiError && err.status === 409)) throw err
    }
  }
}
