// "Copy as markdown" and "Copy as rich text" for a doc or meeting note. Frontmatter is Hearth's
// bookkeeping, not part of what someone pastes into an email or Slack, so both leave it out.

import { parseFrontmatter } from '@hearth/format'

export function markdownForCopy(text: string): string {
  return parseFrontmatter(text).body.replace(/^(\r?\n)+/, '')
}

/** The note as HTML, as the reading view renders it (GitHub-flavoured markdown, no highlighting). */
export async function htmlForCopy(text: string): Promise<string> {
  // Loaded on first use: most sessions never copy as rich text.
  const [
    { createElement },
    { renderToStaticMarkup },
    { default: Markdown },
    { default: remarkGfm },
  ] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('react-markdown'),
    import('remark-gfm'),
  ])
  return renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdownForCopy(text)),
  )
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
