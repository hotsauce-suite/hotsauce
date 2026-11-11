/**
 * The enhanced note: `frontmatterText` (the note's frontmatter block, through its closing `---`
 * line, untouched) followed by the model's markdown, plus which body lines the model wrote.
 *
 * A body line is the member's own when, trimmed, it equals a non-empty trimmed line of their raw
 * notes; every other line, blank ones included, is AI. `aiRanges` are 1-based inclusive line
 * ranges of AI lines, counted in the body (line 1 is the first line after the frontmatter). The
 * body takes the frontmatter's line endings, so a CRLF note stays CRLF.
 */
export function assembleEnhancedNote(input: {
  frontmatterText: string
  rawNotes: string
  modelMarkdown: string
}): { text: string; aiRanges: Array<[number, number]> } {
  const eol = input.frontmatterText.includes('\r\n') ? '\r\n' : '\n'
  const own = new Set(
    input.rawNotes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  )
  const lines = input.modelMarkdown.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')

  const aiRanges: Array<[number, number]> = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed !== '' && own.has(trimmed)) return
    const n = i + 1
    const last = aiRanges.at(-1)
    if (last && last[1] === n - 1) last[1] = n
    else aiRanges.push([n, n])
  })

  return { text: `${input.frontmatterText}${lines.join(eol)}${eol}`, aiRanges }
}
