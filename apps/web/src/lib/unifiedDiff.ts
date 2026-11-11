export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'add'; text: string; newNo: number }
  | { kind: 'del'; text: string; oldNo: number }
  | { kind: 'ctx'; text: string; oldNo: number; newNo: number }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** Parses `git diff` output for one file into display lines; file headers are dropped. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (!inHunk || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ })
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ })
    else if (raw.startsWith(' ') || raw === '') {
      // A bare empty line is the trailing newline of the diff text, not a context line.
      if (raw === '') continue
      lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    } else {
      // `diff --git` of a following file: stop treating lines as hunk content.
      inHunk = false
    }
  }
  return lines
}
