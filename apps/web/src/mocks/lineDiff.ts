// Unified diff for the mock server's /diff route. Plain LCS over the lines between the common
// prefix and suffix: quadratic, which is fine for mock-sized edits.

type Op = { type: ' ' | '-' | '+'; line: string }

function diffOps(a: string[], b: string[]): Op[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const n = midA.length
  const m = midB.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] =
        midA[i] === midB[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const ops: Op[] = a.slice(0, prefix).map((line) => ({ type: ' ', line }))
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      ops.push({ type: ' ', line: midA[i] ?? '' })
      i++
      j++
    } else if (j < m && (i === n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      ops.push({ type: '+', line: midB[j] ?? '' })
      j++
    } else {
      ops.push({ type: '-', line: midA[i] ?? '' })
      i++
    }
  }
  for (const line of a.slice(a.length - suffix)) ops.push({ type: ' ', line })
  return ops
}

const CONTEXT = 3

export function unifiedDiff(before: string, after: string, path: string): string {
  if (before === after) return ''
  const ops = diffOps(before.split('\n'), after.split('\n'))
  const changed = ops.flatMap((op, index) => (op.type === ' ' ? [] : [index]))
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`]

  let k = 0
  while (k < changed.length) {
    const start = Math.max(0, (changed[k] ?? 0) - CONTEXT)
    let end = Math.min(ops.length, (changed[k] ?? 0) + CONTEXT + 1)
    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - CONTEXT <= end) {
      k++
      end = Math.min(ops.length, (changed[k] ?? 0) + CONTEXT + 1)
    }
    k++
    let oldStart = 1
    let newStart = 1
    for (const op of ops.slice(0, start)) {
      if (op.type !== '+') oldStart++
      if (op.type !== '-') newStart++
    }
    const body = ops.slice(start, end)
    const oldCount = body.filter((op) => op.type !== '+').length
    const newCount = body.filter((op) => op.type !== '-').length
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of body) out.push(`${op.type}${op.line}`)
  }
  return `${out.join('\n')}\n`
}
