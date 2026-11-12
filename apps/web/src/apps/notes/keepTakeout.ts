// Reads a Google Takeout export in the browser (ARCHITECTURE §14.5): the notes are the
// `Takeout/Keep/*.json` files inside the .zip. Only those entries are read (Blob.slice), so a
// multi-gigabyte export with photos costs no more than its notes. Zip64 is handled.

import { KeepNote } from '@hearth/format'

export interface KeepFile {
  /** The file's name inside the Keep folder, e.g. `Groceries.json`: the note's import ref. */
  ref: string
  note: KeepNote
}

const EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX32 = 0xffffffff

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

function u64(v: DataView, at: number): number {
  return Number(v.getBigUint64(at, true))
}

/** A Keep note's file inside the zip: `.../Keep/<name>.json`, not in a subfolder. */
export function keepRefOf(path: string): string | null {
  const m = /(?:^|\/)Keep\/([^/]+\.json)$/i.exec(path)
  return m?.[1] ?? null
}

interface Entry {
  name: string
  method: number
  compressed: number
  offset: number
}

async function centralDirectory(zip: Blob): Promise<Entry[]> {
  const tailStart = Math.max(0, zip.size - 65_557)
  const tail = await bytes(zip, tailStart, zip.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('That file isn’t a .zip')
  let count = tail.getUint16(eocd + 10, true)
  let size = tail.getUint32(eocd + 12, true)
  let offset = tail.getUint32(eocd + 16, true)
  if (count === 0xffff || size === MAX32 || offset === MAX32) {
    const loc = eocd - 20
    if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR) throw new Error('Unreadable .zip')
    const at = u64(tail, loc + 8)
    const z64 = await bytes(zip, at, at + 56)
    if (z64.getUint32(0, true) !== ZIP64_EOCD) throw new Error('Unreadable .zip')
    count = u64(z64, 32)
    size = u64(z64, 40)
    offset = u64(z64, 48)
  }
  const cd = await bytes(zip, offset, offset + size)
  const decoder = new TextDecoder()
  const entries: Entry[] = []
  let p = 0
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== CENTRAL) break
    const method = cd.getUint16(p + 10, true)
    let compressed = cd.getUint32(p + 20, true)
    const uncompressed = cd.getUint32(p + 24, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    let local = cd.getUint32(p + 42, true)
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))
    // Zip64: the 32-bit fields that overflowed are in extra field 0x0001, in this order.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true)
      const len = cd.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (uncompressed === MAX32) q += 8
        if (compressed === MAX32) {
          compressed = u64(cd, q)
          q += 8
        }
        if (local === MAX32) local = u64(cd, q)
      }
      e += 4 + len
    }
    entries.push({ name, method, compressed, offset: local })
    p = extraEnd + commentLen
  }
  return entries
}

async function inflate(data: ArrayBuffer): Promise<ArrayBuffer> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(data))
      controller.close()
    },
  })
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).arrayBuffer()
}

async function readEntry(zip: Blob, entry: Entry): Promise<string> {
  const head = await bytes(zip, entry.offset, entry.offset + 30)
  if (head.getUint32(0, true) !== LOCAL) throw new Error('Unreadable .zip')
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true)
  const raw = await zip.slice(start, start + entry.compressed).arrayBuffer()
  const data = entry.method === 0 ? raw : entry.method === 8 ? await inflate(raw) : null
  if (!data) throw new Error(`Unsupported compression in ${entry.name}`)
  return new TextDecoder().decode(data)
}

/** The files in a zip whose names `match`, as `{ name, text }`; only those entries are read. */
export async function readZipFiles(
  zip: Blob,
  match: (name: string) => boolean,
): Promise<Array<{ name: string; text: string }>> {
  const entries = (await centralDirectory(zip)).filter((e) => match(e.name))
  const out: Array<{ name: string; text: string }> = []
  for (const entry of entries) out.push({ name: entry.name, text: await readEntry(zip, entry) })
  return out
}

/** The Keep note JSON files in a Takeout zip, as `{ name, text }`. */
export function readKeepZip(zip: Blob): Promise<Array<{ name: string; text: string }>> {
  return readZipFiles(zip, (name) => keepRefOf(name) !== null)
}

/** Parses Keep note files; anything that isn't a Keep note's JSON is skipped. */
export function parseKeepFiles(files: Array<{ name: string; text: string }>): KeepFile[] {
  const out: KeepFile[] = []
  for (const f of files) {
    const ref = keepRefOf(f.name) ?? (/\.json$/i.test(f.name) ? f.name.split('/').pop() : null)
    if (!ref) continue
    try {
      const parsed = KeepNote.safeParse(JSON.parse(f.text))
      if (parsed.success && looksLikeKeep(parsed.data)) out.push({ ref, note: parsed.data })
    } catch {
      // Not JSON: skip it.
    }
  }
  return out
}

function looksLikeKeep(n: KeepNote): boolean {
  return (
    n.textContent !== undefined ||
    n.listContent !== undefined ||
    n.userEditedTimestampUsec !== undefined ||
    n.createdTimestampUsec !== undefined
  )
}

/** Everything the member picked (zips and loose .json files) as Keep notes. */
export async function readKeepExport(files: readonly File[]): Promise<KeepFile[]> {
  const loose: Array<{ name: string; text: string }> = []
  for (const file of files) {
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      loose.push(...(await readKeepZip(file)))
    } else if (/\.json$/i.test(file.name)) {
      loose.push({ name: file.webkitRelativePath || file.name, text: await file.text() })
    }
  }
  return parseKeepFiles(loose)
}
