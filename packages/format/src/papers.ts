// Papers in saved links (docs/PLAN-links-pdfs.md R2): which addresses are an arXiv, bioRxiv or
// medRxiv paper, so every address of one paper finds the same link. Everything here is pure.

export const PAPER_SERVERS = ['arxiv', 'biorxiv', 'medrxiv'] as const
export type PaperServer = (typeof PAPER_SERVERS)[number]

export interface PaperRef {
  server: PaperServer
  /** arXiv: `2401.01234` or `hep-th/9901001`; bioRxiv and medRxiv: the DOI, `10.1101/…`. */
  id: string
  /** The version in the address (`v2`), else null. */
  version: number | null
}

const LABELS: Record<PaperServer, string> = {
  arxiv: 'arXiv',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
}

/** "arXiv", "bioRxiv", "medRxiv". */
export function paperServerLabel(server: PaperServer): string {
  return LABELS[server]
}

const ARXIV_ID = String.raw`(\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?/\d{7})`
const ARXIV_PATH = new RegExp(
  String.raw`^/(?:abs|pdf|html|format)/${ARXIV_ID}(?:v(\d+))?(?:\.pdf)?/?$`,
)
const RXIV_PATH =
  /^\/content\/(?:early\/\d{4}\/\d{2}\/\d{2}\/)?(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.\d+|\d{6,}))(?:v(\d+))?(?:\.(?:full|full\.pdf|full-text|abstract|supplementary-material|article-info|article-metrics))?(?:\+html)?\/?$/

/** The paper an address points to, or null when it isn't one Hotsauce knows. */
export function paperOf(raw: string): PaperRef | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const m = ARXIV_PATH.exec(decodeURIComponent(url.pathname))
    if (!m?.[1]) return null
    return { server: 'arxiv', id: m[1], version: m[2] ? Number(m[2]) : null }
  }
  if (host === 'biorxiv.org' || host === 'medrxiv.org') {
    const m = RXIV_PATH.exec(url.pathname)
    if (!m?.[1]) return null
    return {
      server: host === 'biorxiv.org' ? 'biorxiv' : 'medrxiv',
      id: m[1],
      version: m[2] ? Number(m[2]) : null,
    }
  }
  return null
}

/** `arxiv:2401.01234`: the same for every address and version of one paper. */
export function paperKey(ref: Pick<PaperRef, 'server' | 'id'>): string {
  return `${ref.server}:${ref.id}`
}

/** The paper behind a `paper:` frontmatter value, or null when it isn't one. */
export function parsePaperKey(key: string): Pick<PaperRef, 'server' | 'id'> | null {
  const m = /^(arxiv|biorxiv|medrxiv):(\S+)$/.exec(key)
  if (!m?.[1] || !m[2]) return null
  return { server: m[1] as PaperServer, id: m[2] }
}

/** The paper's own page, for "Open original". */
export function paperPageUrl(ref: PaperRef): string {
  const v = ref.version ? `v${ref.version}` : ''
  if (ref.server === 'arxiv') return `https://arxiv.org/abs/${ref.id}${v}`
  return `https://www.${ref.server}.org/content/${ref.id}${v}`
}

/** The paper's PDF; bioRxiv and medRxiv only answer a browser here. */
export function paperPdfUrl(ref: PaperRef): string {
  const v = ref.version ? `v${ref.version}` : ''
  if (ref.server === 'arxiv') return `https://arxiv.org/pdf/${ref.id}${v}`
  return `https://www.${ref.server}.org/content/${ref.id}${v}.full.pdf`
}

/** "Ada Lovelace, Alan Turing and 4 more" (Q: first three names). */
export function authorLine(authors: readonly string[], shown = 3): string {
  const names = authors.map((a) => a.trim()).filter(Boolean)
  if (names.length <= shown) {
    if (names.length <= 1) return names[0] ?? ''
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  }
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
}
