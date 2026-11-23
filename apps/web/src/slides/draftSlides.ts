// Draft slides (docs/PLAN-slides.md R9): the AI writes a deck from the doc, saved as a new doc
// "<title> slides" beside it. The original is never touched.

import { newDoc, slugify } from '@hotsauce/format'
import { api, request } from '../api/client'
import { dirname } from '../lib/paths'
import { freeDocPath, type TreeStore } from '../state/treeStore'

/** The new doc's text: fresh frontmatter, then the deck (which brings its own title slide). */
export function deckDoc(title: string, deck: string): string {
  const fresh = newDoc(title).text
  return fresh.replace(/\n# [^\n]*\n\n$/, () => `\n${deck.replace(/^\s+/, '')}`)
}

export async function draftSlides(opts: {
  space: string
  path: string
  title: string
  markdown: string
  tree: TreeStore
}): Promise<string> {
  const { markdown: deck } = await request<{ markdown: string }>('/api/slides/draft', {
    method: 'POST',
    json: { title: opts.title, markdown: opts.markdown },
  })
  const title = `${opts.title} slides`
  const content = deckDoc(title, deck)
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = await freeDocPath(opts.tree, opts.space, dirname(opts.path), slugify(title), {
      fresh: true,
    })
    try {
      await api.putFile(opts.space, { path, content, createOnly: true })
    } catch (err) {
      // Taken meanwhile by a teammate's new doc: pick the next free name.
      if ((err as { status?: number }).status === 409) continue
      throw err
    }
    opts.tree.refreshPaths(opts.space, [path])
    return path
  }
  throw new Error('Couldn’t find a free name for the slides')
}
