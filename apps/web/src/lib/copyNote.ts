// "Copy as markdown" and "Copy as rich text" for a doc or meeting note. Frontmatter is Hearth's
// bookkeeping, not part of what someone pastes into an email or Slack, so both leave it out.

import { parseFrontmatter } from '@hearth/format'

export function markdownForCopy(text: string): string {
  return parseFrontmatter(text).body.replace(/^(\r?\n)+/, '')
}

// Pasted HTML keeps no stylesheet, so the few styles that matter are written inline.
const CELL_STYLE = { border: '1px solid #c9bfb2', padding: '4px 8px', verticalAlign: 'top' }

/**
 * The note as HTML for pasting into email, Docs or Slack: GitHub-flavoured markdown as the
 * reading view renders it, minus what doesn't survive a paste. Callouts become quotes with a bold
 * title, task boxes become ☐ and ☑, and tables get borders.
 */
export async function htmlForCopy(text: string): Promise<string> {
  // Loaded on first use: most sessions never copy as rich text.
  const [
    { createElement },
    { renderToStaticMarkup },
    { default: Markdown },
    { default: remarkGfm },
    { remarkCallouts },
  ] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('react-markdown'),
    import('remark-gfm'),
    import('./remarkCallouts'),
  ])
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      {
        remarkPlugins: [remarkGfm, [remarkCallouts, { asQuote: true }]],
        components: {
          input: ({ checked }) => createElement('span', null, checked ? '☑' : '☐'),
          table: ({ children }) =>
            createElement('table', { style: { borderCollapse: 'collapse' } }, children),
          th: ({ children, style }) =>
            createElement('th', { style: { ...style, ...CELL_STYLE } }, children),
          td: ({ children, style }) =>
            createElement('td', { style: { ...style, ...CELL_STYLE } }, children),
        },
      },
      markdownForCopy(text),
    ),
  )
  // React hoists a preload hint for each image; it means nothing in a paste.
  return html.replace(/<link rel="preload"[^>]*>/g, '')
}

export async function copyAsMarkdown(text: string): Promise<void> {
  await navigator.clipboard.writeText(markdownForCopy(text))
}

/** Both flavours on the clipboard, so a plain-text field still gets the markdown. */
export async function copyAsRichText(text: string): Promise<void> {
  const markdown = markdownForCopy(text)
  if (typeof ClipboardItem === 'undefined') {
    await navigator.clipboard.writeText(markdown)
    return
  }
  // Safari allows a clipboard write only while the click is still being handled, so the item goes
  // on at once and the HTML, which takes a moment to render, follows as a promise.
  const html = htmlForCopy(text).then((h) => new Blob([h], { type: 'text/html' }))
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': html,
      'text/plain': new Blob([markdown], { type: 'text/plain' }),
    }),
  ])
}
