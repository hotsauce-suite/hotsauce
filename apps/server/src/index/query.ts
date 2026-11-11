// A quoted phrase (closing quote optional, so typing `"foo` works) or a bare run of non-space.
const TERM = /"([^"]*)"?|(\S+)/g
const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * Turns free text into an FTS5 query that cannot be a syntax error.
 *
 * Every term becomes a double-quoted FTS5 string, which disables all operators (AND, OR, NOT,
 * NEAR, column filters, `^`, `*`, parentheses). Bare words get a trailing `*` for
 * search-as-you-type; user-quoted phrases match exactly. Terms are ANDed. Returns null when
 * nothing searchable is left.
 */
export function toFtsQuery(input: string): string | null {
  const terms: string[] = []
  for (const match of input.matchAll(TERM)) {
    const phrase = match[1]
    const word = match[2]
    if (phrase !== undefined && WORD_CHAR.test(phrase)) terms.push(quote(phrase))
    else if (word !== undefined && WORD_CHAR.test(word)) terms.push(`${quote(word)}*`)
  }
  return terms.length > 0 ? terms.join(' ') : null
}

const WORD = /[\p{L}\p{N}]+/gu
// Question words and fillers, which would otherwise rank every transcript line.
const STOP_WORDS = new Set(
  (
    'a about after all also an and any are as at be been but by can could did do does for from ' +
    'had has have he her him his how i if in into is it its me my no not of on or our she so ' +
    'than that the their them then there these they this to us was we were what when where ' +
    'which who whom why will with would you your'
  ).split(' '),
)

/**
 * Turns a natural-language question into an FTS5 query matching any of its words, so bm25 ranks
 * rather than filters. Stop words are dropped unless nothing else is left; every word is quoted
 * (no operators) and matched as a prefix. Null when there are no words.
 */
export function toFtsAnyQuery(input: string): string | null {
  const words = [...new Set(Array.from(input.matchAll(WORD), (m) => m[0].toLowerCase()))]
  const kept = words.filter((w) => !STOP_WORDS.has(w))
  const terms = kept.length > 0 ? kept : words
  return terms.length > 0 ? terms.map((w) => `${quote(w)}*`).join(' OR ') : null
}

function quote(s: string): string {
  return `"${s.replaceAll('"', '""')}"`
}
